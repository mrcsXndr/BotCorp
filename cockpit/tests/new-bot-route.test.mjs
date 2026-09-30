// v0.8.5 step 14b: POST /api/bots (New bot / New chat) and POST
// /api/bots/:name/archive, both behind the operator gate. A chat is service:
// manual named chat-MMDD-HHMM; every new bot runs on a registered account
// (account: in its bot.yaml, no typed token); creating never launches.
// A real server on a free loopback port over a throwaway BOTCORP_HOME /
// BOTCORP_BOTS_DIR, a fake token. Run: node --test cockpit/tests/new-bot-route.test.mjs

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-new-bot-test-'));
const RT = path.join(TMP, 'rt');
const BOTS = path.join(TMP, 'bots');
const STATE = path.join(RT, 'state');
const STAND_IN = path.join(TMP, 'claude.exe');   // never a real Claude Code
const ENV = { ...process.env, BOTCORP_HOME: RT, BOTCORP_BOTS_DIR: BOTS, BOT_TG_MUTE: '1', BOTCORP_OAUTH_PROFILE_URL: 'off', BOTCORP_CLAUDE_EXE: STAND_IN };
delete ENV.BOT_NAME;
delete ENV.CLAUDECODE;
delete ENV.BOTCORP_LAUNCH_ID;
const FAKE = `sk-ant-oat01-${'FAKE'.repeat(8)}-Nb77`;

fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(BOTS, { recursive: true });
fs.writeFileSync(STAND_IN, 'not a program');
const cliRun = (input, ...args) => spawnSync(process.execPath, [path.join(ROOT, 'cli', 'botcorp.mjs'), ...args], { env: ENV, encoding: 'utf-8', timeout: 120_000, input });
{
  const r = cliRun(FAKE + '\n', 'accounts', 'add', 'acc1');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // the 24 h token-check cache says the token logs in (no live check from a test)
  const fp = JSON.parse(cliRun(null, 'accounts', 'list', '--json').stdout)[0].fp;
  fs.writeFileSync(path.join(STATE, 'account-checks.json'), JSON.stringify({ [fp]: { ok: true, at: new Date().toISOString(), detail: 'haiku replied' } }));
}

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
const botDirs = () => fs.readdirSync(BOTS).sort();
let chat;

test('without the operator: 403 need approve-token, no folder', async () => {
  const r = await call('POST', '/api/bots', { body: { account: 'acc1', service: 'manual' } });
  assert.equal(r.status, 403);
  assert.equal(r.json.need, 'approve-token');
  assert.deepEqual(botDirs(), []);
});

test('bad bodies are 400 (the gate comes first: a write needs the operator before anything else)', async () => {
  for (const body of [{ account: 'acc1' }, { account: 'acc1', service: 'cron' }, { service: 'manual' }, { account: 'Bad!', service: 'manual' },
    { account: 'acc1', service: 'manual', name: 'Bad Name' }, { account: 'acc1', service: 'manual', persona: 'a\nb' }, { account: 'acc1', service: 'manual', telegram: 'yes' }]) {
    assert.equal((await call('POST', '/api/bots', { body, operator: true })).status, 400, JSON.stringify(body));
  }
});

test('New chat: 200, chat-MMDD-HHMM, service manual and account: in its bot.yaml', async () => {
  const r = await call('POST', '/api/bots', { body: { account: 'acc1', service: 'manual', persona: 'Answers tersely.' }, operator: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  chat = r.json.name;
  assert.match(chat, /^chat-\d{4}-\d{4}$/);
  const yaml = fs.readFileSync(path.join(BOTS, chat, 'bot.yaml'), 'utf-8');
  assert.match(yaml, /^account: acc1$/m);
  assert.match(yaml, /^ {2}service: manual$/m);
  assert.match(yaml, /^persona: Answers tersely\.$/m);
  assert.ok(!r.json.out.includes(FAKE) && !r.json.err.includes(FAKE));
});

test('a second unnamed chat in the same minute gets a suffix', async () => {
  const r = await call('POST', '/api/bots', { body: { account: 'acc1', service: 'manual' }, operator: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.notEqual(r.json.name, chat);
  assert.match(r.json.name, /^chat-\d{4}-\d{4}(-\d+)?$/);
});

test('New bot (keep running): service daemon, account:', async () => {
  const r = await call('POST', '/api/bots', { body: { account: 'acc1', service: 'daemon', name: 'pinned' }, operator: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.name, 'pinned');
  const yaml = fs.readFileSync(path.join(BOTS, 'pinned', 'bot.yaml'), 'utf-8');
  assert.match(yaml, /^account: acc1$/m);
  assert.doesNotMatch(yaml, /service:/);
});

test('an unknown account is 409 and leaves no folder', async () => {
  const r = await call('POST', '/api/bots', { body: { account: 'nope', service: 'manual', name: 'ghost' }, operator: true });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.ok(!fs.existsSync(path.join(BOTS, 'ghost')));
});

test('archive: 403 without the operator; 409 for a daemon bot; 200 moves a chat', async () => {
  const no = await call('POST', `/api/bots/${chat}/archive`, { body: {} });
  assert.equal(no.status, 403);
  assert.equal(no.json.need, 'approve-token');
  assert.ok(fs.existsSync(path.join(BOTS, chat)));
  assert.equal((await call('POST', '/api/bots/pinned/archive', { body: {}, operator: true })).status, 409);
  const r = await call('POST', `/api/bots/${chat}/archive`, { body: {}, operator: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(!fs.existsSync(path.join(BOTS, chat)));
  assert.ok(fs.readdirSync(path.join(RT, 'archive')).some((d) => d.startsWith(`${chat}-`)));
  const audit = fs.readFileSync(path.join(STATE, 'cockpit-audit.jsonl'), 'utf-8');
  assert.match(audit, /"path":"\/api\/bots".*"result":200/);
  assert.match(audit, new RegExp(`"path":"/api/bots/${chat}/archive".*"result":200`));
});
