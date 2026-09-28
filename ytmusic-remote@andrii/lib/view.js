// The panel's popup: now playing, controls, and the Up next / Home / Search /
// Library / Queue / Lyrics tabs. Everything that needs the app goes through
// AppController (lib/app.js); nothing here talks to the socket directly.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

import {findLyrics} from './lyrics.js';

const TABS = [
    {id: 'next', label: 'Up next'},
    {id: 'home', label: 'Home'},
    {id: 'search', label: 'Search'},
    {id: 'library', label: 'Library'},
    {id: 'queue', label: 'Queue'},
    {id: 'lyrics', label: 'Lyrics'},
];
const LIBRARY = [
    {browseId: 'FEmusic_liked_playlists', label: 'Playlists'},
    {browseId: 'VLLM', label: 'Liked songs'},
    {browseId: 'FEmusic_liked_albums', label: 'Albums'},
    {browseId: 'FEmusic_library_corpus_track_artists', label: 'Artists'},
    {browseId: 'FEmusic_history', label: 'Recent'},
];

export function fmtTime(s) {
    s = Math.max(0, Math.floor(Number(s) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return `${h ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

// St's CSS has no opacity, and alpha colours would break in the light shell
// theme, so secondary text is dimmed on the actor instead.
const DIM = {
    'ytmr-artist': 205, 'ytmr-state': 165, 'ytmr-time': 180, 'ytmr-row-sub': 180, 'ytmr-row-time': 180,
    'ytmr-section': 190, 'ytmr-message-text': 190, 'ytmr-lyric-source': 130, 'ytmr-foot': 200,
};
const LYRIC_DIM = 100;

function label(text, style, {wrap = false} = {}) {
    const l = new St.Label({text: text ?? '', style_class: style, y_align: Clutter.ActorAlign.CENTER});
    const dim = DIM[style.split(' ')[0]];
    if (dim)
        l.opacity = dim;
    if (wrap) {
        l.clutter_text.line_wrap = true;
        l.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    } else {
        l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    }
    return l;
}

function setScrollChild(scroll, child) {
    if ('child' in scroll)
        scroll.child = child;
    else
        scroll.add_actor(child);
}

function vadjustment(scroll) {
    return scroll.vadjustment ?? scroll.vscroll.adjustment;
}

export class PlayerView {
    constructor(app, extension) {
        this._app = app;
        this._ext = extension;
        this._net = extension.net;
        this._settings = extension.getSettings();
        this._icons = new Map();
        this._tab = 'next';
        this._stack = [];         // pages opened from lists: {browseId, params, title}
        this._seq = 0;            // bumps on every load, so a late answer never lands in a newer list
        this._more = null;        // the next page of the list on screen
        this._loadingMore = false;
        this._searchQuery = '';
        this._searchParams = '';
        this._libraryPage = LIBRARY[0].browseId;
        this._lyrics = null;      // {videoId, lines, plain, ...}
        this._lyricRows = [];
        this._lyricAt = -1;
        this._queueSig = '';
        this._settingSlider = false;
        this._seeking = false;
        this._tick = 0;
        this._destroyed = false;
        this._sources = new Set();  // one-off timeouts, removed on destroy

        this.actor = new St.BoxLayout({vertical: true, style_class: 'ytmr-panel', x_expand: true});
        this._buildNowPlaying();
        this._buildTabs();
        this._buildList();
        this.actor.connect('destroy', () => this._onDestroy());

        this._appChangedId = app.connect('changed', () => this._sync());
        this._songChangedId = app.connect('song-changed', () => this._onSongChanged());
        this._sync();
    }

    _onDestroy() {
        this._destroyed = true;
        this._stopTick();
        for (const id of this._sources)
            GLib.source_remove(id);
        this._sources.clear();
        if (this._volTimer)
            GLib.source_remove(this._volTimer);
        if (this._footTimer)
            GLib.source_remove(this._footTimer);
        this._volTimer = this._footTimer = 0;
        this._app.disconnect(this._appChangedId);
        this._app.disconnect(this._songChangedId);
    }

    _later(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            if (fn() === GLib.SOURCE_CONTINUE)
                return GLib.SOURCE_CONTINUE;
            this._sources.delete(id);
            return GLib.SOURCE_REMOVE;
        });
        this._sources.add(id);
        return id;
    }

    icon(name) {
        let g = this._icons.get(name);
        if (!g) {
            g = Gio.FileIcon.new(Gio.File.new_for_path(`${this._ext.path}/icons/${name}.svg`));
            this._icons.set(name, g);
        }
        return g;
    }

    _iconButton(iconName, tip, onClick, {size = 16, own = false, style = ''} = {}) {
        const icon = new St.Icon({icon_size: size});
        if (own)
            icon.gicon = this.icon(iconName);
        else
            icon.icon_name = iconName;
        const b = new St.Button({
            child: icon, style_class: `ytmr-icon-button ${style}`, can_focus: true,
            accessible_name: tip, y_align: Clutter.ActorAlign.CENTER,
        });
        b.connect('clicked', () => onClick());
        b._icon = icon;
        return b;
    }

    // Load an image URL into an St.Icon once it is on disk.
    _loadImage(icon, url) {
        icon._url = url;
        if (!url)
            return;
        this._net.image(url).then(file => {
            if (this._destroyed || !file || icon._url !== url || icon._gone)
                return;
            icon.gicon = new Gio.FileIcon({file});
        });
    }

    _thumb(size, style) {
        const icon = new St.Icon({icon_size: size, style_class: style, gicon: this.icon('ytmr-cover-symbolic')});
        icon.connect('destroy', () => {
            icon._gone = true;
        });
        return icon;
    }

    // ------------------------------------------------------------ now playing

    _buildNowPlaying() {
        const now = new St.BoxLayout({style_class: 'ytmr-now'});
        this._cover = this._thumb(84, 'ytmr-cover');
        const coverButton = new St.Button({child: this._cover, style_class: 'ytmr-cover-button', can_focus: true,
            accessible_name: 'Show or hide the YouTube Music window'});
        // Showing the window closes the menu, so the window can be used.
        coverButton.connect('clicked', () => this._app.toggleWindow().then(what => {
            if (what === 'shown')
                this.onWindowShown?.();
        }).catch(e => this._note(e.message)));
        now.add_child(coverButton);

        const info = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ytmr-info'});
        this._title = label('', 'ytmr-title');
        this._artist = label('', 'ytmr-artist');
        this._state = label('', 'ytmr-state');
        info.add_child(this._title);
        info.add_child(this._artist);
        info.add_child(this._state);
        now.add_child(info);
        this.actor.add_child(now);

        // Seek bar.
        this._seek = new Slider.Slider(0);
        this._seek.accessible_name = 'Position';
        this._seek.add_style_class_name('ytmr-seek');
        this._seek.connect('drag-begin', () => {
            this._seeking = true;
        });
        this._seek.connect('drag-end', () => {
            this._seeking = false;
            this._seekTo(this._seek.value);
        });
        this._seek.connect('notify::value', () => {
            if (!this._settingSlider && !this._seeking)
                this._seekTo(this._seek.value);
        });
        this.actor.add_child(this._seek);
        const times = new St.BoxLayout({style_class: 'ytmr-times'});
        this._pos = label('0:00', 'ytmr-time');
        this._dur = label('0:00', 'ytmr-time');
        times.add_child(this._pos);
        times.add_child(new St.Widget({x_expand: true}));
        times.add_child(this._dur);
        this.actor.add_child(times);

        // Controls.
        const ctl = new St.BoxLayout({style_class: 'ytmr-controls', x_align: Clutter.ActorAlign.CENTER});
        const act = (fn, ...args) => this._app.player(fn, ...args).catch(e => this._note(e.message));
        this._shuffle = this._iconButton('media-playlist-shuffle-symbolic', 'Shuffle', () => act('shuffle'));
        this._prev = this._iconButton('media-skip-backward-symbolic', 'Previous', () => act('prev'), {size: 20});
        this._play = this._iconButton('media-playback-start-symbolic', 'Play', () =>
            this._app.playPause().catch(e => this._note(e.message)), {size: 24, style: 'ytmr-play'});
        this._next = this._iconButton('media-skip-forward-symbolic', 'Next', () => act('next'), {size: 20});
        this._repeat = this._iconButton('media-playlist-repeat-symbolic', 'Repeat', () => act('repeat'));
        this._like = this._iconButton('ytmr-like-symbolic', 'Like', () => act('like', 'LIKE'), {own: true});
        this._dislike = this._iconButton('ytmr-dislike-symbolic', 'Dislike', () => act('like', 'DISLIKE'), {own: true});
        for (const b of [this._dislike, this._shuffle, this._prev, this._play, this._next, this._repeat, this._like])
            ctl.add_child(b);
        this.actor.add_child(ctl);

        // Volume.
        const vol = new St.BoxLayout({style_class: 'ytmr-volume'});
        this._mute = this._iconButton('audio-volume-high-symbolic', 'Mute', () => act('mute'));
        vol.add_child(this._mute);
        this._volume = new Slider.Slider(1);
        this._volume.accessible_name = 'Volume';
        this._volume.x_expand = true;
        this._volume.connect('notify::value', () => {
            if (this._settingSlider)
                return;
            const v = Math.round(this._volume.value * 100);
            if (this._volTimer)
                GLib.source_remove(this._volTimer);
            // A drag sends many values; the app gets the last one.
            this._volTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                this._volTimer = 0;
                act('volume', v);
                return GLib.SOURCE_REMOVE;
            });
        });
        vol.add_child(this._volume);
        this.actor.add_child(vol);
    }

    _seekTo(fraction) {
        const s = this._app.snap;
        if (!this._app.running || !s?.duration)
            return;
        this._app.player('seek', Math.round(fraction * s.duration * 10) / 10).catch(e => this._note(e.message));
    }

    _setSlider(slider, value) {
        this._settingSlider = true;
        slider.value = Math.max(0, Math.min(1, value));
        this._settingSlider = false;
    }

    _sync() {
        if (this._destroyed)
            return;
        const app = this._app;
        const song = app.song;
        const live = app.running && !!app.snap?.videoId;
        this._title.text = song?.title || (app.starting ? 'Starting YouTube Music…' : 'YouTube Music');
        this._artist.text = song ? [song.artist, song.album].filter(Boolean).join(' • ') : 'Press play to start';
        const status = app.status || (app.running ? '' : song ? 'Paused — play resumes here' : '');
        this._state.text = status;
        this._state.visible = status !== '';
        if (this._cover._url !== (song?.art || '')) {
            this._cover.gicon = this.icon('ytmr-cover-symbolic');
            this._loadImage(this._cover, song?.art || '');
        }
        this._cover.opacity = live ? 255 : 150;

        const s = app.snap;
        this._play._icon.icon_name = app.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._play.accessible_name = app.playing ? 'Pause' : 'Play';
        for (const b of [this._prev, this._next, this._shuffle, this._repeat, this._like, this._dislike, this._mute]) {
            b.reactive = app.running;
            b.opacity = app.running ? 255 : 110;
        }
        this._seek.reactive = app.running;
        this._volume.reactive = app.running;
        const like = s?.like ?? 'INDIFFERENT';
        this._like._icon.gicon = this.icon(like === 'LIKE' ? 'ytmr-like-on-symbolic' : 'ytmr-like-symbolic');
        this._dislike._icon.gicon = this.icon(like === 'DISLIKE' ? 'ytmr-dislike-on-symbolic' : 'ytmr-dislike-symbolic');
        this._setChecked(this._like, like === 'LIKE');
        this._setChecked(this._dislike, like === 'DISLIKE');
        this._setChecked(this._shuffle, !!s?.shuffle);
        const rep = s?.repeat ?? 'NONE';
        this._repeat._icon.icon_name = rep === 'ONE' ? 'media-playlist-repeat-song-symbolic' : 'media-playlist-repeat-symbolic';
        this._setChecked(this._repeat, rep !== 'NONE');
        this._repeat.accessible_name = {NONE: 'Repeat: off', ALL: 'Repeat: all', ONE: 'Repeat: one'}[rep] ?? 'Repeat';
        this._mute._icon.icon_name = s?.muted || s?.volume === 0 ? 'audio-volume-muted-symbolic'
            : (s?.volume ?? 100) < 34 ? 'audio-volume-low-symbolic'
                : (s?.volume ?? 100) < 67 ? 'audio-volume-medium-symbolic' : 'audio-volume-high-symbolic';
        if (s && typeof s.volume === 'number' && !this._volTimer)
            this._setSlider(this._volume, s.volume / 100);
        this._updateClock();
        if (this._app.menuOpen && app.playing)
            this._startTick();
        else if (!app.playing)
            this._stopTick();
        if (this._tab === 'next' || this._tab === 'queue')
            this._maybeRefreshQueue();
    }

    _setChecked(button, on) {
        if (on)
            button.add_style_pseudo_class('checked');
        else
            button.remove_style_pseudo_class('checked');
    }

    _updateClock() {
        const song = this._app.song;
        const d = this._app.snap?.duration || song?.duration || 0;
        const t = this._app.position();
        this._pos.text = fmtTime(t);
        this._dur.text = fmtTime(d);
        if (!this._seeking)
            this._setSlider(this._seek, d > 0 ? t / d : 0);
        if (this._tab === 'lyrics')
            this._followLyrics(t);
    }

    _startTick() {
        if (this._tick)
            return;
        this._tick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._updateClock();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTick() {
        if (this._tick)
            GLib.source_remove(this._tick);
        this._tick = 0;
    }

    // Called by the indicator when the menu opens or closes.
    setOpen(open) {
        this._app.menuOpen = open;
        if (!open) {
            this._stopTick();
            return;
        }
        this._sync();
        this._reload();
    }

    _onSongChanged() {
        if (this._tab === 'lyrics')
            this._loadLyrics();
        if (this._tab === 'next' || this._tab === 'queue')
            this._reload();
    }

    // ------------------------------------------------------------ tabs

    _buildTabs() {
        const bar = new St.BoxLayout({style_class: 'ytmr-tabs', x_expand: true});
        this._tabButtons = new Map();
        for (const t of TABS) {
            const b = new St.Button({label: t.label, style_class: 'ytmr-tab', can_focus: true, x_expand: true});
            b.connect('clicked', () => this._openTab(t.id));
            bar.add_child(b);
            this._tabButtons.set(t.id, b);
        }
        this.actor.add_child(bar);
        this._markTab();
    }

    _markTab() {
        for (const [id, b] of this._tabButtons)
            this._setChecked(b, id === this._tab);
    }

    _openTab(id) {
        this._tab = id;
        this._stack = [];
        this._markTab();
        this._reload();
        if (id === 'search')
            this._later(0, () => this._entry.grab_key_focus());
    }

    // ------------------------------------------------------------ the list area

    _buildList() {
        const nav = new St.BoxLayout({style_class: 'ytmr-nav'});
        this._back = this._iconButton('go-previous-symbolic', 'Back', () => this._goBack());
        this._navTitle = label('', 'ytmr-nav-title');
        this._navTitle.x_expand = true;
        this._navPlay = this._iconButton('media-playback-start-symbolic', 'Play all', () => this._playHeader());
        nav.add_child(this._back);
        nav.add_child(this._navTitle);
        nav.add_child(this._navPlay);
        this._nav = nav;
        this.actor.add_child(nav);

        this._entry = new St.Entry({style_class: 'ytmr-search', hint_text: 'Search songs, albums, artists…',
            can_focus: true, x_expand: true});
        this._entry.set_primary_icon(new St.Icon({icon_name: 'edit-find-symbolic', style_class: 'popup-menu-icon'}));
        this._entry.clutter_text.connect('activate', () => {
            this._searchQuery = this._entry.text.trim();
            this._searchParams = '';
            this._stack = [];
            this._reload();
        });
        this.actor.add_child(this._entry);

        this._chips = new St.BoxLayout({style_class: 'ytmr-chips'});
        this.actor.add_child(this._chips);

        this._scroll = new St.ScrollView({style_class: 'ytmr-scroll', x_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC});
        this._list = new St.BoxLayout({vertical: true, style_class: 'ytmr-list', x_expand: true});
        setScrollChild(this._scroll, this._list);
        vadjustment(this._scroll).connect('notify::value', () => this._maybeMore());
        this.actor.add_child(this._scroll);

        this._foot = label('', 'ytmr-foot');
        this._foot.visible = false;
        this.actor.add_child(this._foot);
    }

    _note(text) {
        this._foot.text = text || '';
        this._foot.visible = !!text;
        if (this._footTimer)
            GLib.source_remove(this._footTimer);
        this._footTimer = 0;
        if (text) {
            this._footTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 6, () => {
                this._footTimer = 0;
                if (!this._destroyed)
                    this._foot.visible = false;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _clear() {
        this._list.destroy_all_children();
        this._lyricRows = [];
        this._lyricAt = -1;
        this._more = null;
        vadjustment(this._scroll).value = 0;
    }

    _message(text, {button = null, onClick = null} = {}) {
        const box = new St.BoxLayout({vertical: true, style_class: 'ytmr-message', x_expand: true});
        box.add_child(label(text, 'ytmr-message-text', {wrap: true}));
        if (button) {
            const b = new St.Button({label: button, style_class: 'button ytmr-message-button',
                x_align: Clutter.ActorAlign.CENTER, can_focus: true});
            b.connect('clicked', onClick);
            box.add_child(b);
        }
        this._list.add_child(box);
    }

    _header(text) {
        this._list.add_child(label(text, 'ytmr-section'));
    }

    _setChips(chips, active, onPick) {
        this._chips.destroy_all_children();
        this._chips.visible = chips.length > 0;
        for (const c of chips) {
            const b = new St.Button({label: c.label, style_class: 'ytmr-chip', can_focus: true});
            this._setChecked(b, c.value === active);
            b.connect('clicked', () => onPick(c.value));
            this._chips.add_child(b);
        }
    }

    _showNav(title, {play = null} = {}) {
        this._nav.visible = this._stack.length > 0;
        this._back.visible = this._stack.length > 0;
        this._navTitle.text = title || '';
        this._headerPlay = play;
        this._navPlay.visible = !!play;
    }

    _goBack() {
        this._stack.pop();
        this._reload();
    }

    _open(it) {
        this._stack.push({browseId: it.browseId, params: it.params || '', title: it.title});
        this._reload();
    }

    _playHeader() {
        if (this._headerPlay)
            this._app.playEndpoint(this._headerPlay).catch(e => this._note(e.message));
    }

    // Whether the app has to be running for this view; if it is not, say so
    // with a button instead of starting it just because the menu opened.
    _needsApp(seq) {
        if (this._app.running)
            return false;
        if (this._app.starting) {
            this._message('Starting YouTube Music…');
            this._app.ensureRunning().then(() => {
                if (seq === this._seq)
                    this._reload();
            }).catch(() => {
                if (seq === this._seq)
                    this._reload();
            });
            return true;
        }
        if (!this._app.isInstalled()) {
            this._message('The YouTube Music desktop app (pear-desktop) is not installed. ' +
                'Install the .deb from github.com/pear-devs/pear-desktop/releases, or set its path in the settings.',
            {button: 'Settings', onClick: () => this._ext.openPreferences()});
            return true;
        }
        this._message(this._app.status || 'YouTube Music is not running.', {
            button: 'Start YouTube Music',
            onClick: () => {
                this._clear();
                this._message('Starting YouTube Music…');
                this._app.ensureRunning().then(() => this._reload()).catch(e => {
                    this._clear();
                    this._message(e.message);
                });
            },
        });
        return true;
    }

    _reload() {
        const seq = ++this._seq;
        this._clear();
        const top = this._stack[this._stack.length - 1];
        this._entry.visible = this._tab === 'search' && !top;
        this._chips.visible = false;
        this._showNav(top?.title ?? '');
        if (this._tab === 'lyrics' && !top) {
            this._loadLyrics();
            return;
        }
        if (this._needsApp(seq))
            return;
        if (top) {
            this._loadBrowse(seq, top.browseId, top.params);
            return;
        }
        switch (this._tab) {
        case 'next':
            this._loadQueue(seq, true);
            break;
        case 'queue':
            this._loadQueue(seq, false);
            break;
        case 'home':
            this._loadBrowse(seq, 'FEmusic_home', '');
            break;
        case 'library':
            this._setChips(LIBRARY.map(l => ({label: l.label, value: l.browseId})), this._libraryPage, v => {
                this._libraryPage = v;
                this._reload();
            });
            this._loadBrowse(seq, this._libraryPage, '');
            break;
        case 'search':
            this._loadSearch(seq);
            break;
        }
    }

    async _ask(seq, expr) {
        try {
            const v = await this._app.page(expr, {start: false});
            if (seq !== this._seq || this._destroyed)
                return null;
            if (v && v.error) {
                this._clear();
                this._message(v.error);
                return null;
            }
            return v;
        } catch (e) {
            if (seq === this._seq && !this._destroyed) {
                this._clear();
                this._message(e.message);
            }
            return null;
        }
    }

    _loading() {
        this._message('Loading…');
    }

    async _loadBrowse(seq, browseId, params) {
        this._loading();
        const v = await this._ask(seq, `window.__ytmr.browse(${JSON.stringify(browseId)},${JSON.stringify(params)})`);
        if (!v)
            return;
        this._clear();
        const top = this._stack[this._stack.length - 1];
        if (top)
            this._showNav(v.header?.title || top.title, {play: v.header?.play});
        this._renderSections(v.sections || []);
        if (!v.sections?.length)
            this._message('Nothing here yet.');
        // Home pages whole shelves; a playlist pages its one list.
        if (v.cont)
            this._more = {path: '/browse', token: v.cont, sections: true};
        else if (v.sections?.length === 1 && v.sections[0].cont)
            this._more = {path: '/browse', token: v.sections[0].cont, sections: false};
    }

    async _loadSearch(seq) {
        const q = this._searchQuery;
        if (!q) {
            this._message('Type a song, album or artist and press Enter.');
            return;
        }
        this._loading();
        const v = await this._ask(seq, `window.__ytmr.search(${JSON.stringify(q)},${JSON.stringify(this._searchParams)})`);
        if (!v)
            return;
        this._clear();
        const chips = [{label: 'All', value: ''}, ...(v.chips || []).map(c => ({label: c.label, value: c.params}))];
        this._setChips(chips, this._searchParams, p => {
            this._searchParams = p;
            this._reload();
        });
        this._renderSections(v.sections || []);
        if (!v.sections?.length)
            this._message(`No results for “${q}”.`);
        const one = v.sections?.length === 1 ? v.sections[0] : null;
        if (one?.cont)
            this._more = {path: '/search', token: one.cont, sections: false};
    }

    _renderSections(sections) {
        const many = sections.length > 1;
        for (const sec of sections) {
            if (many && sec.title)
                this._header(sec.title);
            for (const it of sec.items)
                this._list.add_child(this._row(it));
            if (sec.more && many) {
                const b = new St.Button({label: 'Show all', style_class: 'ytmr-more', x_align: Clutter.ActorAlign.END,
                    can_focus: true});
                b.connect('clicked', () => this._open({browseId: sec.more.browseId, params: sec.more.params,
                    title: sec.title}));
                this._list.add_child(b);
            }
        }
    }

    _maybeMore() {
        const adj = vadjustment(this._scroll);
        if (!this._more || this._loadingMore)
            return;
        if (adj.value + adj.page_size < adj.upper - 200)
            return;
        const seq = this._seq;
        const more = this._more;
        this._loadingMore = true;
        this._app.page(`window.__ytmr.more(${JSON.stringify(more.path)},${JSON.stringify(more.token)})`, {start: false})
            .then(v => {
                if (seq !== this._seq || this._destroyed || !v || v.error)
                    return;
                if (more.sections)
                    this._renderSections(v.sections || []);
                for (const it of v.items || [])
                    this._list.add_child(this._row(it));
                this._more = v.cont ? {...more, token: v.cont} : null;
            })
            .catch(e => this._note(e.message))
            .finally(() => {
                this._loadingMore = false;
            });
    }

    // ------------------------------------------------------------ rows

    _row(it, {onClick = null, remove = null, current = false, dim = false} = {}) {
        const row = new St.BoxLayout({style_class: 'ytmr-row', x_expand: true});
        const main = new St.Button({style_class: 'ytmr-row-main', x_expand: true, can_focus: true,
            accessible_name: it.title});
        const box = new St.BoxLayout({x_expand: true});
        const round = it.kind === 'artist';
        const thumb = this._thumb(40, round ? 'ytmr-thumb ytmr-thumb-round' : 'ytmr-thumb');
        this._loadImage(thumb, it.thumb);
        box.add_child(thumb);
        const texts = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ytmr-row-texts'});
        texts.add_child(label(it.title, current ? 'ytmr-row-title ytmr-current' : 'ytmr-row-title'));
        if (it.subtitle)
            texts.add_child(label(it.subtitle, 'ytmr-row-sub'));
        box.add_child(texts);
        if (it.duration)
            box.add_child(label(it.duration, 'ytmr-row-time'));
        main.child = box;
        if (dim)
            main.opacity = 150;
        const opens = ['album', 'playlist', 'artist', 'podcast', 'page'].includes(it.kind) && it.browseId;
        main.connect('clicked', () => {
            if (onClick)
                onClick();
            else if (opens)
                this._open(it);
            else if (it.play)
                this._app.playEndpoint(it.play).catch(e => this._note(e.message));
        });
        row.add_child(main);

        if (opens && (it.play || it.kind === 'artist')) {
            row.add_child(this._iconButton('media-playback-start-symbolic', `Play ${it.title}`, () => {
                const run = it.play ? this._app.playEndpoint(it.play)
                    : this._app.page(`window.__ytmr.playPage(${JSON.stringify(it.browseId)},${JSON.stringify(it.params || '')})`);
                run.then(v => v?.error && this._note(v.error)).catch(e => this._note(e.message));
            }, {style: 'ytmr-row-action'}));
        }
        if (it.kind === 'song' && it.videoId) {
            row.add_child(this._iconButton('list-add-symbolic', `Add ${it.title} to the queue`, () => {
                this._app.player('enqueue', it.videoId, 'INSERT_AT_END').then(v => {
                    this._note(v?.error || `Added “${it.title}” to the queue.`);
                }).catch(e => this._note(e.message));
            }, {style: 'ytmr-row-action'}));
        }
        if (remove)
            row.add_child(this._iconButton('window-close-symbolic', `Remove ${it.title}`, remove, {style: 'ytmr-row-action'}));
        return row;
    }

    // ------------------------------------------------------------ queue

    async _loadQueue(seq, upNext) {
        const v = await this._ask(seq, `window.__ytmr.queue(${upNext ? 25 : 0})`);
        if (!v)
            return;
        this._queueSig = v.sig || '';
        this._clear();
        const list = upNext ? v.upNext : v.items;
        if (!list?.length) {
            this._message(upNext ? 'Nothing up next. Play something from Home, Search or Library.'
                : 'The queue is empty.');
            return;
        }
        let autoShown = false;
        for (const it of list) {
            if (it.auto && !autoShown) {
                this._header('Autoplay');
                autoShown = true;
            }
            const act = op => this._app.page(`window.__ytmr.queueAct(${JSON.stringify(op)},${it.queueId},${JSON.stringify(it.videoId)},${it.queueIndex},${!!it.auto})`)
                .then(ok => {
                    if (!ok)
                        this._note('That song is no longer in the queue.');
                    this._reload();
                }).catch(e => this._note(e.message));
            const row = this._row(it, {
                current: it.current,
                dim: it.played,
                onClick: () => act('jump'),
                remove: it.auto || it.current ? null : () => act('remove'),
            });
            this._list.add_child(row);
            if (it.current && !upNext)
                this._scrollTo(row, () => 40, false, () => seq !== this._seq);
        }
    }

    // The app sends nothing when the queue changes, so while a queue view is
    // open, a cheap fingerprint is compared on each state push.
    _maybeRefreshQueue() {
        if (!this._app.menuOpen || !this._app.running || this._stack.length || this._qChecking)
            return;
        this._qChecking = true;
        this._app.page('window.__ytmr.queueSig()', {start: false}).then(sig => {
            if (sig && sig !== this._queueSig && (this._tab === 'next' || this._tab === 'queue'))
                this._reload();
        }).catch(() => {}).finally(() => {
            this._qChecking = false;
        });
    }

    // ------------------------------------------------------------ lyrics

    async _loadLyrics() {
        const seq = this._seq;
        const song = this._app.song;
        this._clear();
        if (!song?.title) {
            this._message('Play a song to see its lyrics.');
            return;
        }
        let lyr = this._lyrics;
        if (!lyr || lyr.videoId !== song.videoId) {
            this._message('Looking for lyrics…');
            lyr = await findLyrics(this._net, song).catch(() => null);
            if (!lyr && this._app.running) {
                try {
                    const own = await this._app.page(`window.__ytmr.lyrics(${JSON.stringify(song.videoId)})`, {start: false});
                    if (own?.text)
                        lyr = {lines: [], plain: own.text,
                            source: String(own.source || 'YouTube Music').replace(/^Source:\s*/i, '')};
                } catch {}
            }
            lyr = {...(lyr || {lines: [], plain: ''}), videoId: song.videoId};
            if (seq !== this._seq || this._destroyed)
                return;
            this._lyrics = lyr;
            this._clear();
        }
        if (lyr.instrumental) {
            this._message('Instrumental');
            return;
        }
        if (lyr.lines.length) {
            for (const line of lyr.lines) {
                const b = new St.Button({style_class: 'ytmr-lyric', can_focus: true, x_expand: true,
                    x_align: Clutter.ActorAlign.FILL});
                const l = label(line.text || '♪', 'ytmr-lyric-text', {wrap: true});
                b.child = l;
                b.opacity = LYRIC_DIM;
                b.connect('enter-event', () => {
                    if (b.opacity < 255)
                        b.opacity = 180;
                });
                b.connect('leave-event', () => {
                    if (b.opacity < 255)
                        b.opacity = LYRIC_DIM;
                });
                b.connect('clicked', () => this._app.player('seek', line.t).catch(e => this._note(e.message)));
                this._list.add_child(b);
                this._lyricRows.push({t: line.t, b});
            }
            this._followLyrics(this._app.position(), true);
        } else if (lyr.plain) {
            this._list.add_child(label(lyr.plain, 'ytmr-lyric-plain', {wrap: true}));
        } else {
            this._message('No lyrics found for this song.');
            return;
        }
        if (lyr.source)
            this._list.add_child(label(`Lyrics: ${lyr.source}`, 'ytmr-lyric-source'));
    }

    // Scroll a row into place once it has been laid out (a fresh list has no
    // positions yet at the first idle).
    _scrollTo(row, offset, animate, stale) {
        let tries = 0;
        return this._later(40, () => {
            if (this._destroyed || stale())
                return GLib.SOURCE_REMOVE;
            if (!row.has_allocation() && tries++ < 25)
                return GLib.SOURCE_CONTINUE;
            const adj = vadjustment(this._scroll);
            const target = Math.max(0, Math.min(adj.upper - adj.page_size, row.y - offset(adj)));
            if (animate && adj.ease)
                adj.ease(target, {duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            else
                adj.value = target;
            return GLib.SOURCE_REMOVE;
        });
    }

    _followLyrics(t, jump = false) {
        const rows = this._lyricRows;
        if (!rows.length)
            return;
        let at = -1;
        for (let i = 0; i < rows.length && rows[i].t <= t + 0.25; i++)
            at = i;
        if (at === this._lyricAt && !jump)
            return;
        if (this._lyricAt >= 0 && rows[this._lyricAt])
            rows[this._lyricAt].b.ease({opacity: LYRIC_DIM, duration: 200});
        this._lyricAt = at;
        if (at < 0)
            return;
        const row = rows[at].b;
        row.ease({opacity: 255, duration: 200});
        // Keep the sung line a third of the way down.
        this._scrollTo(row, adj => adj.page_size / 3, !jump, () => rows !== this._lyricRows);
    }
}
