// Timed lyrics from LRCLIB (lrclib.net: free, no key), with YouTube Music's
// own plain lyrics as the fallback (window.__ytmr.lyrics in page.js).

const LRCLIB = 'https://lrclib.net/api';

// "Song (Official Video)" and "Song - Remastered 2011" find nothing on LRCLIB.
export function cleanTitle(title) {
    return String(title || '')
        .replace(/\s*[([](official|lyric|lyrics|audio|video|visualizer|music video|hd|4k|explicit)[^)\]]*[)\]]/gi, '')
        .replace(/\s+-\s+(remaster(ed)?|live|mono|stereo)\b.*$/i, '')
        .trim();
}

function firstArtist(artist) {
    return String(artist || '').split(/\s*(?:,|&| x | feat\.?| ft\.?)\s*/i)[0].trim();
}

// "[01:23.45] line" -> [{t: 83.45, text: "line"}], sorted, blanks kept as pauses.
export function parseLrc(lrc) {
    const out = [];
    for (const raw of String(lrc || '').split('\n')) {
        const tags = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
        if (!tags.length)
            continue;
        const text = raw.replace(/\[[^\]]*\]/g, '').trim();
        for (const m of tags)
            out.push({t: Number(m[1]) * 60 + Number(m[2]), text});
    }
    out.sort((a, b) => a.t - b.t);
    return out;
}

export async function findLyrics(net, song) {
    const q = (k, v) => `${k}=${encodeURIComponent(v)}`;
    const title = cleanTitle(song.title);
    const artist = firstArtist(song.artist);
    if (!title)
        return null;
    const params = [q('track_name', title), q('artist_name', artist)];
    if (song.album)
        params.push(q('album_name', song.album));
    if (song.duration > 0)
        params.push(q('duration', Math.round(song.duration)));
    let hit = null;
    try {
        hit = await net.getJson(`${LRCLIB}/get?${params.join('&')}`);
    } catch (e) {
        console.debug(`ytmusic-remote: lrclib get: ${e.message}`);
    }
    if (!hit || (!hit.syncedLyrics && !hit.plainLyrics)) {
        try {
            const list = await net.getJson(`${LRCLIB}/search?${q('track_name', title)}&${q('artist_name', artist)}`);
            // Closest length first; a synced one wins a tie.
            const scored = (list || []).filter(x => x.syncedLyrics || x.plainLyrics).map(x => ({
                x,
                score: (song.duration > 0 ? Math.abs((x.duration || 0) - song.duration) : 0) +
                    (x.syncedLyrics ? 0 : 3),
            })).sort((a, b) => a.score - b.score);
            if (scored.length && (song.duration <= 0 || scored[0].score < 8))
                hit = scored[0].x;
        } catch (e) {
            console.debug(`ytmusic-remote: lrclib search: ${e.message}`);
        }
    }
    if (!hit)
        return null;
    if (hit.instrumental)
        return {lines: [], plain: '', instrumental: true, source: 'LRCLIB'};
    const lines = parseLrc(hit.syncedLyrics);
    return {lines, plain: lines.length ? '' : String(hit.plainLyrics || ''), source: 'LRCLIB'};
}
