// prefs.js — settings dialog (GTK4 + libadwaita)

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import {ExtensionPreferences} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class OpenUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // ---- General -----------------------------------------------------
        const general = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});
        const generalGroup = new Adw.PreferencesGroup({title: 'Polling', description: 'How often usage data is refreshed'});

        const interval = Adw.SpinRow.new_with_range(60, 3600, 30);
        interval.title = 'Refresh interval (seconds)';
        settings.bind('refresh-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(interval);

        const warn = Adw.SpinRow.new_with_range(50, 100, 5);
        warn.title = 'Warning threshold (%)';
        warn.subtitle = 'Panel icon is highlighted at/above this usage';
        settings.bind('warn-threshold', warn, 'value', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(warn);

        const showLabel = new Adw.SwitchRow({title: 'Show percentage in panel'});
        settings.bind('show-label', showLabel, 'active', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(showLabel);
        general.add(generalGroup);

        const provGroup = new Adw.PreferencesGroup({title: 'Providers', description: 'Which plans to track'});
        for (const [key, title, subtitle] of [
            ['show-codex', 'OpenAI Codex (ChatGPT)', 'Reads ~/.codex/auth.json — no key needed'],
            ['show-zai', 'Z.AI GLM Coding Plan', 'Requires a Z.AI API key'],
            ['show-opencode', 'OpenCode (Zen / Go)', 'Reads ~/.local/share/opencode/auth.json'],
        ]) {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            provGroup.add(row);
        }
        general.add(provGroup);
        window.add(general);

        // ---- API keys ------------------------------------------------------
        const keys = new Adw.PreferencesPage({title: 'Credentials', icon_name: 'system-lock-screen-symbolic'});
        const zaiGroup = new Adw.PreferencesGroup({
            title: 'Z.AI',
            description: 'Create a key at https://z.ai — needs the Coding Plan key (sk-…)',
        });
        const zaiKey = new Adw.EntryRow({title: 'API key', show_apply_button: true});
        zaiKey.input_purpose = Gtk.InputPurpose.PASSWORD;
        settings.bind('zai-api-key', zaiKey, 'text', Gio.SettingsBindFlags.DEFAULT);
        zaiGroup.add(zaiKey);

        const regionRow = new Adw.ComboRow({
            title: 'Region',
            model: Gtk.StringList.new(['global (api.z.ai)', 'china (open.bigmodel.cn)']),
        });
        const regionToIdx = () => settings.get_string('zai-region') === 'china' ? 1 : 0;
        regionRow.selected = regionToIdx();
        regionRow.connect('notify::selected', () => {
            settings.set_string('zai-region', regionRow.selected === 1 ? 'china' : 'global');
        });
        zaiGroup.add(regionRow);
        keys.add(zaiGroup);

        const ocGroup = new Adw.PreferencesGroup({
            title: 'OpenCode console (optional)',
            description: 'For OpenCode Go balance/usage: log in at opencode.ai, then DevTools → Application → Cookies → copy the value of the "auth" cookie and paste it here.',
        });
        const ocCookie = new Adw.EntryRow({title: 'Session cookie value', show_apply_button: true});
        ocCookie.input_purpose = Gtk.InputPurpose.PASSWORD;
        settings.bind('opencode-cookie', ocCookie, 'text', Gio.SettingsBindFlags.DEFAULT);
        ocGroup.add(ocCookie);

        const ocCookieName = new Adw.EntryRow({title: 'Cookie name', show_apply_button: true});
        settings.bind('opencode-cookie-name', ocCookieName, 'text', Gio.SettingsBindFlags.DEFAULT);
        ocGroup.add(ocCookieName);
        keys.add(ocGroup);

        const advGroup = new Adw.PreferencesGroup({title: 'Advanced'});
        const baseUrl = new Adw.EntryRow({title: 'ChatGPT backend base URL override', show_apply_button: true});
        baseUrl.subtitle = 'Leave empty for https://chatgpt.com/backend-api';
        settings.bind('chatgpt-base-url', baseUrl, 'text', Gio.SettingsBindFlags.DEFAULT);
        advGroup.add(baseUrl);
        keys.add(advGroup);
        window.add(keys);
    }
}
