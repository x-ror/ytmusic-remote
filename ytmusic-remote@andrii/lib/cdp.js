// The DevTools protocol, spoken over tools/cdp-bridge's private Unix socket
// (one JSON message per line). The bridge's connection is browser-level, so
// page commands run in a session: Target.getTargets finds the YouTube Music
// page, Target.attachToTarget (flatten) gives a sessionId, and every page
// command carries it. A page reload keeps the session; a replaced page ends
// it (Target.detachedFromTarget) and the next command attaches again.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {SOURCE, LENGTH} from './page.js';

Gio._promisify(Gio.SocketClient.prototype, 'connect_async');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async');

const TIMEOUT_MS = 20000;
export const BINDING = '__ytmrPush';

export class CdpError extends Error {}

export class Cdp {
    constructor(socketPath, {onEvent, onClose}) {
        this._path = socketPath;
        this._onEvent = onEvent;
        this._onClose = onClose;
        this._conn = null;
        this._connecting = null;
        this._cancel = null;
        this._nextId = 0;
        this._pending = new Map();   // id -> {resolve, reject, timer}
        this._writes = Promise.resolve();
        this._session = '';
        this._attaching = null;
        this._encoder = new TextEncoder();
        this._decoder = new TextDecoder();
        this._destroyed = false;
        this._delays = new Set();
    }

    // For good: nothing reconnects afterwards (work still in flight when the
    // extension is disabled, or the screen locks, just fails).
    destroy() {
        this._destroyed = true;
        for (const id of this._delays)
            GLib.source_remove(id);
        this._delays.clear();
        this.close();
    }

