import json, os, socket, subprocess, sys, time, re
ROOT = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.join(ROOT, '..', 'ytmusic-remote@andrii')
src = open(os.path.join(EXT, 'lib/page.js')).read()
SOURCE = src[src.index('String.raw`') + len('String.raw`'): src.rindex('`;')]
LEN = len(SOURCE)
env = dict(os.environ, YTMR_APP=os.path.join(ROOT, 'mock/mock-app'))
rt = os.environ['XDG_RUNTIME_DIR']
sock_path = os.path.join(rt, 'ytmusic-remote', 'cdp.sock')
p = subprocess.Popen(['python3', os.path.join(EXT, 'tools/cdp-bridge')], env=env)
for _ in range(100):
    if os.path.exists(sock_path): break
    time.sleep(0.1)
s = socket.socket(socket.AF_UNIX); s.connect(sock_path)
f = s.makefile('rwb')
nid = [0]; events = []
def cmd(method, params=None, session=None):
    nid[0] += 1; m = {'id': nid[0], 'method': method, 'params': params or {}}
    if session: m['sessionId'] = session
    f.write((json.dumps(m) + '\n').encode()); f.flush()
    while True:
        r = json.loads(f.readline())
        if r.get('id') == nid[0]: return r
        events.append(r)
time.sleep(2)
t = [x for x in cmd('Target.getTargets')['result']['targetInfos'] if x['type'] == 'page']
print('targets', [x['url'] for x in t])
sid = cmd('Target.attachToTarget', {'targetId': t[0]['targetId'], 'flatten': True})['result']['sessionId']
print(cmd('Runtime.addBinding', {'name': '__ytmrPush'}, sid))
def ev(expr):
    r = cmd('Runtime.evaluate', {'expression': expr, 'awaitPromise': True, 'returnByValue': True}, sid)
    res = r.get('result', {})
    if 'exceptionDetails' in res: return ('EXC', res['exceptionDetails'].get('exception', {}).get('description'))
    return res.get('result', {}).get('value')
guard = lambda e: f"(function(){{var Y=window.__ytmr;if(!Y||Y.len!=={LEN}||!Y.p)return {{__ytmrNeed:true}};return ({e});}})()"
print('guard', ev(guard('1')))
print('install', ev(f"window.__ytmrLen={LEN};\n{SOURCE};\n(window.__ytmr.ready())"))
print('guard2', ev(guard('window.__ytmr.ready()')))
print('snap', ev(guard('window.__ytmr.p.snap()')))
print('watch', ev(guard('window.__ytmr.p.watch()')))
home = ev(guard('window.__ytmr.browse("FEmusic_home","")'))
print('home', [(x['title'], len(x['items']), x['items'][0]['kind']) for x in home['sections']], 'cont', home['cont'])
more = ev(guard('window.__ytmr.more("/browse","home2")'))
print('home more', [(x['title'], len(x['items'])) for x in more['sections']])
pl = ev(guard('window.__ytmr.browse("VLPLfocus","")'))
print('playlist', pl['header']['title'], pl['header']['play'], [(x['title'], len(x['items']), bool(x['cont'])) for x in pl['sections']])
pm = ev(guard(f'window.__ytmr.more("/browse",{json.dumps(pl["sections"][0]["cont"])})'))
print('pl more', len(pm['items']), pm['cont'])
sr = ev(guard('window.__ytmr.search("nova","")'))
print('search', [(x['title'], [i['title'] + ':' + i['kind'] for i in x['items'][:3]]) for x in sr['sections']], [c['label'] for c in sr['chips']])
sf = ev(guard('window.__ytmr.search("nova","songs")'))
print('search songs', [(x['title'], len(x['items']), x['cont']) for x in sf['sections']])
art = ev(guard('window.__ytmr.browse("UCartist1","")'))
print('artist', art['header'], [(x['title'], len(x['items'])) for x in art['sections']])
lib = ev(guard('window.__ytmr.browse("FEmusic_library_corpus_track_artists","")'))
print('lib artists', [(x['title'], [i['kind'] for i in x['items']]) for x in lib['sections']])
print('play', ev(guard('window.__ytmr.play({"watchEndpoint":{"videoId":"vid0007"}})')))
time.sleep(1)
print('snap2', ev(guard('window.__ytmr.p.snap()')))
q = ev(guard('window.__ytmr.queue(5)'))
print('queue', q['current'], [(i['title'], i['queueId'], i['current']) for i in q['items'][:3]], 'upNext', [i['title'] + (' auto' if i['auto'] else '') for i in q['upNext']])
print('enqueue', ev(guard('window.__ytmr.p.enqueue("vid0040","INSERT_AFTER_CURRENT_VIDEO")')))
print('like', ev(guard('window.__ytmr.p.like("LIKE")')), ev(guard('window.__ytmr.p.snap().like')))
print('lyrics', ev(guard('window.__ytmr.lyrics("vid0007")')))
print('toggle', ev(guard('window.__ytmr.p.toggle()')))
time.sleep(1.5)
# drain events
s.settimeout(0.5)
try:
    while True:
        line = f.readline()
        if not line: break
        events.append(json.loads(line))
except Exception: pass
b = [e for e in events if e.get('method') == 'Runtime.bindingCalled']
print('binding events', len(b), 'other events', sorted(set(e.get('method') for e in events)))
if b: print('last push', json.loads(b[-1]['params']['payload'])['playing'])
s.settimeout(None)
nid[0] += 1
f.write((json.dumps({'id': nid[0], 'method': 'Browser.close'}) + '\n').encode()); f.flush()
p.wait(timeout=10); print('bridge exit', p.returncode)
