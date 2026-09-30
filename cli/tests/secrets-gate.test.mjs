// `secrets acl|migrate|lock|unlock` are operator verbs (code review
// 2026-09-30, L5): from a bot session they refuse with exit 3 before anything
// runs, like `secrets set|delete`. Run: node --test cli/tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'botcorp.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-secrets-gate-test-'));
const BOTS = path.join(TMP, 'bots');
fs.mkdirSync(path.join(BOTS, 'demo'), { recursive: true });
fs.writeFileSync(path.join(BOTS, 'demo', 'bot.yaml'), 'name: demo\nharness:\n  service: manual\n');
const base = { ...process.env, BOTCORP_HOME: path.join(TMP, 'rt'), BOTCORP_BOTS_DIR: BOTS, BOT_TG_MUTE: '1' };
for (const k of ['BOT_NAME', 'CLAUDECODE', 'BOTCORP_LAUNCH_ID']) delete base[k];
const cli = (env, input, ...args) => spawnSync(process.execPath, [CLI, ...args], { env, input, encoding: 'utf-8', timeout: 60_000 });

test('from a bot session: acl, migrate, lock and unlock refuse with exit 3', () => {
  for (const action of ['acl', 'migrate', 'lock', 'unlock']) {
    const r = cli({ ...base, BOT_NAME: 'demo', CLAUDECODE: '1' }, 'a-passphrase\n', 'secrets', action, 'demo');
    assert.equal(r.status, 3, `${action}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, new RegExp(`secrets ${action}: operator-only`));
  }
});

test('the operator passes the gate (unlock then stops at its own check: an empty passphrase)', () => {
  const r = cli(base, '\n', 'secrets', 'unlock', 'demo');
  assert.notEqual(r.status, 3, r.stderr);
  assert.match(r.stderr, /empty passphrase/);
});
