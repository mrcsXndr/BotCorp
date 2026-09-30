// v0.8.5 step 14a: the cockpit side of "every chain entry is an Account".
// GET /api/accounts carries used_by (each bot whose chain names the account:
// role primary|backup, order) and plan_source; PATCH /api/accounts/:id renames
// and POST /api/accounts/link runs `accounts seed --link`, both behind the
// operator gate (403 with need: approve-token without it); an unlinked own
// token is an account_unlinked attention item until Link.
// A real server on a free loopback port over a throwaway BOTCORP_HOME /
// BOTCORP_BOTS_DIR, fake token values. Run: node --test cockpit/tests/accounts-model.test.mjs

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-accounts-model-test-'));
const RT = path.join(TMP, 'rt');
const BOTS = path.join(TMP, 'bots');
const STATE = path.join(RT, 'state');
// the operator's terminal: no bot-session markers; the plan probe stays off the network
const ENV = { ...process.env, BOTCORP_HOME: RT, BOTCORP_BOTS_DIR: BOTS, BOT_TG_MUTE: '1', BOTCORP_OAUTH_PROFILE_URL: 'off' };
delete ENV.BOT_NAME;
delete ENV.CLAUDECODE;
delete ENV.BOTCORP_LAUNCH_ID;
const TOK = (tail) => `sk-ant-oat01-${'FAKE'.repeat(8)}-${tail}`;

const bot = (name, extra = '') => {
  fs.mkdirSync(path.join(BOTS, name), { recursive: true });
  fs.writeFileSync(path.join(BOTS, name, 'bot.yaml'), `name: ${name}\nharness:\n  service: manual\n${extra}`);
};
const cliRun = (input, ...args) => spawnSync(process.execPath, [path.join(ROOT, 'cli', 'botcorp.mjs'), ...args], { env: ENV, encoding: 'utf-8', timeout: 120_000, input });
const must = (r) => { assert.equal(r.status, 0, r.stdout + r.stderr); return r; };

fs.mkdirSync(STATE, { recursive: true });
bot('t', 'account: acc1\n');
bot('u', 'account: acc2\nbackup_accounts: [acc1]\n');
bot('w');
must(cliRun(TOK('Aa11') + '\n', 'accounts', 'add', 'acc1', '--label', 'One'));
must(cliRun(TOK('Bb22') + '\n', 'accounts', 'add', 'acc2', '--label', 'Two'));
must(cliRun(TOK('Cc33') + '\n', 'secrets', 'set', 'w', 'oauth'));

const children = [];
after(() => { for (const c of children) c.kill(); });
let base, session, token;
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
  token = fs.readFileSync(path.join(STATE, 'cockpit-approve-token'), 'utf-8').trim();
});

const call = async (method, p, { body, operator = false } = {}) => {
  const r = await fetch(`${base}${p}`, {
    method, headers: { cookie: session, ...(body ? { 'content-type': 'application/json' } : {}), ...(operator ? { 'X-Approve-Token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json() };
};
const labels = () => Object.fromEntries(JSON.parse(must(cliRun(null, 'accounts', 'list', '--json')).stdout).map((a) => [a.id, a.label]));
const yamlOf = (name) => fs.readFileSync(path.join(BOTS, name, 'bot.yaml'), 'utf-8');

test('GET /api/accounts: used_by names each bot, its role and order; plan_source is there', async () => {
  const { status, json } = await call('GET', '/api/accounts');
  assert.equal(status, 200);
  const by = Object.fromEntries(json.accounts.map((a) => [a.id, a]));
  assert.deepEqual(by.acc1.used_by, [{ bot: 't', role: 'primary', order: 1 }, { bot: 'u', role: 'backup', order: 1 }]);
  assert.deepEqual(by.acc2.used_by, [{ bot: 'u', role: 'primary', order: 1 }]);
  assert.ok('plan_source' in by.acc1 && by.acc1.plan_source === null, JSON.stringify(by.acc1));
  assert.equal(by.acc1.state, 'ok', 'a plan-only cache entry is not a failed token check');
});

test('PATCH and link without the operator: 403 need approve-token, nothing changes', async () => {
  const p = await call('PATCH', '/api/accounts/acc1', { body: { label: 'Mine' } });
  assert.equal(p.status, 403);
  assert.equal(p.json.need, 'approve-token');
  const l = await call('POST', '/api/accounts/link', { body: {} });
  assert.equal(l.status, 403);
  assert.equal(l.json.need, 'approve-token');
  assert.deepEqual(labels(), { acc1: 'One', acc2: 'Two' });
  assert.doesNotMatch(yamlOf('w'), /account:/);
});

test('PATCH renames with the operator; 404 unknown, 400 bad label', async () => {
  assert.equal((await call('PATCH', '/api/accounts/acc1', { body: { label: '' }, operator: true })).status, 400);
  assert.equal((await call('PATCH', '/api/accounts/acc1', { body: { label: 'a\nb' }, operator: true })).status, 400);
  assert.equal((await call('PATCH', '/api/accounts/nope', { body: { label: 'X' }, operator: true })).status, 404);
  const r = await call('PATCH', '/api/accounts/acc1', { body: { label: 'Home seat' }, operator: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(labels().acc1, 'Home seat');
});

test('account_unlinked until Link; Link sets account: and the item goes', async () => {
  const first = await call('GET', '/api/attention');
  const item = first.json.items.find((i) => i.kind === 'account_unlinked');
  assert.ok(item, JSON.stringify(first.json.items));
  assert.deepEqual(item.action, { type: 'link', bots: ['w'] });
  const r = await call('POST', '/api/accounts/link', { body: {}, operator: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json, { ok: true, seeded: ['acct-cc33'], linked: ['w'], relabeled: [] });
  assert.match(yamlOf('w'), /^account: acct-cc33$/m);
  const later = await call('GET', '/api/attention');
  assert.equal(later.json.items.filter((i) => i.kind === 'account_unlinked').length, 0, JSON.stringify(later.json.items));
  const audit = fs.readFileSync(path.join(STATE, 'cockpit-audit.jsonl'), 'utf-8');
  assert.match(audit, /"path":"\/api\/accounts\/link".*"result":200/);
  assert.ok(!audit.includes('FAKEFAKE'), 'no token in the audit');
});
