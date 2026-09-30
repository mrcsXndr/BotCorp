// Gate by default (code review 2026-09-30, C2/C3): on a loopback cockpit every
// mutating /api route needs the operator (a paired browser's cookie, the
// approval token, or Access) unless it is on the short open list, and /unlock
// locks after repeated wrong passphrases. The route list is read from
// server.mjs itself, so a route added later is covered without editing here.
// Run: node --test cockpit/tests/

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-gate-test-'));
const RT = path.join(TMP, 'rt');
const BOTS = path.join(TMP, 'bots');
fs.mkdirSync(path.join(BOTS, 'demo'), { recursive: true });
fs.writeFileSync(path.join(BOTS, 'demo', 'bot.yaml'), 'name: demo\nharness:\n  service: manual\n  session: pty\n  modules:\n    telegram: false\n');

// The mutating routes that stay open, and why (server.mjs OPEN_MUTATIONS):
//   POST /api/pair/claim - how a browser becomes the operator's; its own code check and lockout
const OPEN = new Set(['POST /api/pair/claim']);

const children = [];
after(() => { for (const c of children) { try { c.kill(); } catch {} } });

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}
let base, cookie, token;
async function start() {
  if (base) return;
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER, '--port', String(port)], {
    env: { ...process.env, BOTCORP_HOME: RT, BOTCORP_BOTS_DIR: BOTS, BOT_TG_MUTE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {}
    if (i > 150) throw new Error(`cockpit did not start: ${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  cookie = (await fetch(`${base}/`)).headers.get('set-cookie').split(';')[0];
  token = fs.readFileSync(path.join(RT, 'state', 'cockpit-approve-token'), 'utf-8').trim();
}

const routes = [...fs.readFileSync(SERVER, 'utf-8').matchAll(/^app\.(post|put|patch|delete)\('([^']+)'/gm)].map((m) => ({ m: m[1].toUpperCase(), p: m[2] }));
const fill = (p) => p.replace(/:name\b/g, 'demo').replace(/:([A-Za-z]+)/g, 'x1');

test('every mutating /api route but the open list needs the operator (403 need approve-token)', async () => {
  await start();
  assert.ok(routes.length > 25, 'the scan found the route table');
  const refused = [];
  for (const { m, p } of routes) {
    const key = `${m} ${p}`;
    const r = await fetch(`${base}${fill(p)}`, { method: m, headers: { cookie, 'content-type': 'application/json' }, body: m === 'DELETE' ? undefined : '{}' });
    const j = await r.json().catch(() => ({}));
    if (OPEN.has(key)) assert.notEqual(r.status, 403, `${key} must stay open`);
    else if (r.status !== 403 || j.need !== 'approve-token') refused.push(`${key} -> ${r.status}`);
  }
  assert.deepEqual(refused, [], 'ungated mutating routes');
});

test('the gate passes the operator: with the approval token a gated route reaches its own validation', async () => {
  await start();
  const r = await fetch(`${base}/api/chat/launch`, { method: 'POST', headers: { cookie, 'x-approve-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ account: 'Bad Id' }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /bad account id/);
});

test('/unlock: five wrong passphrases lock it (429), even for the operator', async () => {
  await start();
  const unlock = () => fetch(`${base}/api/bots/demo/unlock`, { method: 'POST', headers: { cookie, 'x-approve-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: 'wrong-guess' }) });
  for (let i = 0; i < 5; i++) {
    const r = await unlock();
    assert.equal(r.status, 400, `guess ${i + 1} is a plain failure`);
  }
  const locked = await unlock();
  assert.equal(locked.status, 429);
  assert.match((await locked.json()).error, /locked/);
});
