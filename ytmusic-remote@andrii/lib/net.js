// HTTP for cover art and lyrics (Soup 3), plus a small on-disk image cache so
// list rows and the cover load once and then come from ~/.cache.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const MAX_PARALLEL = 6;

export class Net {
    constructor(userAgent) {
        this._session = new Soup.Session({user_agent: userAgent, timeout: 20});
        this._cancel = new Gio.Cancellable();
        this._dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'ytmusic-remote', 'img']);
        GLib.mkdir_with_parents(this._dir, 0o700);
        this._inflight = new Map();   // url -> Promise<Gio.File|null>
        this._queue = [];
        this._waiting = new Set();
        this._running = 0;
    }

    destroy() {
        this._cancel.cancel();
        this._session.abort();
        // Queued downloads never start; their callers get "no image".
        this._queue = [];
        for (const resolve of this._waiting)
            resolve(null);
        this._waiting.clear();
        this._inflight.clear();
    }

    async getBytes(url) {
        const msg = Soup.Message.new('GET', url);
        if (!msg)
            throw new Error(`Bad URL: ${url}`);
        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancel);
        const status = msg.get_status();
        return {status, bytes};
    }

    async getJson(url) {
        const {status, bytes} = await this.getBytes(url);
        if (status === 404)
            return null;
        if (status !== Soup.Status.OK)
            throw new Error(`HTTP ${status}`);
        return JSON.parse(new TextDecoder().decode(bytes.get_data()));
    }

    // A local Gio.File for an image URL, downloaded once.
    image(url) {
        if (!url || !/^https?:\/\//.test(url))
            return Promise.resolve(null);
        const name = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1);
        const path = GLib.build_filenamev([this._dir, name]);
        const file = Gio.File.new_for_path(path);
        if (GLib.file_test(path, GLib.FileTest.EXISTS))
            return Promise.resolve(file);
        let p = this._inflight.get(url);
        if (p)
            return p;
        p = new Promise(resolve => {
            this._waiting.add(resolve);
            this._queue.push(async () => {
                this._waiting.delete(resolve);
                try {
                    const {status, bytes} = await this.getBytes(url);
                    if (status !== Soup.Status.OK || !bytes || bytes.get_size() === 0) {
                        resolve(null);
                        return;
                    }
                    await file.replace_contents_bytes_async(bytes, null, false,
                        Gio.FileCreateFlags.REPLACE_DESTINATION, this._cancel);
                    resolve(file);
                } catch {
                    resolve(null);
                } finally {
                    this._inflight.delete(url);
                }
            });
            this._pump();
        });
        this._inflight.set(url, p);
        return p;
    }

    _pump() {
        while (this._running < MAX_PARALLEL && this._queue.length) {
            const job = this._queue.shift();
            this._running++;
            job().finally(() => {
                this._running--;
                this._pump();
            });
        }
    }

    // Keep the cache from growing forever: drop files older than two weeks.
    prune() {
        try {
            const dir = Gio.File.new_for_path(this._dir);
            const en = dir.enumerate_children('standard::name,time::modified',
                Gio.FileQueryInfoFlags.NONE, null);
            const old = GLib.get_real_time() / 1e6 - 14 * 86400;
            let info;
            while ((info = en.next_file(null))) {
                if (info.get_attribute_uint64('time::modified') < old)
                    dir.get_child(info.get_name()).delete(null);
            }
            en.close(null);
        } catch {}
    }
}
