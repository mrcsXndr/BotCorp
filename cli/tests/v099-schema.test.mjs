// v0.9.9 bot.yaml schema: `effort` is one of Claude Code's levels, `ultracode`
// is a boolean, `fable` is a model alias, an automation carries a one-line
// `description`, and a bot sets `automations.<n>.description` /
// `tools.<n>.purpose` itself (words, not capability). A real CLI over a
// throwaway BOTCORP_HOME / BOTCORP_BOTS_DIR.
// Run: node --test cli/tests/v099-schema.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validate, loadBotYaml } from '../../daemon/botyaml.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'botcorp.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-v099-schema-'));
const RT = path.join(TMP, 'rt');
const BOTS = path.join(TMP, 'bots');
const HOME = path.join(BOTS, 'demo');
const YAML = [
  'name: demo',
  'harness:',
  '  service: manual',
  '  modules:',
  '    telegram: false',
  'automations:',
  '  - name: nightly',
  '    command: node tools/nightly.mjs',
  '    trigger: { interval_min: 1440 }',
  'tools:',
  '  - name: x',
  '    path: tools/x.py',
  '    kind: cli',
  '',
].join('\n');
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, 'bot.yaml'), YAML);

const base = { ...process.env, BOTCORP_HOME: RT, BOTCORP_BOTS_DIR: BOTS, BOT_TG_MUTE: '1' };
for (const k of ['BOT_NAME', 'CLAUDECODE', 'BOTCORP_LAUNCH_ID']) delete base[k];
const AS_BOT = { ...base, BOT_NAME: 'demo', CLAUDECODE: '1' };
const cli = (env, ...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf-8', timeout: 60_000 });
const yaml = () => fs.readFileSync(path.join(HOME, 'bot.yaml'), 'utf-8');
const queue = () => { try { return JSON.parse(fs.readFileSync(path.join(RT, 'state', 'demo.approvals.json'), 'utf-8')); } catch { return []; } };
const errsOf = (extra) => {
  const f = path.join(TMP, 'v.yaml');
  fs.writeFileSync(f, `name: v\n${extra}\n`);
  return validate(loadBotYaml(f));
};

test('effort: a Claude Code level or null; a typo is refused', () => {
  for (const ok of ['low', 'medium', 'high', 'xhigh', 'max', 'null']) assert.deepEqual(errsOf(`effort: ${ok}`), [], ok);
  assert.ok(errsOf('effort: hgih').some((e) => e.startsWith('effort:')));
  const r = cli(base, 'config', 'set', 'demo', 'effort', 'hgih');
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /effort: low \| medium \| high \| xhigh \| max/);
  assert.doesNotMatch(yaml(), /hgih/);
});

test('ultracode: a boolean; fable is a model alias', () => {
  assert.deepEqual(errsOf('ultracode: true'), []);
  assert.ok(errsOf('ultracode: yes please').some((e) => e.startsWith('ultracode:')));
  assert.deepEqual(errsOf('model: fable'), []);
});

test('ultracode from a bot queues; from the operator it applies', () => {
  const r = cli(AS_BOT, 'config', 'set', 'demo', 'ultracode', 'true');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /queued for operator approval/);
  assert.ok(queue().some((e) => e.path === 'ultracode'));
  const o = cli(base, 'config', 'set', 'demo', 'ultracode', 'true');
  assert.equal(o.status, 0, o.stdout + o.stderr);
  assert.match(yaml(), /^ultracode: true$/m);
  // sync writes it into the generated settings only while it is on
  const settings = () => JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf-8'));
  assert.equal(settings().ultracode, true);
  assert.equal(cli(base, 'config', 'set', 'demo', 'ultracode', 'false').status, 0);
  assert.ok(!('ultracode' in settings()));
});

test('a bot sets a description and a purpose itself, as text', () => {
  const d = cli(AS_BOT, 'config', 'set', 'demo', 'automations.nightly.description', 'Rolls the logs at night');
  assert.equal(d.status, 0, d.stdout + d.stderr);
  assert.match(d.stdout, /\(applied/);
  const p = cli(AS_BOT, 'config', 'set', 'demo', 'tools.x.purpose', 't');
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.match(p.stdout, /\(applied/);
  const n = cli(AS_BOT, 'config', 'set', 'demo', 'tools.x.purpose', '42');
  assert.match(n.stdout, /\(applied/);
  const cfg = loadBotYaml(path.join(HOME, 'bot.yaml'));
  assert.equal(cfg.automations[0].description, 'Rolls the logs at night');
  assert.equal(cfg.tools[0].purpose, '42');
  assert.ok(!queue().some((e) => /description|purpose/.test(e.path)));
});

test('a description over 200 characters is refused', () => {
  const r = cli(base, 'config', 'set', 'demo', 'automations.nightly.description', 'x'.repeat(201));
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(errsOf('automations:\n  - name: a\n    command: x\n    trigger: { interval_min: 5 }\n    description: ' + 'y'.repeat(201)).some((e) => /description/.test(e)));
});
