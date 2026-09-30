// `botcorp import` never writes a repo, a vault or a config home out of a zip,
// in any case spelling (code review 2026-09-30, L2): NTFS is case-insensitive
// and drops trailing dots, so `.GIT/` or `.git./` IS `.git/`, and `.git::$INDEX_ALLOCATION`
// names it through an alternate data stream. A real CLI over a throwaway runtime.
// Run: node --test cli/tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { zipWrite } from '../_zip.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'botcorp.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-import-test-'));
const RT = path.join(TMP, 'rt');
const BOTS = path.join(TMP, 'bots');
fs.mkdirSync(BOTS, { recursive: true });
const env = { ...process.env, BOTCORP_HOME: RT, BOTCORP_BOTS_DIR: BOTS, BOT_TG_MUTE: '1' };
for (const k of ['BOT_NAME', 'CLAUDECODE', 'BOTCORP_LAUNCH_ID']) delete env[k];
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf-8', timeout: 120_000 });

function makeZip(file, names) {
  const src = path.join(TMP, 'src.txt');
  fs.writeFileSync(src, 'x\n');
  const yaml = path.join(TMP, 'bot.yaml');
  fs.writeFileSync(yaml, 'name: imp\nharness:\n  service: manual\n  modules:\n    telegram: false\n');
  zipWrite(file, [{ name: 'bot.yaml', file: yaml }, ...names.map((name) => ({ name, file: src }))]);
}

test('a repo, a vault or a config home in any spelling is dropped; look-alikes are kept', () => {
  const zip = path.join(TMP, 'a.zip');
  makeZip(zip, [
    '.GIT/hooks/pre-commit', '.git./config', '.Git /HEAD', '.Vault/secrets.json', '.VAULT./key.json',
    '.CLAUDE-Imp/settings.json', 'sub/.git/hooks/post-commit',
    '.gitignore', '.github/workflows/ci.yml', '.claude/settings.local.json', 'memory/notes.md',
  ]);
  const r = cli('import', zip, '--as', 'imp');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const home = path.join(BOTS, 'imp');
  const all = [];
  const walk = (d, pre = '') => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const rel = pre + e.name; if (e.isDirectory()) walk(path.join(d, e.name), rel + '/'); else all.push(rel); } };
  walk(home);
  // (sync/import write the bot's own .claude-imp/ afterwards: only the zip's files, content "x", count)
  const fromZip = all.filter((f) => fs.readFileSync(path.join(home, f), 'utf-8') === 'x\n');
  for (const bad of fromZip.filter((f) => /(^|\/)\.(git|vault)[. ]*\//i.test(f) || /^\.claude-/i.test(f))) assert.fail(`written: ${bad}`);
  for (const want of ['.gitignore', '.github/workflows/ci.yml', '.claude/settings.local.json', 'memory/notes.md']) assert.ok(all.includes(want), `kept: ${want} (${all.join(', ')})`);
});

test('an alternate-data-stream name is refused outright; nothing lands in a .git', () => {
  const zip = path.join(TMP, 'b.zip');
  makeZip(zip, ['.git::$INDEX_ALLOCATION/hooks/pre-commit']);
  const r = cli('import', zip, '--as', 'ads');
  assert.notEqual(r.status, 0, 'the import fails');
  assert.match(r.stderr, /unsafe entry name/);
  assert.equal(fs.existsSync(path.join(BOTS, 'ads', '.git')), false);
});
