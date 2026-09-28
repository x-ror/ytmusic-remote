// YouTube Music Remote — a GNOME Shell panel remote for the YouTube Music
// desktop app (pear-desktop): now playing, controls, Up next, Home, Search,
// Library, Queue and timed lyrics, with the app running in the background
// only while it is needed.
//
// A port of nicolasfalesy/omarchy-youtube-music (MIT) from the Omarchy bar
// to GNOME Shell. See README.md.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {AppController} from './lib/app.js';
import {Net} from './lib/net.js';
import {PlayerView} from './lib/view.js';

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'YouTube Music');
        this._ext = ext;
        this._app = ext.app;
        this._settings = ext.getSettings();

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box ytmr-indicator'});
        this._icon = new St.Icon({style_class: 'system-status-icon', gicon: ext.view.icon('ytmr-logo-symbolic')});
        // The title sits in a clipped window no wider than the setting; a
        // longer one scrolls through it while the song plays.
        this._clip = new St.Widget({style_class: 'ytmr-indicator-label', clip_to_allocation: true,
            y_align: Clutter.ActorAlign.CENTER});
        this._label = new St.Label();
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._clip.add_child(this._label);
        this._marquee = '';
        // Measured again once in the panel, with the panel's font.
        this._label.connect('notify::mapped', () => {
            if (this._label.mapped) {
                this._marquee = '';
                this._sync();
            }
        });
        box.add_child(this._icon);
        box.add_child(this._clip);
        this.add_child(box);

        this.menu.actor.add_style_class_name('ytmr-menu');
        // Not a menu entry: clicks inside must not activate (close) the menu,
        // and it must not look insensitive.
        const item = new PopupMenu.PopupBaseMenuItem({activate: false, hover: false, can_focus: false,
            style_class: 'ytmr-menu-item'});
        item.add_child(ext.view.actor);
        this.menu.addMenuItem(item);
        this.menu.connect('open-state-changed', (_m, open) => ext.view.setOpen(open));
        ext.view.onWindowShown = () => this.menu.close();

        this._changedId = this._app.connect('changed', () => this._sync());
        this._settingsId = this._settings.connect('changed', () => this._sync());
        this._sync();
    }

    _sync() {
        const song = this._app.song;
        const show = this._settings.get_boolean('show-title') && !!song?.title;
        this._clip.visible = show;
        if (show)
            this._setTitle(song.artist ? `${song.title} — ${song.artist}` : song.title);
        else
            this._stopMarquee();
        this.opacity = this._app.playing || !song ? 255 : 170;
        this.accessible_name = song?.title ? `YouTube Music: ${song.title}` : 'YouTube Music';
    }

    // Lay the title out again only when something that shows changes: the
    // app pushes state far more often than that.
    _setTitle(text) {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const max = this._settings.get_int('max-label-width') * scale;
        const scroll = this._settings.get_boolean('scroll-title') && this._app.playing;
        const key = `${text}\n${max}\n${scroll}`;
        if (key === this._marquee)
            return;
        this._stopMarquee();
        this._marquee = key;
        this._label.text = text;
        this._label.width = -1;
        const [, full] = this._label.get_preferred_width(-1);
        this._clip.width = Math.min(full, max);
        if (full <= max || !scroll) {
            // Fits, or stands still: a long one ends in "…".
            this._label.width = Math.min(full, max);
            return;
        }
        // Two copies with a gap, scrolled by one copy and put back: the
        // second copy lands exactly where the first began, so it loops.
        const gap = '        ';
        this._label.text = text + gap;
        const [, step] = this._label.get_preferred_width(-1);
        this._label.text = text + gap + text;
        this._scroll(step, scale);
    }

    _scroll(step, scale) {
        const gen = this._marqueeGen;
        this._label.translation_x = 0;
        this._label.ease({
            translation_x: -step,
            delay: 2000,
            duration: Math.round(step / (30 * scale) * 1000),   // 30 px a second
            mode: Clutter.AnimationMode.LINEAR,
            onStopped: finished => {
                if (finished && gen === this._marqueeGen)
                    this._scroll(step, scale);
            },
        });
    }

    _stopMarquee() {
        this._marquee = '';
        this._marqueeGen = (this._marqueeGen ?? 0) + 1;
        this._label.remove_all_transitions();
        this._label.translation_x = 0;
    }

    // Middle click plays or pauses; scrolling changes the volume.
    vfunc_event(event) {
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS && event.get_button() === Clutter.BUTTON_MIDDLE) {
            this._app.playPause().catch(e => console.warn(`ytmusic-remote: ${e.message}`));
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.SCROLL && this._app.running) {
            const dir = event.get_scroll_direction();
            let step = 0;
            if (dir === Clutter.ScrollDirection.UP)
                step = 5;
            else if (dir === Clutter.ScrollDirection.DOWN)
                step = -5;
            if (step) {
                const v = Math.max(0, Math.min(100, (this._app.snap?.volume ?? 50) + step));
                this._app.player('volume', v).catch(() => {});
                return Clutter.EVENT_STOP;
            }
        }
        return super.vfunc_event(event);
    }

    _onDestroy() {
        this._stopMarquee();
        this._app.disconnect(this._changedId);
        this._settings.disconnect(this._settingsId);
        super._onDestroy();
    }
});

export default class YouTubeMusicRemote extends Extension {
    enable() {
        this.net = new Net(`ytmusic-remote/${this.metadata['version-name'] ?? this.metadata.version} (GNOME Shell extension)`);
        this.app = new AppController(this);
        this.view = new PlayerView(this.app, this);
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator,
            this.getSettings().get_int('panel-position'), this.getSettings().get_string('panel-box'));
        this._pruneId = setTimeout(() => this.net?.prune(), 60000);
    }

    disable() {
        clearTimeout(this._pruneId);
        this._indicator?.destroy();
        this._indicator = null;
        this.view = null;
        this.app?.destroy();
        this.app = null;
        this.net?.destroy();
        this.net = null;
    }
}
