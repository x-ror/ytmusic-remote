#!/usr/bin/env python3
"""Regenerate lib/page.js from omarchy-youtube-music's Page.js and the player helper.

    python3 dev/build-page.py [path/to/omarchy/Page.js]
"""
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
src = open(sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, 'omarchy-Page.js')).read()
body = src[src.index('String.raw`') + len('String.raw`'):src.rindex('`')]
body = body.replace('__nicYtmLen', '__ytmrLen').replace('__nicYtm', '__ytmr')
body = body.replace('The widget uses this when LRCLIB has no timed lyrics (2026-09-24).',
                    'The extension uses this when LRCLIB has no lyrics.')
helper = open(os.path.join(here, 'player-helper.js')).read()
full = body.rstrip() + '\n' + helper
assert '`' not in full and '${' not in full, 'SOURCE must not contain a backtick or dollar-brace'
header = '''// Code that runs INSIDE the YouTube Music app page (pear-desktop), sent over
// the DevTools protocol with Runtime.evaluate (see lib/cdp.js).
//
// The first part is Page.js from nicolasfalesy/omarchy-youtube-music (MIT,
// see LICENSE), renamed to window.__ytmr: search, browse, paging, the queue
// by id and YouTube Music's own lyrics, all through the signed-in page's
// ytmusic-app.networkManager.fetch. The second part (the player helper) is
// new for this extension: player state, controls and the push watcher.
//
// It is generated from those two files by dev/build-page.py; edit them there.
// No backticks and no dollar-brace in SOURCE: it is a template string.

export const SOURCE = String.raw`'''
out = header + full + '`;\n\nexport const LENGTH = SOURCE.length;\n'
open(os.path.join(here, '..', 'ytmusic-remote@andrii', 'lib', 'page.js'), 'w').write(out)
print(f'lib/page.js: {len(full)} characters of page code')
