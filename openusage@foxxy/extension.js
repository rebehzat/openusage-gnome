// extension.js — OpenUsage: AI plan usage meters in the GNOME top bar
// Providers: OpenAI Codex (ChatGPT), OpenCode Go
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

function makeBar(usedPct, widthPx = 120) {
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
        style_class: 'ou-label',
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
        this._state = {codex: null, opencode: null};
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
        if (s.get_boolean('show-opencode'))
            jobs.push(Providers.fetchOpenCode(this._session).then((r) => ['opencode', r]).catch((e) => ['opencode', {status: 'error', provider: 'opencode', message: e.message}]));

        const results = await Promise.allSettled(jobs);
        const next = {codex: null, opencode: null};
        for (const r of results) {
            if (r.status === 'fulfilled')
                next[r.value[0]] = r.value[1];
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
        for (const k of ['codex', 'opencode']) {
            const st = this._state[k];
            if (this._settings.get_boolean(`show-${k}`) && st?.status === 'ok' && st.maxPct != null) {
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
        if (this._settings.get_boolean('show-codex') && codex?.status === 'ok') {
            const ws = codex.windows ?? [];
            const w = ws.find((x) => x.key === 'secondary') ?? ws.find((x) => (x.label ?? '').includes('d'));
            if (w)
                lefts.push(clamp(100 - w.usedPct));
        }
        const oc = this._state.opencode;
        if (this._settings.get_boolean('show-opencode') && oc?.status === 'ok') {
            // OpenCode Go: monthly remaining
            const monthly = (oc.usage ?? []).find((x) => x.key === 'monthly');
            if (monthly)
                lefts.push(clamp(100 - monthly.pct));
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
        section.addMenuItem(makeSectionHeader('OpenAI Codex (pi)', right));
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

    _buildOpenCode(st) {
        const section = new PopupMenu.PopupMenuSection();
        section.addMenuItem(makeSectionHeader('OpenCode Go (pi)', this._statusRight(st)));
        if (!st || st.status !== 'ok') {
            section.addMenuItem(makeInfoRow(st?.message ?? 'Unavailable'));
            return section;
        }
        for (const w of st.usage ?? [])
            section.addMenuItem(makeRow(w.label, w.pct,
                w.resetAt ? fmtDuration(w.resetAt - Date.now() / 1000) : null));
        if (!st.usage?.length)
            section.addMenuItem(makeInfoRow('No usage windows returned'));
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
