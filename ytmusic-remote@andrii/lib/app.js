// The YouTube Music app (pear-desktop) as the panel sees it: started through
// tools/cdp-bridge only when it is needed, its window kept out of the way,
// its player state pushed live from the page, the last song remembered so
// play resumes where it stopped, and a clean quit after a while paused.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {Cdp, BINDING} from './cdp.js';

Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');

const APP_CANDIDATES = [
    '/opt/YouTube Music/youtube-music',
    '/opt/Pear Desktop/pear-desktop',
    '/usr/bin/youtube-music',
    '/usr/bin/pear-desktop',
    '/snap/bin/youtube-music',
];
const WINDOW_CLASS = /youtube[-_ ]?music|pear[-_ ]?desktop/i;


export class AppController extends Signals.EventEmitter {
    constructor(extension) {
        super();
        this._ext = extension;
        this._settings = extension.getSettings();
        const rt = GLib.get_user_runtime_dir();
        this._cdp = new Cdp(GLib.build_filenamev([rt, 'ytmusic-remote', 'cdp.sock']), {
            onEvent: m => this._onEvent(m),
            onClose: () => this._onAppGone(),
        });
        this.snap = null;          // last pushed player state (see page.js snap())
        this._snapAt = 0;          // monotonic µs when it arrived
        this.running = false;      // talking to a ready page
        this.starting = false;
        this.status = '';          // one short sentence for the panel, '' when fine
        this.menuOpen = false;
        this._startPromise = null;
        this._hideNextWindow = 0;
        this._pausedSince = 0;
        this._timers = new Set();
        this._windowSignals = new Map();   // Meta.Window -> signal ids
        this._destroyed = false;
        this._stateFile = Gio.File.new_for_path(GLib.build_filenamev(
            [GLib.get_user_state_dir(), 'ytmusic-remote', 'last.json']));
        this.last = null;
        this._lastSaved = '';
        this._loadLast();

        this._windowCreatedId = global.display.connect('window-created',
            (_d, w) => this._onWindowCreated(w));
        this._every(10, () => this._heartbeat());
        this._every(30, () => this._idleCheck());
        // A bridge left running (the app started from its menu entry, or a
        // shell restart) is picked up right away.
        if (this._cdp.socketExists())
            this.ensureRunning({background: false}).catch(() => {});
    }

    destroy() {
        this._destroyed = true;
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers.clear();
        global.display.disconnect(this._windowCreatedId);
        for (const [w, ids] of this._windowSignals)
            ids.forEach(id => w.disconnect(id));
        this._windowSignals.clear();
        this._saveLast(true);
        this._cdp.destroy();
        this.disconnectAll?.();
    }

