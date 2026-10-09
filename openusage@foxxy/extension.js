// extension.js — OpenUsage: AI plan usage meters in the GNOME top bar
// ChatGPT (Codex CLI), Grok Build (grok CLI), and Grok Bot.
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
        text: `${Math.round(left)}% left`,
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
        this._state = {codex: null, grok: null, grokBot: null};
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
        refreshBtn.connect('clicked', () => this._refresh());
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

    async _refresh() {
        if (this._refreshing)
            return;
        this._refreshing = true;
        const baseUrl = this._settings.get_string('chatgpt-base-url');
        const [codex, grok, grokBot] = await Promise.all([
            Providers.fetchCodex(this._session, {baseUrl}).catch(e => ({status: 'error', message: e.message})),
            Providers.fetchGrokBuild(this._session).catch(e => ({status: 'error', provider: 'grok-build', message: e.message})),
            Providers.fetchGrokBot(this._session).catch(e => ({status: 'error', provider: 'grok-bot', message: e.message})),
        ]);
        this._state = {codex, grok, grokBot};
        this._updatedAt = Date.now() / 1000;
        this._rebuild();
        this._refreshing = false;
    }

    // Average remaining weekly allowance across the providers that reported one.
    _panelLeft() {
        const lefts = [];
        for (const st of [this._state.codex, this._state.grok, this._state.grokBot]) {
            const weekly = st?.status === 'ok' ? st.windows?.[0] : null;
            if (weekly)
                lefts.push(clamp(100 - weekly.usedPct));
        }
        if (!lefts.length)
            return null;
        return lefts.reduce((sum, value) => sum + value, 0) / lefts.length;
    }

    _updatePanelWidgets() {
        const weeklyLeft = this._panelLeft();
        const showLabel = this._settings.get_boolean('show-label');
        this._label.visible = showLabel;
        if (weeklyLeft == null) {
            this._label.text = showLabel ? '—' : '';
            this._icon.style = '';
            this._label.style = '';
            return;
        }
        this._label.text = `${Math.round(weeklyLeft)}% left`;
        const warn = this._settings.get_int('warn-threshold');
        const tight = 100 - weeklyLeft >= warn;
        const color = tight ? colorForLeft(weeklyLeft) : null;
        this._icon.style = color ? `color: ${color};` : '';
        this._label.style = color ? `color: ${color}; font-weight: bold;` : '';
    }

    _rebuild() {
        this._content.removeAll();
        this._content.addMenuItem(this._buildUsage('ChatGPT Weekly', this._state.codex));
        this._content.addMenuItem(this._buildUsage('Grok Build', this._state.grok));
        this._content.addMenuItem(this._buildUsage('Grok Bot', this._state.grokBot));

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

    _buildUsage(title, st) {
        const section = new PopupMenu.PopupMenuSection();
        const right = st && st.status === 'ok' ? (st.plan ?? '') : this._statusRight(st);
        section.addMenuItem(makeSectionHeader(title, right));
        if (!st) {
            section.addMenuItem(makeInfoRow('Disabled'));
            return section;
        }
        if (st.status !== 'ok') {
            section.addMenuItem(makeInfoRow(st.message ?? 'Unavailable'));
            return section;
        }
        for (const w of st.windows)
            section.addMenuItem(makeRow(w.label || 'Weekly', w.usedPct,
                w.resetAt ? fmtDuration(w.resetAt - Date.now() / 1000) : null));
        if (!st.windows.length)
            section.addMenuItem(makeInfoRow(st.message || 'Weekly usage unavailable'));
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
