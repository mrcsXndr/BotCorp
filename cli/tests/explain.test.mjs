// cli/explain.mjs: every kind of queued approval reads in plain words (who,
// what, why, what approve and decline do, when), and `approvals --json` carries
// it as `explain`. Run: node --test cli/tests/explain.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { explainApproval, whoOf } from '../explain.mjs';
import { DEFAULTS, deepMerge } from '../../daemon/botyaml.mjs';

const cfg = deepMerge(DEFAULTS, { name: 'demo', secrets: ['oauth_token'], account: 'main', role: null,
  integrations: { telegram: { dm_policy: 'allowlist' } },
  automations: [{ name: 'nightly', command: 'x', trigger: { interval_min: 60 }, enabled: false }],
  tools: [{ name: 'gh', path: 'tools/gh.py', kind: 'integration', enabled: false }] });
const ask = (e) => explainApproval('demo', cfg, { requested_by: 'bot:demo', ...e });

const CASES = [
  ['a new bot', { op: 'new', path: 'helper', value: {} }, /create a new bot: helper/],
  ['a secret (append)', { op: 'append', path: 'secrets', value: 'gh_token' }, /vault secret gh_token/],
  ['a secret (set)', { path: 'secrets', value: ['oauth_token', 'gh_token'] }, /vault secret gh_token in/],
  ['an automation', { op: 'append', path: 'automations', value: { name: 'poll', command: 'node p.mjs', trigger: { interval_min: 5 } } }, /add the automation poll \(runs node p\.mjs/],
  ['a tool', { op: 'append', path: 'tools', value: { name: 'hub', kind: 'integration', secrets: ['hub_token'] } }, /register the tool hub \(integration, secrets hub_token\)/],
  ['an automation back on', { path: 'automations.nightly.enabled', value: true }, /automation nightly back on/],
  ['an automation secret', { path: 'automations.nightly.secrets', value: ['gh_token'] }, /give the automation nightly the vault secret gh_token/],
  ['a tool back on', { path: 'tools.gh.enabled', value: true }, /tool gh back on/],
  ['an account', { path: 'account', value: 'spare' }, /the account spare instead of the account main/],
  ['backup accounts', { path: 'backup_accounts', value: ['a', 'b'] }, /fail over to a, b/],
  ['a role', { path: 'role', value: 'admin' }, /role: none -> admin/],
  ['a guard hook', { path: 'harness.hooks_disable', value: ['config-guard'] }, /guard hook config-guard/],
  ['a Telegram sender', { path: 'integrations.telegram.allow_from', value: ['12345'] }, /Telegram user 12345/],
  ['dm_policy', { path: 'integrations.telegram.dm_policy', value: 'pairing' }, /on Telegram: allowlist -> pairing/],
  ['bypass', { path: 'permissions', value: 'bypass' }, /without asking/],
  ['the registry', { path: 'harness.tools_registry', value: 'warn' }, /enforce to warn/],
  ['any other path', { path: 'backup.git_remote', value: 'https://x.example/r.git' }, /change backup\.git_remote to https/],
];

for (const [name, entry, what] of CASES) {
  test(`explains ${name}`, () => {
    const x = ask(entry);
    assert.match(x.what, what);
    for (const k of ['who', 'what', 'why', 'onApprove', 'onDecline', 'when']) assert.ok(typeof x[k] === 'string' && x[k].trim(), `${name}: ${k}`);
    assert.equal(x.who, 'demo (the bot itself)');
    assert.match(x.onDecline, /^Nothing changes; demo is told\.$/);
  });
}

test('a secret names the env it lands in', () => {
  assert.match(ask({ op: 'append', path: 'secrets', value: 'gh_token' }).onApprove, /injected as GH_TOKEN/);
});

test('who: the bot, another bot, the operator, an email', () => {
  assert.equal(whoOf('bot:demo', 'demo'), 'demo (the bot itself)');
  assert.equal(whoOf('bot:boss', 'demo'), 'boss (another bot)');
  assert.equal(whoOf('operator:someone', 'demo'), 'You');
  assert.equal(whoOf('local', 'demo'), 'You');
  assert.equal(whoOf('op@example.com', 'demo'), 'op@example.com');
  assert.equal(explainApproval('demo', cfg, { requested_by: 'operator:x', path: 'role', value: 'admin' }).onDecline, 'Nothing changes.');
});

test('approvals --json carries explain', () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-explain-'));
  const rt = path.join(TMP, 'rt'), bots = path.join(TMP, 'bots');
  fs.mkdirSync(path.join(bots, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(bots, 'demo', 'bot.yaml'), 'name: demo\nharness:\n  service: manual\n');
  fs.mkdirSync(path.join(rt, 'state'), { recursive: true });
  fs.writeFileSync(path.join(rt, 'state', 'demo.approvals.json'), JSON.stringify([{ id: 'abc123', ts: '2026-10-01T00:00:00Z', op: 'append', path: 'secrets', value: 'gh_token', requested_by: 'bot:demo', reason: 'declares a new vault secret' }]));
  const env = { ...process.env, BOTCORP_HOME: rt, BOTCORP_BOTS_DIR: bots };
  const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'botcorp.mjs');
  const r = spawnSync(process.execPath, [CLI, 'approvals', '--json'], { env, encoding: 'utf-8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  const [row] = JSON.parse(r.stdout);
  assert.equal(typeof row.explain.onApprove, 'string');
  assert.ok(row.explain.onApprove && row.explain.onDecline);
  assert.match(row.explain.what, /gh_token/);
});
