import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const APP_CANDIDATES = [
    '/opt/YouTube Music/youtube-music',
    '/opt/Pear Desktop/pear-desktop',
    '/usr/bin/youtube-music',
    '/usr/bin/pear-desktop',
    '/snap/bin/youtube-music',
];

export default class YouTubeMusicRemotePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(620, 640);

        const page = new Adw.PreferencesPage({title: 'YouTube Music Remote', icon_name: 'audio-x-generic-symbolic'});
        window.add(page);

        // --- The app
        const appGroup = new Adw.PreferencesGroup({
            title: 'The YouTube Music app',
            description: 'The remote drives the pear-desktop app (the YouTube Music desktop app). ' +
                'Install its .deb from github.com/pear-devs/pear-desktop/releases, sign in once in its window, ' +
                'and the remote does the rest.',
        });
        page.add(appGroup);

        const status = new Adw.ActionRow();
        const statusIcon = new Gtk.Image();
        status.add_prefix(statusIcon);
        appGroup.add(status);
        const updateStatus = () => {
            const custom = settings.get_string('app-path').trim().replace(/^~/, GLib.get_home_dir());
            const path = custom || APP_CANDIDATES.find(p => GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE)) ||
                APP_CANDIDATES[0];
            const found = GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE);
            status.title = found ? 'Found the app' : custom ? 'Nothing runnable at that path'
                : 'The app was not found at the usual place';
            status.subtitle = found ? path : 'Install the .deb, or choose the AppImage below.';
            statusIcon.icon_name = found ? 'emblem-ok-symbolic' : 'dialog-warning-symbolic';
        };
        updateStatus();
        settings.connect('changed::app-path', updateStatus);

        const pathRow = new Adw.EntryRow({title: 'App path (empty: find it automatically)'});
        settings.bind('app-path', pathRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        const pick = new Gtk.Button({icon_name: 'document-open-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: 'Choose the app or AppImage'});
        pick.add_css_class('flat');
        pick.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: 'Choose the YouTube Music app'});
            dialog.open(window, null, (d, res) => {
                try {
                    const file = d.open_finish(res);
                    if (file)
                        settings.set_string('app-path', file.get_path());
                } catch {}
            });
        });
        pathRow.add_suffix(pick);
        appGroup.add(pathRow);

        const idleRow = new Adw.SpinRow({
            title: 'Quit the app after a pause of',
            subtitle: 'Minutes paused, with the menu closed and the app window hidden. 0 keeps it running.',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 240, step_increment: 1, page_increment: 5}),
        });
        settings.bind('idle-minutes', idleRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        appGroup.add(idleRow);

        // --- Top bar
        const barGroup = new Adw.PreferencesGroup({title: 'Top bar'});
        page.add(barGroup);

        const showRow = new Adw.SwitchRow({title: 'Show the song title'});
        settings.bind('show-title', showRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        barGroup.add(showRow);

        const scrollRow = new Adw.SwitchRow({title: 'Scroll long titles',
            subtitle: 'A title wider than the limit below scrolls while the song plays.'});
        settings.bind('scroll-title', scrollRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        barGroup.add(scrollRow);

        const widthRow = new Adw.SpinRow({
            title: 'Widest title',
            subtitle: 'In pixels; longer titles scroll, or end in “…” when scrolling is off.',
            adjustment: new Gtk.Adjustment({lower: 60, upper: 600, step_increment: 10, page_increment: 50}),
        });
        settings.bind('max-label-width', widthRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        barGroup.add(widthRow);

        const boxes = ['left', 'center', 'right'];
        const boxRow = new Adw.ComboRow({
            title: 'Position',
            subtitle: 'Takes effect the next time the extension starts.',
            model: Gtk.StringList.new(['Left', 'Center', 'Right']),
            selected: Math.max(0, boxes.indexOf(settings.get_string('panel-box'))),
        });
        boxRow.connect('notify::selected', () => settings.set_string('panel-box', boxes[boxRow.selected]));
        barGroup.add(boxRow);

        // --- Tips
        const tips = new Adw.PreferencesGroup({
            title: 'Tips',
            description: 'Middle-click the remote to play or pause; scroll on it to change the volume. ' +
                'Click the cover to show or hide the app window (sign in there the first time). ' +
                'Start the app from the “YouTube Music” menu entry the installer adds, so the remote can reach it; ' +
                'an app started any other way can’t be controlled until it is restarted.',
        });
        page.add(tips);
    }
}
