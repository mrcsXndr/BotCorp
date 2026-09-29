// Browser pairing for a loopback cockpit's operator actions (cockpit/operator-pair.mjs):
// `botcorp cockpit pair` mints a one-time code, POST /api/pair/claim trades it
// for the botcorp_operator cookie, and operatorGate accepts that cookie while
// the device is listed. The old X-Approve-Token keeps working.
// A real server on a free loopback port over a throwaway BOTCORP_HOME /
// BOTCORP_BOTS_DIR. Run: node --test cockpit/tests/operator-pair.test.mjs

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-operator-pair-test-'));
const RT = path.join(TMP, 'rt');
const BOTS = path.join(TMP, 'bots');
const STATE = path.join(RT, 'state');
// the operator's terminal: no bot-session markers (this suite may itself run inside one)
const ENV = { ...process.env, BOTCORP_HOME: RT, BOTCORP_BOTS_DIR: BOTS, BOT_TG_MUTE: '1' };
delete ENV.BOT_NAME;
delete ENV.CLAUDECODE;
delete ENV.BOTCORP_LAUNCH_ID;

fs.mkdirSync(path.join(BOTS, 't'), { recursive: true });
fs.writeFileSync(path.join(BOTS, 't', 'bot.yaml'), 'name: t\nharness:\n  service: manual\n');
fs.mkdirSync(STATE, { recursive: true });
const entry = (id, mod) => ({ id, ts: '2026-09-29T00:00:00Z', op: 'set', path: `harness.modules.${mod}`, value: true, requested_by: 'operator:test', reason: 'test' });
fs.writeFileSync(path.join(STATE, 't.approvals.json'), JSON.stringify([entry('aaa111', 'debrief'), entry('bbb222', 'sound'), entry('ccc333', 'lessons')]));

const cliRun = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'cli', 'botcorp.mjs'), ...args], { env: ENV, encoding: 'utf-8', timeout: 60_000 });
const mint = () => { const r = cliRun('cockpit', 'pair', '--json'); assert.equal(r.status, 0, r.stdout + r.stderr); return JSON.parse(r.stdout).code; };

const children = [];
after(() => { for (const c of children) c.kill(); });
let base, session;
before(async () => {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  const child = spawn(process.execPath, [path.join(ROOT, 'cockpit', 'server.mjs'), '--port', String(port)], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200, log);
  session = page.headers.get('set-cookie').split(';')[0];
});

const call = (method, p, { body, cookie = '', headers = {} } = {}) => fetch(`${base}${p}`, {
  method, headers: { cookie: [session, cookie].filter(Boolean).join('; '), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
  body: body ? JSON.stringify(body) : undefined,
});
const approve = (id, opts) => call('POST', `/api/bots/t/approvals/${id}/approve`, { body: {}, ...opts });
const claim = (code) => call('POST', '/api/pair/claim', { body: { code } });
const queued = () => JSON.parse(fs.readFileSync(path.join(STATE, 't.approvals.json'), 'utf-8')).map((e) => e.id);
let operatorCookie, deviceId;

test('no operator cookie and no token: 403 with need, nothing applied', async () => {
  const r = await approve('aaa111');
  assert.equal(r.status, 403);
  const j = await r.json();
  assert.equal(j.need, 'approve-token');
  assert.match(j.error, /cockpit pair/);
  assert.deepEqual(queued(), ['aaa111', 'bbb222', 'ccc333']);
});

test('bad codes get 403; the fifth locks claiming, the right code included', async () => {
  const code = mint();
  for (let i = 1; i <= 5; i++) {
    const r = await claim('ZZZZ-ZZZZ');
    assert.equal(r.status, 403, `try ${i}`);
    assert.equal(r.headers.get('set-cookie'), null);
  }
  const locked = await claim(code);
  assert.equal(locked.status, 429);
  assert.match((await locked.json()).error, /locked/);
  assert.equal((await claim('')).status, 400, 'a malformed code is a 400, before the lock count');
});

test('a fresh code (it lifts the lock) sets botcorp_operator, and approve then passes the gate', async () => {
  const code = mint();
  const r = await claim(code.toLowerCase());   // case and the dash do not matter
  assert.equal(r.status, 200);
  const j = await r.json();
  deviceId = j.device.id;
  assert.match(deviceId, /^[0-9a-f]{16}$/);
  const set = r.headers.get('set-cookie');
  assert.match(set, /^botcorp_operator=[0-9a-f]{16}\.[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=7776000$/);
  operatorCookie = set.split(';')[0];
  const a = await approve('aaa111', { cookie: operatorCookie });
  assert.equal(a.status, 200, await a.text());
  assert.deepEqual(queued(), ['bbb222', 'ccc333']);
  const devices = await (await call('GET', '/api/pair/devices', { cookie: operatorCookie })).json();
  assert.deepEqual(devices.devices.map((d) => [d.id, d.current]), [[deviceId, true]]);
  // the code is single-use
  assert.equal((await claim(code)).status, 403);
});

test('a forged cookie (a listed id, a wrong MAC) is refused', async () => {
  const forged = `botcorp_operator=${deviceId}.${'0'.repeat(64)}`;
  assert.equal((await approve('bbb222', { cookie: forged })).status, 403);
  assert.equal((await call('DELETE', `/api/pair/devices/${deviceId}`, { cookie: forged })).status, 403, 'revoking needs the operator too');
});

test('the old X-Approve-Token still passes', async () => {
  const token = fs.readFileSync(path.join(STATE, 'cockpit-approve-token'), 'utf-8').trim();
  const r = await approve('bbb222', { headers: { 'X-Approve-Token': token } });
  assert.equal(r.status, 200, await r.text());
  assert.deepEqual(queued(), ['ccc333']);
});

test('a revoked device gets 403 again', async () => {
  const r = cliRun('cockpit', 'unpair', deviceId);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const a = await approve('ccc333', { cookie: operatorCookie });
  assert.equal(a.status, 403);
  assert.deepEqual(queued(), ['ccc333']);
  const devices = await (await call('GET', '/api/pair/devices')).json();
  assert.deepEqual(devices.devices, []);
});

test('DELETE /api/pair/devices/:id revokes with the operator cookie', async () => {
  const r = await claim(mint());
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const { device } = await r.json();
  const d = await call('DELETE', `/api/pair/devices/${device.id}`, { cookie });
  assert.equal(d.status, 200);
  assert.equal((await approve('ccc333', { cookie })).status, 403);
  assert.equal((await call('DELETE', '/api/pair/devices/not-an-id')).status, 400);
});

test('the files: the key is 32 bytes hex, the pairing file never holds a code', () => {
  assert.match(fs.readFileSync(path.join(STATE, 'cockpit-operator.key'), 'utf-8').trim(), /^[0-9a-f]{64}$/);
  const code = mint();
  const stored = fs.readFileSync(path.join(STATE, 'cockpit-pairing.json'), 'utf-8');
  assert.ok(!stored.includes(code) && !stored.includes(code.replace('-', '')));
  const audit = fs.readFileSync(path.join(STATE, 'cockpit-audit.jsonl'), 'utf-8');
  assert.ok(!audit.includes(code.replace('-', '')), 'a code never reaches the audit log');
  assert.match(audit, /"pair":"claim"/);
});
