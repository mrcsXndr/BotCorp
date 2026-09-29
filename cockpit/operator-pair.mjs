// operator-pair.mjs - one-time browser pairing for a loopback cockpit's
// operator-only actions. Not Telegram pairing (that is pairing.mjs).
//
// On loopback any local process can mint the session cookie (a bot's curl too),
// so approvals and the other widening routes need proof of the operator. The
// per-boot X-Approve-Token still works; pairing is the one-time alternative:
//   1. the operator runs `botcorp cockpit pair` in their own terminal: an
//      8-character code, valid CODE_TTL_MS, single use. The pairing file keeps
//      only its sha256. The CLI refuses it inside a bot session and the
//      operator-guard hook blocks it for every bot, admin included.
//   2. the browser posts the code to POST /api/pair/claim; the server adds a
//      device and sets botcorp_operator=<id>.<HMAC(key, id)> (HttpOnly,
//      SameSite=Strict, 90 days). MAX_FAILS bad codes lock claiming for LOCK_MS.
//   3. operatorGate accepts that cookie while the device is listed; revoking
//      it (DELETE /api/pair/devices/:id, `botcorp cockpit unpair`) ends it.
// Files, both under <rt>/state and both behind vault-guard:
//   cockpit-operator.key   the HMAC key, owner-only, created on first use
//   cockpit-pairing.json   {code: {sha256, expires}, fails, locked_until, devices: [...]}
// A bot runs as the same OS user, so this is policy plus the guards, the same
// class of boundary as the token file (docs/cockpit.md).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { restrictToUser } from '../core/acl.mjs';

export const COOKIE = 'botcorp_operator';
export const CODE_TTL_MS = 10 * 60_000;
export const LOCK_MS = 10 * 60_000;
export const MAX_FAILS = 5;
export const MAX_AGE_S = 90 * 86_400;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I
const ID_RE = /^[0-9a-f]{16}$/;
const COOKIE_RE = new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{16})\\.([0-9a-f]{64})(?:;|$)`);

export const pairingFile = (stateDir) => path.join(stateDir, 'cockpit-pairing.json');
export const keyFile = (stateDir) => path.join(stateDir, 'cockpit-operator.key');

function readState(stateDir) {
  let s = null;
  try { s = JSON.parse(fs.readFileSync(pairingFile(stateDir), 'utf-8')); } catch {}
  if (!s || typeof s !== 'object') s = {};
  return { code: s.code && typeof s.code === 'object' ? s.code : null, fails: Number(s.fails) || 0,
    locked_until: s.locked_until || null, devices: Array.isArray(s.devices) ? s.devices.filter((d) => d && ID_RE.test(d.id)) : [] };
}
// owner-only before the rename makes it visible
function writeOwnerOnly(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: 'utf-8', mode: 0o600 });
  restrictToUser(tmp);
  fs.renameSync(tmp, file);
}
const writeState = (stateDir, s) => writeOwnerOnly(pairingFile(stateDir), JSON.stringify(s, null, 2) + '\n');

function operatorKey(stateDir) {
  const f = keyFile(stateDir);
  try { const k = fs.readFileSync(f, 'utf-8').trim(); if (/^[0-9a-f]{64}$/.test(k)) return Buffer.from(k, 'hex'); } catch {}
  writeOwnerOnly(f, crypto.randomBytes(32).toString('hex') + '\n');
  return Buffer.from(fs.readFileSync(f, 'utf-8').trim(), 'hex');
}
const mac = (key, id) => crypto.createHmac('sha256', key).update(`botcorp-operator:${id}`).digest('hex');
const sha = (code) => crypto.createHash('sha256').update(code).digest('hex');
export const normalize = (code) => String(code || '').toUpperCase().replace(/[\s-]/g, '');

// The operator's terminal only (the CLI checks too; this catches an import).
// -> { code: 'ABCD-EFGH', expires }
export function mintCode(stateDir, { now = Date.now(), env = process.env } = {}) {
  if (env.BOT_NAME || env.CLAUDECODE) throw new Error('cockpit pair: operator-only: run it in your own terminal, not in a bot session');
  const bytes = crypto.randomBytes(8);
  const code = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  const s = readState(stateDir);
  // a fresh code from the operator's terminal also lifts a lock bad guesses set
  writeState(stateDir, { ...s, code: { sha256: sha(code), expires: new Date(now + CODE_TTL_MS).toISOString() }, fails: 0, locked_until: null });
  return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expires: new Date(now + CODE_TTL_MS).toISOString() };
}

// -> { ok: true, device, value } (value = the cookie value) | { ok: false, status, error }
export function claim(stateDir, code, { label = '', now = Date.now() } = {}) {
  const s = readState(stateDir);
  if (s.locked_until && Date.parse(s.locked_until) > now) return { ok: false, status: 429, error: `pairing is locked after ${MAX_FAILS} wrong codes until ${s.locked_until}; run botcorp cockpit pair again later` };
  const want = s.code && Date.parse(s.code.expires) > now ? String(s.code.sha256 || '') : '';
  const got = sha(normalize(code));
  if (!(want.length === got.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got)))) {
    const fails = s.fails + 1;
    const locked = fails >= MAX_FAILS;
    writeState(stateDir, { ...s, fails: locked ? 0 : fails, locked_until: locked ? new Date(now + LOCK_MS).toISOString() : s.locked_until });
    return { ok: false, status: 403, error: locked ? `wrong or expired code; pairing is locked for ${LOCK_MS / 60_000} minutes` : 'wrong or expired code (run botcorp cockpit pair in your terminal for a new one)' };
  }
  const device = { id: crypto.randomBytes(8).toString('hex'), created: new Date(now).toISOString(), label: String(label).replace(/[^\x20-\x7e]/g, '').slice(0, 80) };
  writeState(stateDir, { ...s, code: null, fails: 0, locked_until: null, devices: [...s.devices, device] });
  return { ok: true, device, value: `${device.id}.${mac(operatorKey(stateDir), device.id)}` };
}

export function setCookieHeader(value) { return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_S}`; }

// The device a request's operator cookie names, while it is listed; else null.
export function deviceOf(stateDir, cookieHeader) {
  const m = COOKIE_RE.exec(String(cookieHeader || ''));
  if (!m) return null;
  const s = readState(stateDir);
  const device = s.devices.find((d) => d.id === m[1]);
  if (!device) return null;
  let key;
  try { key = fs.readFileSync(keyFile(stateDir), 'utf-8').trim(); } catch { return null; }
  if (!/^[0-9a-f]{64}$/.test(key)) return null;
  const want = mac(Buffer.from(key, 'hex'), m[1]);
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[2])) ? device : null;
}

export function listDevices(stateDir) { return readState(stateDir).devices; }

// id: one device id, or 'all'. -> how many were removed
export function revoke(stateDir, id) {
  const s = readState(stateDir);
  const keep = id === 'all' ? [] : s.devices.filter((d) => d.id !== id);
  const n = s.devices.length - keep.length;
  if (n) writeState(stateDir, { ...s, devices: keep });
  return n;
}
