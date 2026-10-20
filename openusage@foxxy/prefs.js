// OpenUsage preferences — ChatGPT and OpenCode Go.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import {ExtensionPreferences} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class OpenUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});
        const general = new Adw.PreferencesGroup({title: 'Polling',
            description: 'ChatGPT uses the Codex CLI sign-in. OpenCode Go uses the OpenCode CLI sign-in (/connect → OpenCode Go).'});
        const interval = Adw.SpinRow.new_with_range(60, 3600, 30);
        interval.title = 'Refresh interval (seconds)';
        settings.bind('refresh-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);
        general.add(interval);
        const warn = Adw.SpinRow.new_with_range(50, 100, 5);
        warn.title = 'Warning threshold (%)';
        settings.bind('warn-threshold', warn, 'value', Gio.SettingsBindFlags.DEFAULT);
        general.add(warn);
        const showLabel = new Adw.SwitchRow({title: 'Show percentage in panel'});
        settings.bind('show-label', showLabel, 'active', Gio.SettingsBindFlags.DEFAULT);
        general.add(showLabel);
        page.add(general);

        window.add(page);
    }
}