    _delay(ms) {
        return new Promise(resolve => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._delays.delete(id);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            this._delays.add(id);
        });
    }

    get connected() {
        return this._conn !== null;
    }

    socketExists() {
        return GLib.file_test(this._path, GLib.FileTest.EXISTS);
    }

    async connect() {
        if (this._destroyed)
            throw new CdpError('Stopped.');
        if (this._conn)
            return;
        if (this._connecting)
            return this._connecting;
        this._connecting = (async () => {
            const client = new Gio.SocketClient();
            this._cancel = new Gio.Cancellable();
            const cancel = this._cancel;
            const conn = await client.connect_async(
                Gio.UnixSocketAddress.new(this._path), cancel);
            if (this._destroyed || cancel.is_cancelled()) {
                conn.close(null);
                throw new CdpError('Stopped.');
            }
            this._conn = conn;
            this._in = new Gio.DataInputStream({
                base_stream: conn.get_input_stream(),
                close_base_stream: false,
            });
            this._out = conn.get_output_stream();
            this._writes = Promise.resolve();
            this._readLoop(cancel);
        })();
        try {
            await this._connecting;
        } finally {
            this._connecting = null;
        }
    }

    async _readLoop(cancel) {
        try {
            for (;;) {
                const [bytes] = await this._in.read_line_async(GLib.PRIORITY_DEFAULT, cancel);
                if (bytes === null)
                    break;
                let msg;
                try {
                    msg = JSON.parse(this._decoder.decode(bytes));
                } catch {
                    continue;
                }
                this._receive(msg);
            }
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`ytmusic-remote: socket read ended: ${e.message}`);
        }
        if (!cancel.is_cancelled())
            this._closed('The YouTube Music app closed.');
    }

    _receive(msg) {
        if (msg.id === undefined) {
            if (msg.method === 'Target.detachedFromTarget' &&
                msg.params?.sessionId === this._session)
                this._session = '';
            this._onEvent?.(msg);
            return;
        }
        const p = this._pending.get(msg.id);
        if (!p)
            return;
        this._pending.delete(msg.id);
        GLib.source_remove(p.timer);
        if (msg.error)
            p.reject(new CdpError(msg.error.message || 'The page did not answer.'));
        else
            p.resolve(msg.result ?? {});
    }

    _closed(why) {
        const had = this._conn !== null;
        this._teardown();
        for (const [, p] of this._pending) {
            GLib.source_remove(p.timer);
            p.reject(new CdpError(why));
        }
        this._pending.clear();
        if (had)
            this._onClose?.();
    }

    _teardown() {
        this._cancel?.cancel();
        this._cancel = null;
        try {
            this._conn?.close(null);
        } catch {}
        this._conn = null;
        this._in = null;
        this._out = null;
        this._session = '';
        this._attaching = null;
    }

    // Leave the page session cleanly so the app does not keep one (and one
    // more binding push per event) for every connection that ever attached.
    close() {
        if (this._session && this._conn) {
            try {
                this._out.write_all(this._encoder.encode(`${JSON.stringify(
                    {id: ++this._nextId, method: 'Target.detachFromTarget', params: {sessionId: this._session}})}\n`), null);
            } catch {}
        }
        this._closed('Closed.');
    }

    _write(obj) {
        const data = this._encoder.encode(`${JSON.stringify(obj)}\n`);
        const out = this._out, conn = this._conn;
        if (!out) {
            const p = this._pending.get(obj.id);
            if (p) {
                this._pending.delete(obj.id);
                GLib.source_remove(p.timer);
                p.reject(new CdpError('The YouTube Music app closed.'));
            }
            return;
        }
        // Writes are chained so two commands never interleave on the socket.
        this._writes = this._writes.then(async () => {
            let off = 0;
            while (off < data.length) {
                // eslint-disable-next-line no-await-in-loop
                const n = await out.write_bytes_async(new GLib.Bytes(data.subarray(off)),
                    GLib.PRIORITY_DEFAULT, null);
                if (n <= 0)
                    throw new Error('short write');
                off += n;
            }
        }).catch(e => {
            // Only the connection this write belonged to is closed.
            if (this._conn === conn)
                this._closed(`Could not write to the app: ${e.message}`);
        });
    }

    // A browser-level command, or a page command when sessionId is given.
    async command(method, params = {}, sessionId = '') {
        await this.connect();
        const id = ++this._nextId;
        const msg = {id, method, params};
        if (sessionId)
            msg.sessionId = sessionId;
        return new Promise((resolve, reject) => {
            const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TIMEOUT_MS, () => {
                this._pending.delete(id);
                reject(new CdpError('YouTube Music did not answer.'));
                return GLib.SOURCE_REMOVE;
            });
            this._pending.set(id, {resolve, reject, timer});
            this._write(msg);
        });
    }

    // Find the YouTube Music page and attach to it (once at a time).
    async session() {
        if (this._session)
            return this._session;
        if (!this._attaching) {
            this._attaching = (async () => {
                const {targetInfos = []} = await this.command('Target.getTargets');
                let target = null, offline = null;
                for (const t of targetInfos) {
                    if (t.type !== 'page')
                        continue;
                    if (String(t.url).includes('music.youtube.com'))
                        target = t;
                    else if (/\/assets\/error\.html$/.test(String(t.url)))
                        offline = t;
                }
                if (!target && offline)
                    throw new CdpError('YouTube Music could not load. Check the internet connection.');
                if (!target)
                    throw new CdpError('The app is not showing YouTube Music yet.');
                const {sessionId} = await this.command('Target.attachToTarget',
                    {targetId: target.targetId, flatten: true});
                if (!sessionId)
                    throw new CdpError('The YouTube Music page is not reachable.');
                // Page pushes (see the player helper in page.js). A binding
                // added this way survives reloads of the page.
                await this.command('Runtime.addBinding', {name: BINDING}, sessionId);
                this._session = sessionId;
                return sessionId;
            })();
        }
        try {
            return await this._attaching;
        } finally {
            this._attaching = null;
        }
    }

    // The binding can miss the page when it is added while the page is still
    // on its way in (a process swap during the first load drops it), so the
    // page is checked and it is added again when missing.
    async ensureBinding() {
        const has = () => this._evaluate(`typeof window.${BINDING} === "function"`);
        if (await has())
            return true;
        const sessionId = await this.session();
        try {
            await this.command('Runtime.removeBinding', {name: BINDING}, sessionId);
        } catch {}
        await this.command('Runtime.addBinding', {name: BINDING}, sessionId);
        return has();
    }

    get sessionId() {
        return this._session;
    }

    async _evaluate(expression) {
        const sessionId = await this.session();
        const r = await this.command('Runtime.evaluate',
            {expression, awaitPromise: true, returnByValue: true}, sessionId);
        if (r.exceptionDetails) {
            const d = r.exceptionDetails;
            const text = d.exception?.description || d.text || 'error';
            console.warn(`ytmusic-remote: page error: ${String(text).slice(0, 600)}`);
            throw new CdpError('The YouTube Music app had a problem with that.');
        }
        return r.result?.value;
    }

    // Run an expression that uses window.__ytmr, installing the helper first
    // when the page does not have this version of it (a fresh page, a reload,
    // or an updated extension). SOURCE (37 KB) only travels when needed.
    async call(expr, retried = false) {
        try {
            const guard = `(function(){var Y=window.__ytmr;if(!Y||Y.len!==${LENGTH}||!Y.p)return {__ytmrNeed:true};return (${expr});})()`;
            let v = await this._evaluate(guard);
            if (v && v.__ytmrNeed)
                v = await this._evaluate(`window.__ytmrLen=${LENGTH};\n${SOURCE};\n(${expr})`);
            return v;
        } catch (e) {
            // Right after the app starts the page swaps its JS context once
            // more; such a call never ran and is safe to repeat once.
            if (!retried && !this._destroyed && /execution context|Target closed|session/i.test(String(e.message))) {
                const old = this._session;
                this._session = '';
                if (old)
                    this.command('Target.detachFromTarget', {sessionId: old}).catch(() => {});
                await this._delay(500);
                return this.call(expr, true);
            }
            throw e;
        }
    }
}
