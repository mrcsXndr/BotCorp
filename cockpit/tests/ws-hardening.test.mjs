// The WebSocket paths never die on one bad frame or a reset: the cockpit's
// /term upgrade (a client RST while the handler awaits), the browser socket
// inside ptybridge.mjs (an error or a frame before its first await settles),
// and the pty-host (a frame over its 2 MB cap). Each case is the reviewed
// crash (code review 2026-09-30, C4-C6); the check is that the process still
// serves afterwards. Run: node --test cockpit/tests/

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const SERVER = path.join(HERE, '..', 'server.mjs');
const PTY_HOST = path.join(ROOT, 'daemon', 'pty-host.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-ws-test-'));
const RT = path.join(TMP, 'rt');
const BOTS = path.join(TMP, 'bots');
fs.mkdirSync(path.join(BOTS, 'demo'), { recursive: true });
fs.writeFileSync(path.join(BOTS, 'demo', 'bot.yaml'), 'name: demo\nharness:\n  service: manual\n  session: pty\n  modules:\n    telegram: false\n');
process.env.BOTCORP_HOME = RT;
process.env.BOTCORP_BOTS_DIR = BOTS;

const children = [];
after(() => { for (const c of children) { try { c.kill(); } catch {} } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}
function track(child) {
  children.push(child);
  const t = { child, log: '' };
  child.stdout.on('data', (d) => { t.log += d; });
  child.stderr.on('data', (d) => { t.log += d; });
  return t;
}
async function startCockpit() {
  const port = await freePort();
  const t = track(spawn(process.execPath, [SERVER, '--port', String(port)], {
    env: { ...process.env, BOTCORP_HOME: RT, BOTCORP_BOTS_DIR: BOTS, BOT_TG_MUTE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {}
    if (i > 150) throw new Error(`cockpit did not start: ${t.log}`);
    await sleep(100);
  }
  const cookie = (await fetch(`${base}/`)).headers.get('set-cookie').split(';')[0];
  const token = fs.readFileSync(path.join(RT, 'state', 'cockpit-approve-token'), 'utf-8').trim();
  return { ...t, port, base, cookie, token };
}
async function alive(c) {
  assert.equal(c.child.exitCode, null, `the process exited: ${c.log}`);
  if (c.base) assert.equal((await fetch(`${c.base}/healthz`)).status, 200, `the cockpit stopped serving: ${c.log}`);
}
function upgradeRequest(port, cookie, token) {
  return `GET /term/demo HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
    + `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nCookie: ${cookie}\r\nx-approve-token: ${token}\r\n\r\n`;
}

test('C4: a client reset while the /term upgrade awaits does not kill the cockpit', async () => {
  const c = await startCockpit();
  for (let i = 0; i < 30; i++) {
    const s = net.connect(c.port, '127.0.0.1');
    s.on('error', () => {});
    await once(s, 'connect');
    s.write(upgradeRequest(c.port, c.cookie, c.token));
    s.resetAndDestroy();
  }
  await sleep(1500);
  await alive(c);
  assert.doesNotMatch(c.log, /uncaught/, 'handled on the socket, not by the last-resort handler');
});

test('C5: an error or a frame on the browser socket before bridge() settles is handled, not thrown', async () => {
  const { bridge } = await import('../ptybridge.mjs');
  const browser = new EventEmitter();
  browser.readyState = 1;
  browser.sent = [];
  browser.send = (d) => browser.sent.push(JSON.parse(d));
  browser.close = () => { browser.readyState = 3; };
  const done = bridge({ name: 'demo', kind: 'pty', running: false }, browser, { chat: false });
  // what ws does on a frame over maxPayload, before bridge's first await has settled
  assert.doesNotThrow(() => browser.emit('error', Object.assign(new Error('Max payload size exceeded'), { code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' })));
  assert.doesNotThrow(() => browser.emit('message', Buffer.from(JSON.stringify({ t: 'r', cols: 80, rows: 24 }))));
  await done;
  assert.equal(browser.readyState, 3, 'the errored socket is closed');
});

function auditRows() {
  const f = path.join(RT, 'state', 'cockpit-audit.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}
let auditFrom = 0;   // rows an earlier test wrote (C4's resets share the runtime) are not this test's
async function waitAudit(pred) {
  for (let i = 0; i < 60; i++) { const r = auditRows().slice(auditFrom).filter(pred); if (r.length) return r; await sleep(50); }
  return [];
}

test('C1: /term needs the operator (a session cookie alone gets need + 4403); every attach is audited', async () => {
  const c = await startCockpit();
  auditFrom = auditRows().length;
  // a local process with only the page cookie (a bot's curl): refused, told why, audited
  const plain = new WebSocket(`ws://127.0.0.1:${c.port}/term/demo`, { headers: { cookie: c.cookie } });
  plain.on('error', () => {});
  const got = [];
  plain.on('message', (d) => got.push(JSON.parse(d.toString())));
  const [code] = await once(plain, 'close');
  assert.equal(code, 4403);
  assert.deepEqual(got.map((m) => m.t), ['need']);
  assert.equal(got[0].need, 'approve-token');
  const refused = await waitAudit((r) => r.method === 'WS' && r.result === 403);
  assert.equal(refused.length, 1);
  assert.deepEqual({ ...refused[0], ts: undefined }, { ts: undefined, identity: 'local', method: 'WS', path: '/term/demo', bot: 'demo', result: 403 });

  // with the operator's approval token: attached (no pty-host up -> stopped), one audit line
  const op = new WebSocket(`ws://127.0.0.1:${c.port}/term/demo`, { headers: { cookie: c.cookie, 'x-approve-token': c.token } });
  op.on('error', () => {});
  const [first] = await once(op, 'message');
  assert.equal(JSON.parse(first.toString()).t, 'stopped');
  op.close();
  const attached = await waitAudit((r) => r.method === 'WS' && r.result === 'attached');
  assert.equal(attached.length, 1);
  assert.equal(attached[0].bot, 'demo');
  assert.doesNotMatch(JSON.stringify(auditRows()), new RegExp(c.token), 'the token never reaches the audit log');
  await alive(c);
});

test('C6: a frame over the pty-host cap does not kill the host (or the session it owns)', async () => {
  const t = track(spawn(process.execPath, [PTY_HOST, '--bot', 'demo', '--botcorp', ROOT], {
    env: { ...process.env, BOTCORP_HOME: RT, BOTCORP_BOTS_DIR: BOTS, BOTCORP_PTY_COMMAND: process.platform === 'win32' ? 'ping -n 60 127.0.0.1 >nul' : 'sleep 60' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const file = path.join(RT, 'state', 'demo.pty.json');
  for (let i = 0; !fs.existsSync(file); i++) {
    if (i > 150) throw new Error(`pty-host did not start: ${t.log}`);
    await sleep(100);
  }
  const ep = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const url = `ws://127.0.0.1:${ep.port}/?token=${encodeURIComponent(ep.token)}`;
  const bad = new WebSocket(url);
  bad.on('error', () => {});
  await once(bad, 'open');
  bad.send(Buffer.alloc(2 * 1024 * 1024 + 16, 97));
  await Promise.race([once(bad, 'close'), sleep(3000)]);
  await sleep(500);
  assert.equal(t.child.exitCode, null, `the pty-host exited: ${t.log}`);
  const good = new WebSocket(url);
  const [first] = await once(good, 'message');
  assert.equal(JSON.parse(first.toString()).t, 'hello', 'a new client still attaches');
  good.close();
});
