// vault.mjs - thin, masked-only view of a bot's vault.
//
// The vault (bots/<name>/.vault/secrets.json, DPAPI) is never read by the
// cockpit. Listing shells out to `botcorp secrets list <bot> --json`, which
// returns MASKED entries; setting pipes the value to `botcorp secrets set
// <bot> <key>` on STDIN (never argv: process listings show argv). Nothing
// here can return a secret value, and the request body is never logged.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { runCli } from './cli.mjs';
import { STATE_DIR } from './bots.mjs';

const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const SECRET_ACCESS_LOG = path.join(STATE_DIR, 'secret-access.jsonl');

export async function listSecrets(bot) {
  const r = await runCli(['secrets', 'list', bot, '--json']);
  if (r.code !== 0) throw new Error(`secrets list failed (${r.code}): ${r.err || r.out}`);
  let data;
  try { data = JSON.parse(r.out); } catch { throw new Error('secrets list: CLI did not return JSON'); }
  const entries = Array.isArray(data) ? data : (Array.isArray(data?.secrets) ? data.secrets : []);
  // Re-mask defensively: the UI only ever sees key + masked + updatedAt.
  return entries.map((e) => ({
    key: String(e.key ?? e.name ?? ''),
    masked: typeof e.masked === 'string' ? e.masked : '****',
    updatedAt: e.updatedAt ?? e.updated_at ?? null,
  })).filter((e) => e.key);
}

export async function setSecret(bot, key, value) {
  if (!KEY_RE.test(key || '')) throw new Error('secret key: lowercase letters, digits, underscore, up to 32 chars');
  if (typeof value !== 'string' || !value.trim()) throw new Error('secret value required');
  if (value.length > 8192) throw new Error('secret value too long');
  const r = await runCli(['secrets', 'set', bot, key], { stdin: value.trim() + '\n' });
  if (r.code !== 0) throw new Error(`secrets set failed (${r.code}): ${r.err || r.out}`);
  return { key, ok: true };
}

// Lock state via the CLI (`status --json` -> vault {mode, version, locked}):
// the cockpit never opens key.json or the unlock cache itself.
export async function lockState(bot) {
  const r = await runCli(['status', bot, '--json']);
  if (r.code !== 0) throw new Error(`status failed (${r.code}): ${r.err || r.out}`);
  let data;
  try { data = JSON.parse(r.out); } catch { throw new Error('status: CLI did not return JSON'); }
  const v = data && data.vault ? data.vault : {};
  return { mode: String(v.mode || 'none'), version: Number(v.version) || 1, locked: !!v.locked, detail: String(v.detail || '') };
}

// The operator's passphrase goes to `secrets unlock <bot>` on STDIN (never
// argv, never logged); the CLI's masked outcome is all that comes back. This
// is the ONLY unlock path besides the terminal - never a chat message.
export async function unlock(bot, passphrase) {
  if (typeof passphrase !== 'string' || !passphrase.trim()) throw new Error('passphrase required');
  if (passphrase.length > 1024) throw new Error('passphrase too long');
  const r = await runCli(['secrets', 'unlock', bot], { stdin: passphrase + '\n', timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`unlock failed (${r.code}): ${(r.err || r.out).trim().split(/\r?\n/)[0]}`);
  return { ok: true, out: r.out.trim() };
}

// Reads state/secret-access.jsonl directly (no CLI hop, no secret material in
// it either way): newest-first, filtered by bot, capped at `limit`.
export async function auditTail(bot, limit = 100) {
  const cap = Math.min(Math.max(1, Number(limit) || 100), 1000);
  let text;
  try { text = await fsp.readFile(SECRET_ACCESS_LOG, 'utf-8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  const filtered = bot ? rows.filter((r) => r && r.bot === bot) : rows;
  return filtered.slice(-cap).reverse();
}
