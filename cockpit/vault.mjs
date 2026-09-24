// vault.mjs - thin, masked-only view of a bot's vault.
//
// The vault (bots/<name>/.vault/secrets.json, DPAPI) is never read by the
// cockpit. Listing shells out to `botcorp secrets list <bot> --json`, which
// returns MASKED entries; setting pipes the value to `botcorp secrets set
// <bot> <key>` on STDIN (never argv: process listings show argv). Nothing
// here can return a secret value, and the request body is never logged.

import { runCli } from './cli.mjs';

const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;

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
