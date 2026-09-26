// Cockpit hardening: the strict CSP on every response, the access.json
// allowed_emails check on top of a verified Access JWT, and the append-only
// state/cockpit-audit.jsonl line per mutating API call (never a body).
// Unit tests on access.mjs, then two real servers on free ports (loopback and
// Access mode) with a throwaway runtime dir. Run: node --test cockpit/tests/

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadAccessConfig, AccessVerifier } from '../access.mjs';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-hardening-test-'));
const TEAM = 'test-team';
const AUD = 'value-for-tests-aud';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWKS_FILE = path.join(TMP, 'jwks.json');
fs.writeFileSync(JWKS_FILE, JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' }] }));
process.env.COCKPIT_ACCESS_JWKS_FILE = JWKS_FILE;

const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function jwt(email) {
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1' }));
  const p = b64u(JSON.stringify({ iss: `https://${TEAM}.cloudflareaccess.com`, aud: AUD, exp: Math.floor(Date.now() / 1000) + 300, email }));
  return `${h}.${p}.${b64u(crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey))}`;
}
function accessFile(dir, extra) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'access.json');
  fs.writeFileSync(f, JSON.stringify({ team: TEAM, aud: AUD, ...extra }));
  return f;
}

test('allowed_emails: a verified JWT for an unlisted email is refused; empty list admits any', async () => {
  const cfg = await loadAccessConfig(accessFile(path.join(TMP, 'unit'), { allowed_emails: ['Ops@Example.com'] }));
  assert.deepEqual(cfg.allowedEmails, ['ops@example.com']);
  const v = new AccessVerifier(cfg);
  await assert.rejects(v.verify(jwt('other@example.com')), /email not allowed/);
  assert.deepEqual(await v.verify(jwt('OPS@example.com')), { email: 'ops@example.com' });

  const open = await loadAccessConfig(accessFile(path.join(TMP, 'unit-open'), {}));
  assert.deepEqual(open.allowedEmails, []);
  assert.deepEqual(await new AccessVerifier(open).verify(jwt('other@example.com')), { email: 'other@example.com' });

  await assert.rejects(loadAccessConfig(accessFile(path.join(TMP, 'unit-bad'), { allowed_emails: 'ops@example.com' })), /allowed_emails/);
});

// ---- real servers ---------------------------------------------------------------
const children = [];
after(() => { for (const c of children) c.kill(); });

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}
async function startServer(rt) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER, '--port', String(port)], {
    env: { ...process.env, BOTCORP_HOME: rt, BOT_TG_MUTE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) return base; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`cockpit did not start: ${log}`);
}
async function auditLines(rt, want) {
  const f = path.join(rt, 'state', 'cockpit-audit.jsonl');
  for (let i = 0; i < 40; i++) {
    const lines = fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean) : [];
    if (lines.length >= want) return lines;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean) : [];
}

test('loopback: strict CSP on the page; one audit line per mutating call, no body', async () => {
  const rt = path.join(TMP, 'rt-loop');
  const base = await startServer(rt);
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /(^|; )script-src 'self'(;|$)/);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  const html = await page.text();
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'no inline <script> in index.html');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no inline on* handler in index.html');
  const cookie = page.headers.get('set-cookie').split(';')[0];

  for (const f of ['/theme.js', '/app.js']) {
    const r = await fetch(`${base}${f}`, { headers: { cookie } });
    assert.equal(r.status, 200, f);
    assert.match(r.headers.get('content-type'), /javascript/, f);
  }

  // reads are not audited
  assert.equal((await fetch(`${base}/api/bots`, { headers: { cookie } })).status, 200);
  const stop = await fetch(`${base}/api/bots/zz-nope/stop`, { method: 'POST', headers: { cookie } });
  assert.equal(stop.status, 404);
  let lines = await auditLines(rt, 1);
  assert.equal(lines.length, 1, 'exactly one line for one mutating POST');
  const row = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(row).sort(), ['bot', 'identity', 'method', 'path', 'result', 'ts']);
  assert.deepEqual({ ...row, ts: undefined }, { ts: undefined, identity: 'local', method: 'POST', path: '/api/bots/zz-nope/stop', bot: 'zz-nope', result: 404 });

  const put = await fetch(`${base}/api/bots/zz-nope/secrets/oauth_token?x=1`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ value: 'value-for-tests-secret-Q7' }),
  });
  assert.equal(put.status, 404);
  lines = await auditLines(rt, 2);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).path, '/api/bots/zz-nope/secrets/oauth_token', 'no query string');
  assert.doesNotMatch(lines.join('\n'), /value-for-tests-secret/, 'a body never reaches the audit log');
});

test('access mode: a verified JWT for an email off allowed_emails gets 401, a listed one the page', async () => {
  const rt = path.join(TMP, 'rt-access');
  accessFile(rt, { allowed_emails: ['ops@example.com'] });
  const base = await startServer(rt);
  const denied = await fetch(`${base}/`, { headers: { 'cf-access-jwt-assertion': jwt('other@example.com') } });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('set-cookie'), null);
  const ok = await fetch(`${base}/`, { headers: { 'cf-access-jwt-assertion': jwt('ops@example.com') } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-security-policy'), /script-src 'self'/);
  const denyPost = await fetch(`${base}/api/bots/zz-nope/stop`, { method: 'POST', headers: { 'cf-access-jwt-assertion': jwt('other@example.com') } });
  assert.equal(denyPost.status, 401);
  assert.equal((await auditLines(rt, 1)).length, 0, 'an unidentified caller is refused before the audit');
});
