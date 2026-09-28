// gjs -m test-lyrics.js : unit checks for the LRC parser and title cleanup.
import {parseLrc, cleanTitle} from '../ytmusic-remote@andrii/lib/lyrics.js';
const eq = (a, b, what) => {
    const ok = JSON.stringify(a) === JSON.stringify(b);
    print(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `: ${JSON.stringify(a)} != ${JSON.stringify(b)}`}`);
    if (!ok) imports.system.exit(1);
};
eq(parseLrc('[00:01.50] one\n[00:03.00]two\n[ar:x]\n[01:00.00][00:02.00] twice\n[00:04.00]'),
    [{t: 1.5, text: 'one'}, {t: 2, text: 'twice'}, {t: 3, text: 'two'}, {t: 4, text: ''}, {t: 60, text: 'twice'}], 'parseLrc');
eq(cleanTitle('Yellow (Official Video)'), 'Yellow', 'strip official video');
eq(cleanTitle('Song [Lyric Video]'), 'Song', 'strip lyric video');
eq(cleanTitle('Let It Be - Remastered 2009'), 'Let It Be', 'strip remaster');
eq(cleanTitle('Live and Let Die'), 'Live and Let Die', 'keep a title that starts with Live');
