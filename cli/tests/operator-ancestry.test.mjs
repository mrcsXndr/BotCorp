// Operator verbs check the caller's process ancestry, not only env markers a
// bot can strip (code review 2026-09-30, finding 4, CLI half): `env -u BOT_NAME
// -u CLAUDECODE botcorp approve ...` from inside a bot's session is refused,
// because the session's recorded claude process is among its parents.
// A stand-in session: node.exe linked as claude.exe, recording its own pid as
// the bot's claude_pid, then running the CLI with the markers removed.
// Run: node --test cli/tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'botcorp.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-ancestry-test-'));
const RT = path.join(TMP, 'rt');
const BOTS = path.join(TMP, 'bots');
for (const b of ['demo', 'other']) {
  fs.mkdirSync(path.join(BOTS, b), { recursive: true });
  fs.writeFileSync(path.join(BOTS, b, 'bot.yaml'), `name: ${b}\nharness:\n  service: manual\n`);
}
fs.mkdirSync(path.join(RT, 'state'), { recursive: true });
const env = { ...process.env, BOTCORP_HOME: RT, BOTCORP_BOTS_DIR: BOTS, BOT_TG_MUTE: '1' };
for (const k of ['BOT_NAME', 'CLAUDECODE', 'BOTCORP_LAUNCH_ID']) delete env[k];   // what `env -u` leaves

function standIn(name) {
  const exe = path.join(TMP, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
  if (!fs.existsSync(exe)) { try { fs.linkSync(process.execPath, exe); } catch { fs.copyFileSync(process.execPath, exe); } }
  return exe;
}
// The stand-in session records itself as demo's claude, then runs the CLI as its child.
function underSession(image, ...args) {
  const script = `
    const fs = require('fs'), { spawnSync } = require('child_process');
    fs.writeFileSync(${JSON.stringify(path.join(RT, 'state', 'demo.json'))}, JSON.stringify({ bot: 'demo', claude_pid: process.pid, bg_id: 'abc123' }));
    const r = spawnSync(${JSON.stringify(process.execPath)}, ${JSON.stringify([CLI, ...args])}, { encoding: 'utf-8', timeout: 120000 });
    process.stdout.write(JSON.stringify({ status: r.status, stderr: r.stderr, stdout: r.stdout }));`;
  const r = spawnSync(standIn(image), ['-e', script], { env, encoding: 'utf-8', timeout: 180_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('an operator verb from under a bot session, its env markers stripped: refused (exit 3), naming the session', () => {
  const r = underSession('claude', 'approve', 'demo', 'abc123');
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /runs under demo's session/);
  const s = underSession('claude', 'secrets', 'lock', 'demo');
  assert.equal(s.status, 3, s.stdout + s.stderr);
});

test('controlling another bot from under a session is refused; the bot itself is still its own', () => {
  const r = underSession('claude', 'stop', 'other');
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /operator-only/);
  const own = underSession('claude', 'start', 'demo', '--dry-run');   // (not stop: it would kill the stand-in session)
  assert.notEqual(own.status, 3, own.stdout + own.stderr);
});

test('positive control: the same recorded pid on a process that is not a claude one is no session (the operator)', () => {
  const r = underSession('helper', 'approve', 'demo', 'abc123');
  assert.notEqual(r.status, 3, r.stderr);
  assert.match(r.stderr, /no pending entry abc123/);
});
