// extension.js — OpenUsage: AI plan usage meters in the GNOME top bar
// Providers: OpenAI Codex (ChatGPT), Z.AI GLM Coding Plan, OpenCode (Zen/Go)
// Bars show % LEFT; healthy fill uses the system accent color (GNOME 47+).

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Providers from './providers.js';

const REFRESH_MIN_SECS = 60;

const clamp = (v) => Math.max(0, Math.min(100, v || 0));

// color by REMAINING budget: low left = alarming
function colorForLeft(left) {
    if (left <= 10)
        return '#ff7d7d';
    if (left <= 20)
        return '#ffa348';
    if (left <= 40)
        return '#f6d32d';
    return null; // healthy → system accent
}

function fmtDuration(sec) {
    if (sec <= 0)
        return 'resetting…';
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0)
        return `${d}d ${h}h`;
    if (h > 0)
        return `${h}h ${m}m`;
    return `${Math.max(m, 1)}m`;
}

function fmtUsd(v) {
    return v == null ? '—' : `$${v.toFixed(2)}`;
}

function fmtTokens(v) {
    if (v == null)
        return '';
    if (v >= 1e9)
        return `${(v / 1e9).toFixed(1)}B`;
    if (v >= 1e6)
        return `${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3)
        return `${(v / 1e3).toFixed(1)}k`;
    return `${Math.round(v)}`;
}

function makeBar(usedPct, widthPx = 150) {
    const left = clamp(100 - usedPct);
    const color = colorForLeft(left) ?? '-st-accent-color';
    const track = new St.BoxLayout({
        style_class: 'ou-track',
        style: `width:${widthPx}px;height:10px;`,
        y_align: Clutter.ActorAlign.CENTER,
    });
    const w = Math.max(left > 0 ? 4 : 0, Math.round(left / 100 * widthPx));
    track.add_child(new St.Widget({
        style_class: 'ou-fill',
        style: `width:${w}px;background-color:${color};`,
    }));
    return track;
}

function makeRow(labelText, usedPct, resetText) {
    const left = clamp(100 - usedPct);
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
    item.add_child(new St.Label({
        text: labelText,
        y_align: Clutter.ActorAlign.CENTER,
    }));
    item.add_child(makeBar(usedPct));
    const right = new St.BoxLayout({
        style_class: 'ou-right',
        x_align: Clutter.ActorAlign.END,
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    right.add_child(new St.Label({
        text: `${left}% left`,
        style_class: 'ou-pct',
    }));
    if (resetText) {
        right.add_child(new St.Label({
            text: `↻ ${resetText}`,
            style_class: 'ou-reset',
        }));
    }
    item.add_child(right);
    return item;
}

function makeInfoRow(text, bold = false) {
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
    item.add_child(new St.Label({
        text,
        style_class: bold ? 'ou-header' : 'ou-sub',
    }));
    return item;
}

function makeSectionHeader(name, right) {
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
    const box = new St.BoxLayout({x_expand: true});
    box.add_child(new St.Label({
        text: name,
        style_class: 'ou-header',
    }));
    if (right) {
        box.add_child(new St.Label({
            text: right,
            style_class: 'ou-sub',
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
        }));
    }
    item.add_child(box);
    return item;
}

const OpenUsageIndicator = GObject.registerClass(
class OpenUsageIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'OpenUsage', false);
        this._ext = extension;
        this._settings = extension.getSettings();
        this._session = Providers.mkSession(15);
        this._state = {codex: null, zai: null, opencode: null};
        this._updatedAt = 0;
        this._refreshing = false;
        this._timeoutId = 0;
        this._settingsSignals = [];

        const box = new St.BoxLayout({style_class: 'panel-status-menu-item'});
        this._icon = new St.Icon({
            icon_name: 'openusage-symbolic',
            style_class: 'system-status-icon',
        });
        this._label = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this._content = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._content);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const footer = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const fbox = new St.BoxLayout({x_expand: true});
        this._updatedLabel = new St.Label({text: '', style_class: 'ou-sub'});
        fbox.add_child(this._updatedLabel);

        const refreshBtn = new St.Button({
            style_class: 'button',
            can_focus: true,
            child: new St.Icon({icon_name: 'view-refresh-symbolic'}),
        });
        refreshBtn.connect('clicked', () => this._refresh(true));
        fbox.add_child(refreshBtn);
        footer.add_child(fbox);
        this.menu.addMenuItem(footer);

        const settingsItem = new PopupMenu.PopupMenuItem('OpenUsage Settings…');
        settingsItem.connect('activate', () => this._ext.openPreferences());
        this.menu.addMenuItem(settingsItem);

        this.menu.connect('open-state-changed', (menu, open) => {
            if (open && Date.now() / 1000 - this._updatedAt > 30)
                this._refresh();
        });

        this._settingsSignals.push(this._settings.connect('changed::refresh-interval', () => this._armTimer()));
        this._settingsSignals.push(this._settings.connect('changed::show-label', () => this._updatePanelWidgets()));

        this._refresh();
        this._armTimer();
    }

    _armTimer() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        const interval = Math.max(REFRESH_MIN_SECS, this._settings.get_uint('refresh-interval'));
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _refresh(force = false) {
        if (this._refreshing)
            return;
        this._refreshing = true;
        const s = this._settings;
        const jobs = [];
        if (s.get_boolean('show-codex'))
            jobs.push(Providers.fetchCodex(this._session, {baseUrl: s.get_string('chatgpt-base-url')}).then((r) => ['codex', r]).catch((e) => ['codex', {status: 'error', provider: 'codex', message: e.message}]));
        if (s.get_boolean('show-zai'))
            jobs.push(Providers.fetchZai(this._session, {
                apiKey: s.get_string('zai-api-key'),
                region: s.get_string('zai-region'),
            }).then((r) => ['zai', r]).catch((e) => ['zai', {status: 'error', provider: 'zai', message: e.message}]));
        if (s.get_boolean('show-opencode'))
            jobs.push(Providers.fetchOpenCode(this._session, {
                cookie: s.get_string('opencode-cookie'),
                cookieName: s.get_string('opencode-cookie-name'),
            }).then((r) => ['opencode', r]).catch((e) => ['opencode', {status: 'error', provider: 'opencode', message: e.message}]));

        const results = await Promise.allSettled(jobs);
        const next = {codex: null, zai: null, opencode: null};
        for (const r of results) {
            if (r.status === 'fulfilled')
                next[r.value[0]] = r.value[1];
        }
        // keep previous state for providers disabled in settings
        for (const k of ['codex', 'zai', 'opencode']) {
            if (!s.get_boolean(`show-${k}`))
                next[k] = next[k] ?? this._state[k];
        }

        this._state = next;
        this._updatedAt = Date.now() / 1000;
        this._rebuild();
        this._refreshing = false;
    }

    // worst-consumed meter across providers → its remaining %
    _minLeft() {
        let worstUsed = 0;
        let seen = false;
        for (const k of ['codex', 'zai', 'opencode']) {
            const st = this._state[k];
            if (st && st.maxPct != null) {
                worstUsed = Math.max(worstUsed, st.maxPct);
                seen = true;
            }
        }
        return seen ? clamp(100 - worstUsed) : null;
    }

    // weekly-remaining per provider: each subscription's weekly budget window
    _weeklyLefts() {
        const lefts = [];
        const codex = this._state.codex;
        if (codex?.status === 'ok') {
            const ws = codex.windows ?? [];
            const w = ws.find((x) => x.key === 'secondary') ?? ws.find((x) => (x.label ?? '').includes('d'));
            if (w)
                lefts.push(clamp(100 - w.usedPct));
        }
        const zai = this._state.zai;
        if (zai?.status === 'ok') {
            const w = (zai.creditWindows ?? []).find((x) => (x.label ?? '').endsWith('w'));
            if (w && w.pct != null)
                lefts.push(clamp(100 - w.pct));
        }
        const oc = this._state.opencode;
        if (oc?.status === 'ok') {
            const usage = oc.go?.usage ?? [];
            const weekly = usage.find((x) => x.key === 'weekly');
            if (weekly) {
                const weeklyLeft = clamp(100 - weekly.pct);
                // blend the monthly budget in at half weight ONLY when it is
                // meaningfully tighter than weekly (≥20pt gap) — a near-tie
                // (e.g. 91 vs 96) should not drag the average down
                const monthly = usage.find((x) => x.key === 'monthly');
                if (monthly) {
                    const monthlyLeft = clamp(100 - monthly.pct);
                    const gap = weeklyLeft - monthlyLeft;
                    lefts.push(gap >= 20 ? monthlyLeft / 2 : weeklyLeft);
                } else {
                    lefts.push(weeklyLeft);
                }
            }
        }
        return lefts;
    }

    // panel number: average weekly remaining across subs (fallback: worst meter)
    _panelLeft() {
        const lefts = this._weeklyLefts();
        if (lefts.length)
            return lefts.reduce((a, b) => a + b, 0) / lefts.length;
        return this._minLeft();
    }

    _updatePanelWidgets() {
        const minLeft = this._panelLeft();
        const showLabel = this._settings.get_boolean('show-label');
        this._label.visible = showLabel;
        if (minLeft == null) {
            this._label.text = showLabel ? 'OpenUsage' : '';
            this._icon.style = '';
            this._label.style = '';
            return;
        }
        this._label.text = `${Math.round(minLeft)}% left`;
        const warn = this._settings.get_int('warn-threshold');
        const tight = 100 - minLeft >= warn;
        const color = tight ? colorForLeft(minLeft) : null;
        this._icon.style = color ? `color: ${color};` : '';
        this._label.style = color ? `color: ${color}; font-weight: bold;` : '';
    }

    _rebuild() {
        this._content.removeAll();
        const s = this._settings;

        let first = true;
        const add = (section) => {
            if (!first)
                this._content.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            first = false;
            this._content.addMenuItem(section);
        };

        if (s.get_boolean('show-codex'))
            add(this._buildCodex(this._state.codex));
        if (s.get_boolean('show-zai'))
            add(this._buildZai(this._state.zai));
        if (s.get_boolean('show-opencode'))
            add(this._buildOpenCode(this._state.opencode));

        this._updatedLabel.text = this._updatedAt
            ? `Updated ${new Date(this._updatedAt * 1000).toLocaleTimeString()}`
            : '';
        this._updatePanelWidgets();
    }

    _statusRight(st) {
        switch (st?.status) {
        case 'ok':
            return '';
        case 'noauth':
            return 'not signed in';
        case 'auth':
            return 'auth error';
        case 'limited':
            return 'rate limited';
        case 'warn':
            return 'check';
        default:
            return 'error';
        }
    }

    _buildCodex(st) {
        const section = new PopupMenu.PopupMenuSection();
        const right = st && st.status === 'ok' ? (st.plan ?? '') : this._statusRight(st);
        section.addMenuItem(makeSectionHeader('OpenAI Codex (ChatGPT)', right));
        if (!st) {
            section.addMenuItem(makeInfoRow('Disabled'));
            return section;
        }
        if (st.status !== 'ok') {
            section.addMenuItem(makeInfoRow(st.message ?? 'Unavailable'));
            return section;
        }
        for (const w of st.windows)
            section.addMenuItem(makeRow(`${w.label} window`, w.usedPct, w.resetAt ? fmtDuration(w.resetAt - Date.now() / 1000) : null));
        for (const ex of st.extras ?? [])
            for (const w of ex.windows)
                section.addMenuItem(makeRow(`${ex.name} · ${w.label}`, w.usedPct, w.resetAt ? fmtDuration(w.resetAt - Date.now() / 1000) : null));
        if (st.credits && (st.credits.unlimited || st.credits.hasCredits)) {
            const c = st.credits;
            section.addMenuItem(makeInfoRow(
                c.unlimited ? 'Credits: unlimited' : `Credits: ${fmtUsd(c.balance)} available`));
        }
        return section;
    }

    _buildZai(st) {
        const section = new PopupMenu.PopupMenuSection();
        const right = st && st.status === 'ok' && st.planLevel
            ? `GLM ${st.planLevel}`
            : this._statusRight(st);
        section.addMenuItem(makeSectionHeader('Z.AI GLM Coding Plan', right));
        if (!st) {
            section.addMenuItem(makeInfoRow('Disabled'));
            return section;
        }
        if (st.status !== 'ok') {
            section.addMenuItem(makeInfoRow(st.message ?? 'Unavailable'));
            return section;
        }
        for (const w of st.creditWindows ?? []) {
            section.addMenuItem(makeRow(`${w.label} credits`, w.pct ?? 0,
                w.resetAt ? fmtDuration(w.resetAt - Date.now() / 1000) : null));
            if (w.used != null && w.limit != null)
                section.addMenuItem(makeInfoRow(`${fmtTokens(w.used)} / ${fmtTokens(w.limit)} credits used`));
        }
        if (!st.creditWindows?.length && st.fiveHour) {
            const pct = st.fiveHour.pct ?? (st.fiveHour.tokens ? clamp((st.fiveHour.tokens.used / st.fiveHour.tokens.limit) * 100) : 0);
            section.addMenuItem(makeRow('5h tokens', pct,
                st.fiveHour.resetAt ? fmtDuration(st.fiveHour.resetAt - Date.now() / 1000) : null));
        }
        if (st.credits && (st.credits.available != null || st.credits.limit != null)) {
            const c = st.credits;
            section.addMenuItem(makeInfoRow(`Credits: ${fmtUsd(c.available)} available · ${fmtUsd(c.used)} used`));
        }
        return section;
    }

    _buildOpenCode(st) {
        const section = new PopupMenu.PopupMenuSection();
        let right = this._statusRight(st);
        if (st?.billing?.subscriptionPlan)
            right = st.billing.subscriptionPlan;
        section.addMenuItem(makeSectionHeader('OpenCode (Zen / Go)', right));
        if (!st) {
            section.addMenuItem(makeInfoRow('Disabled'));
            return section;
        }
        if (st.status === 'noauth') {
            section.addMenuItem(makeInfoRow(st.message ?? 'Not signed in'));
            return section;
        }

        // usage windows from the Go plan (bars) — no model counts
        const usage = st.go?.usage ?? [];
        if (usage.length)
            section.addMenuItem(makeSectionHeader('OpenCode Go', ''));
        for (const w of usage)
            section.addMenuItem(makeRow(w.label, w.pct ?? 0,
                w.resetAt ? fmtDuration(w.resetAt - Date.now() / 1000) : null));

        // cookie-authed console billing (optional, still supported)
        const b = st.billing;
        if (b && (b.monthlyLimit || b.balance != null)) {
            if (b.monthlyLimit)
                section.addMenuItem(makeRow('Console monthly', clamp((b.monthlyUsage / b.monthlyLimit) * 100)));
            section.addMenuItem(makeInfoRow(
                `Balance ${fmtUsd(b.balance)} · used ${fmtUsd(b.monthlyUsage)}${b.monthlyLimit ? ` / ${fmtUsd(b.monthlyLimit)}` : ''}`));
        }

        // auth status lines (no model counts)
        const lines = [];
        for (const [key, title] of [['zen', 'Zen'], ['go', 'Go']]) {
            const p = st[key];
            if (!p)
                continue;
            if (p.auth === true)
                lines.push(`${title}: connected`);
            else if (p.auth === false)
                lines.push(`${title}: API key rejected (HTTP ${p.httpStatus})`);
            else if (p.limited)
                lines.push(`${title}: rate limited (429)`);
            else
                lines.push(`${title}: unreachable${p.error ? ` (${p.error})` : ''}`);
        }
        if (!usage.length || lines.some((l) => !l.endsWith('connected')))
            for (const l of lines)
                section.addMenuItem(makeInfoRow(l));
        if (st.cookieError)
            section.addMenuItem(makeInfoRow(`Console: ${st.cookieError}`));
        if (st.status === 'auth')
            section.addMenuItem(makeInfoRow('All API keys rejected — re-login `opencode auth login`'));
        return section;
    }

    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        for (const id of this._settingsSignals)
            this._settings.disconnect(id);
        this._settingsSignals = [];
        try {
            this._session.abort();
        } catch {
            /* noop */
        }
        super.destroy();
    }
});

export default class OpenUsageExtension extends Extension {
    enable() {
        this._indicator = new OpenUsageIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
