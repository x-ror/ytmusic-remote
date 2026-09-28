# Attach, drop and re-attach three times; one push must still arrive ONCE,
# and SIGTERM on the bridge must also quit the app.
import json
import os
import socket
import subprocess
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.join(ROOT, '..', 'ytmusic-remote@andrii')
env = dict(os.environ, YTMR_APP=os.path.join(ROOT, 'mock/mock-app'))
sock_path = os.path.join(os.environ['XDG_RUNTIME_DIR'], 'ytmusic-remote', 'cdp.sock')
p = subprocess.Popen(['python3', os.path.join(EXT, 'tools/cdp-bridge')], env=env)
while not os.path.exists(sock_path):
    time.sleep(0.1)
time.sleep(2)


def client():
    s = socket.socket(socket.AF_UNIX)
    s.connect(sock_path)
    f = s.makefile('rwb')
    n = [0]
    ev = []

    def cmd(m, params=None, sid=None):
        n[0] += 1
        o = {'id': n[0], 'method': m, 'params': params or {}}
        if sid:
            o['sessionId'] = sid
        f.write((json.dumps(o) + '\n').encode())
        f.flush()
        while True:
            r = json.loads(f.readline())
            if r.get('id') == n[0]:
                return r
            ev.append(r)
    t = [x for x in cmd('Target.getTargets')['result']['targetInfos'] if x['type'] == 'page'][0]
    sid = cmd('Target.attachToTarget', {'targetId': t['targetId'], 'flatten': True})['result']['sessionId']
    cmd('Runtime.addBinding', {'name': '__ytmrPush'}, sid)
    return s, f, cmd, sid, ev


for i in range(3):
    s, f, cmd, sid, ev = client()
    s.close()
    time.sleep(0.3)
s, f, cmd, sid, ev = client()
cmd('Runtime.evaluate', {'expression': '__ytmrPush("x")'}, sid)
s.settimeout(1.0)
try:
    while True:
        ev.append(json.loads(f.readline()))
except Exception:
    pass
print('pushes for one call after 3 dropped clients:', sum(1 for e in ev if e.get('method') == 'Runtime.bindingCalled'))
p.send_signal(15)
p.wait(timeout=15)
time.sleep(1)
alive = subprocess.run(['pgrep', '-f', 'user-data-dir=.*ytmr-mock'], capture_output=True).returncode == 0
print('bridge exit', p.returncode, '| app still running after SIGTERM:', alive)