    // A pause that is cancelled by destroy(): the waiting code then stops.
    _sleep(ms) {
        return new Promise((resolve, reject) => {
            if (this._destroyed) {
                reject(new Error('Stopped.'));
                return;
            }
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._timers.delete(id);
                if (this._destroyed)
                    reject(new Error('Stopped.'));
                else
                    resolve();
                return GLib.SOURCE_REMOVE;
            });
            this._timers.add(id);
        });
    }

    _every(seconds, fn) {
        const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT_IDLE, seconds, () => {
            fn();
            return GLib.SOURCE_CONTINUE;
        });
        this._timers.add(id);
    }

    _setStatus(text) {
        if (this.status === text)
            return;
        this.status = text;
        this.emit('changed');
    }

    // ------------------------------------------------------------ app lifecycle

    appPath() {
        const custom = this._settings.get_string('app-path').trim();
        if (custom)
            return custom.replace(/^~/, GLib.get_home_dir());
        return APP_CANDIDATES.find(p => GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE)) ?? '';
    }

    isInstalled() {
        const p = this.appPath();
        return p !== '' && GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE);
    }

    // Start (or find) the app and wait until its page takes commands.
    // background: keep its window minimized when this call starts it.
    ensureRunning({background = true} = {}) {
        if (this.running)
            return Promise.resolve();
        if (this._startPromise)
            return this._startPromise;
        this._startPromise = this._start(background).finally(() => {
            this._startPromise = null;
            this.starting = false;
            this.emit('changed');
        });
        return this._startPromise;
    }

    async _start(background) {
        this.starting = true;
        this.emit('changed');
        try {
            await this._startSteps(background);
        } catch (e) {
            this.running = false;
            if (!this._destroyed && /^Starting/.test(this.status))
                this._setStatus('YouTube Music did not answer. Try again.');
            throw e;
        }
    }

    async _startSteps(background) {
        if (!this._cdp.socketExists()) {
            if (!this.isInstalled()) {
                this._setStatus('YouTube Music (pear-desktop) is not installed. See the extension settings.');
                throw new Error(this.status);
            }
            this._spawnBridge(background);
            for (let i = 0; i < 100 && !this._cdp.socketExists(); i++)
                // eslint-disable-next-line no-await-in-loop
                await this._sleep(150);
            if (!this._cdp.socketExists()) {
                this._setStatus('YouTube Music did not start.');
                throw new Error(this.status);
            }
        }
        await this._cdp.connect();
        this._setStatus('Starting YouTube Music…');
        // The page takes a few seconds to load and sign in.
        let ready = null;
        for (let i = 0; i < 180; i++) {
            try {
                // eslint-disable-next-line no-await-in-loop
                ready = await this._cdp.call('window.__ytmr.ready()');
            } catch (e) {
                ready = null;
                if (/not installed|closed/i.test(e.message))
                    throw e;
                if (/internet/i.test(e.message))
                    ready = 'offline';
            }
            if (ready === true)
                break;
            if (ready === 'offline') {
                this._setStatus('YouTube Music could not load. Check the internet connection.');
                throw new Error(this.status);
            }
            // eslint-disable-next-line no-await-in-loop
            await this._sleep(500);
        }
        if (ready !== true) {
            this._setStatus('YouTube Music is taking too long to load.');
            throw new Error(this.status);
        }
        await this._cdp.ensureBinding();
        await this._cdp.call('window.__ytmr.p.watch()');
        const s = await this._cdp.call('window.__ytmr.p.snap()');
        this.running = true;
        this._pausedSince = GLib.get_monotonic_time();
        this._takeSnap(s);
        this._setStatus(s && !s.signedIn ? 'Not signed in: right-click YouTube Music in the app menu, "Sign in to Google".' : '');
    }

    _spawnBridge(background) {
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
        const custom = this._settings.get_string('app-path').trim();
        if (custom)
            launcher.setenv('YTMR_APP', custom.replace(/^~/, GLib.get_home_dir()), true);
        const bridge = GLib.build_filenamev([this._ext.path, 'tools', 'cdp-bridge']);
        // --hidden: the app starts with no window, so it stays out of the
        // dock. An app too old for that (or on its very first start) still
        // opens one, which _onWindowCreated minimizes.
        if (background)
            this._hideNextWindow = GLib.get_monotonic_time() + 60 * 1e6;
        const proc = launcher.spawnv(['python3', bridge, ...background ? ['--hidden'] : []]);
        // Reaped when it exits, so it never lingers as a zombie.
        proc.wait_async(null).catch(() => {});
    }

    _onAppGone() {
        const was = this.running;
        this._saveLast(true);     // while it still counts as playing: the position moves on
        this.running = false;
        this._pausedSince = 0;
        if (this.snap)
            this.snap = {...this.snap, playing: false};
        if (was)
            this._setStatus('');
        this.emit('changed');
    }

    async quit() {
        if (!this._cdp.connected)
            return;
        this._saveLast(true);
        try {
            // Never a kill: Chromium crashes on purpose on SIGTERM.
            await this._cdp.command('Browser.close');
        } catch {}
    }

    // ------------------------------------------------------------ page state

    _onEvent(m) {
        if (m.method === 'Runtime.bindingCalled' && m.params?.name === BINDING) {
            try {
                this._takeSnap(JSON.parse(m.params.payload));
            } catch {}
        }
    }

    _takeSnap(s) {
        if (!s || typeof s !== 'object')
            return;
        const prev = this.snap;
        this.snap = s;
        this._snapAt = GLib.get_monotonic_time();
        if (s.signedIn && /sign in/i.test(this.status))
            this._setStatus('');
        if (s.playing)
            this._pausedSince = 0;
        else if (!this._pausedSince)
            this._pausedSince = GLib.get_monotonic_time();
        // The app restores the account's last queue as a cued song on every
        // start; that only counts as the user's song once it really plays.
        // Until then the remembered position is kept, so play resumes there.
        const real = s.playing || (s.t || 0) > 1;
        const same = this.last?.videoId === s.videoId;
        if (s.videoId && s.title && (real || same)) {
            this.last = {
                videoId: s.videoId, playlistId: s.playlistId || '', t: real ? s.t || 0 : this.last.t,
                title: s.title, artist: s.artist, album: s.album, art: s.art, duration: s.duration,
            };
            if (real)
                this._saveLast(!prev || prev.videoId !== s.videoId || prev.playing !== s.playing);
        }
        if (!prev || prev.videoId !== s.videoId || prev.title !== s.title)
            this.emit('song-changed');
        this.emit('changed');
    }

    // The song's position now, moved on from the last push while playing.
    position() {
        const s = this.snap;
        if (!s || !this.running || (!s.playing && (s.t || 0) <= 1 && this.last?.videoId === s.videoId))
            return this.last?.t ?? 0;
        let t = s.t || 0;
        if (s.playing)
            t += (GLib.get_monotonic_time() - this._snapAt) / 1e6;
        return s.duration > 0 ? Math.min(t, s.duration) : t;
    }

    // What the panel shows: the live song, or the remembered one (dimmed).
    get song() {
        if (this.snap?.videoId && this.snap.title)
            return this.snap;
        return this.last;
    }

    get playing() {
        return this.running && !!this.snap?.playing;
    }

    async _heartbeat() {
        if (!this.running || !this._cdp.connected)
            return;
        try {
            // After a page reload: the binding back if it went, and the watcher.
            const ok = await this._cdp.call('[!!window.__ytmrWatch, typeof window.__ytmrPush === "function"]');
            if (ok && !ok[1])
                await this._cdp.ensureBinding();
            if (ok && (!ok[0] || !ok[1]))
                await this._cdp.call('window.__ytmr.p.watch()');
        } catch {}
        if (this.running && this.snap?.playing)
            this._saveLast(false);
    }

    _idleCheck() {
        const minutes = this._settings.get_int('idle-minutes');
        if (minutes <= 0 || !this.running || this.menuOpen || this.snap?.playing || !this._pausedSince)
            return;
        if (this._windowVisible())
            return;
        if ((GLib.get_monotonic_time() - this._pausedSince) / 60e6 >= minutes)
            this.quit();
    }

    // ------------------------------------------------------------ remembered song

    async _loadLast() {
        try {
            const [bytes] = await this._stateFile.load_contents_async(null);
            const v = JSON.parse(new TextDecoder().decode(bytes));
            if (v && v.videoId && !this.last) {
                this.last = v;
                this.emit('changed');
            }
        } catch {}
    }

    _saveLast(force) {
        if (!this.last)
            return;
        if (this.playing)
            this.last.t = this.position();
        const data = {...this.last, t: Math.round(this.last.t * 10) / 10};
        const text = JSON.stringify(data);
        if (!force && Math.abs(data.t - (this._savedT ?? -99)) < 10)
            return;
        if (text === this._lastSaved)
            return;
        this._lastSaved = text;
        this._savedT = data.t;
        try {
            this._stateFile.get_parent().make_directory_with_parents(null);
        } catch {}
        this._stateFile.replace_contents_bytes_async(new GLib.Bytes(new TextEncoder().encode(text)),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null).catch(() => {});
    }

    // ------------------------------------------------------------ commands

    // Run page code (see page.js), starting the app first when needed.
    async page(expr, {start = true} = {}) {
        if (!this.running) {
            if (!start)
                throw new Error('YouTube Music is not running.');
            await this.ensureRunning();
        }
        return this._cdp.call(expr);
    }

    async player(fn, ...args) {
        const r = await this.page(`window.__ytmr.p.${fn}(${args.map(a => JSON.stringify(a)).join(',')})`);
        // A push follows by itself; this makes the button feel instant.
        this._cdp.call('window.__ytmr.p.snap()').then(s => this._takeSnap(s)).catch(() => {});
        return r;
    }

    async playPause() {
        if (this.running)
            return this.player('toggle');
        await this.ensureRunning();
        return this._resume();
    }

    async _resume() {
        const s = await this._cdp.call('window.__ytmr.p.snap()');
        const L = this.last;
        if (!L?.videoId) {
            await this.playEndpoint({watchPlaylistEndpoint: {playlistId: 'LM'}});
            return;
        }
        if (s?.videoId === L.videoId) {
            if (L.t > 3)
                await this._cdp.call(`window.__ytmr.p.seek(${Number(L.t)})`);
            await this._cdp.call('window.__ytmr.p.play()');
            return;
        }
        const we = {videoId: L.videoId};
        if (L.playlistId)
            we.playlistId = L.playlistId;
        await this.playEndpoint({watchEndpoint: we});
        for (let i = 0; i < 30; i++) {
            // eslint-disable-next-line no-await-in-loop
            await this._sleep(400);
            // eslint-disable-next-line no-await-in-loop
            const n = await this._cdp.call('window.__ytmr.p.snap()');
            if (n?.videoId === L.videoId && n.duration > 0) {
                if (L.t > 3 && L.t < n.duration - 5)
                    await this._cdp.call(`window.__ytmr.p.seek(${Number(L.t)})`);
                break;
            }
        }
    }

    playEndpoint(ep) {
        return this.page(`window.__ytmr.play(${JSON.stringify(ep)})`);
    }

    // ------------------------------------------------------------ the app window

    _appWindows() {
        return global.get_window_actors().map(a => a.meta_window).filter(w => {
            const c = `${w.get_wm_class() ?? ''} ${w.get_wm_class_instance() ?? ''} ${w.get_gtk_application_id?.() ?? ''}`;
            return WINDOW_CLASS.test(c);
        });
    }

    _windowVisible() {
        return this._appWindows().some(w => !w.minimized && w.showing_on_its_workspace?.());
    }

    _onWindowCreated(w) {
        if (!this._hideNextWindow || GLib.get_monotonic_time() > this._hideNextWindow)
            return;
        const isApp = () => WINDOW_CLASS.test(`${w.get_wm_class() ?? ''} ${w.get_wm_class_instance() ?? ''}`);
        const hide = () => {
            this._hideNextWindow = 0;
            w.minimize();
        };
        // Minimized before it is first shown, so it never flashes up or takes
        // the focus from the open menu. Its class can arrive a moment later.
        if (isApp()) {
            hide();
            return;
        }
        const ids = [];
        const done = () => {
            ids.splice(0).forEach(id => w.disconnect(id));
            this._windowSignals.delete(w);
        };
        ids.push(w.connect('notify::wm-class', () => {
            if (isApp()) {
                done();
                hide();
            }
        }));
        ids.push(w.connect('shown', () => {
            done();
            if (isApp())
                hide();
        }));
        ids.push(w.connect('unmanaged', done));
        this._windowSignals.set(w, ids);
    }

    // Show the app window (sign in, or just to look), or tuck it away again.
    async toggleWindow() {
        const wins = this._appWindows();
        if (!wins.length) {
            this._hideNextWindow = 0;
            // Running with no window (started hidden): the bridge brings the
            // window up through the running app.
            if (this.running || this._cdp.socketExists())
                this._spawnBridge(false);
            else
                await this.ensureRunning({background: false});
            return 'shown';
        }
        const w = wins[0];
        if (w.minimized || !w.has_focus()) {
            w.activate(global.get_current_time());
            return 'shown';
        }
        w.minimize();
        return 'hidden';
    }
}
