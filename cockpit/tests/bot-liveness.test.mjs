// Cockpit bot liveness (bots.mjs `liveness`): a bot runs when a pty-host OR a
// live claude --bg session runs it, measured the way `botcorp doctor` does
// (cli/_lib.mjs botLiveness / sessionAliveVerdict / bgBlockVerdict). The old
// cockpit read `running: !!pty`, so a bg bot always showed "stopped" and Start
// stayed enabled on a live session. Run: node --test cockpit/tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-liveness-test-'));
process.env.BOTCORP_HOME = path.join(TMP, 'rt');
const { liveness } = await import('../bots.mjs');

const BG_ID = 'a81bcdda';
const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
const cfgDirFor = (name) => fs.mkdtempSync(path.join(TMP, `${name}-`));
function jobRecord(cfgDir, job) {
  fs.mkdirSync(path.join(cfgDir, 'jobs', BG_ID), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'jobs', BG_ID, 'state.json'), JSON.stringify(job));
}
function botPid(cfgDir, pid) {
  fs.mkdirSync(path.join(cfgDir, 'channels', 'telegram'), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'channels', 'telegram', 'bot.pid'), `${pid}\n`);
}

test('a live bg session with no pty-host reads as running (the old !!pty read stopped)', async () => {
  const cfgDir = cfgDirFor('bg');
  const state = { status: 'running', claude_pid: process.pid, bg_id: BG_ID, session_id: 'S1' };
  const pty = null;
  const live = await liveness('bg', {}, state, pty, cfgDir);
  assert.equal(live.running, true);
  assert.equal(live.pid, process.pid);
  assert.equal(live.down, null);
  assert.equal(live.blocked, null, 'no job record: cannot tell, so not blocked');
  assert.equal(live.poller, null, 'telegram module off: no poller state');
  // the pre-fix expression on the same fixture: this is what shipped
  assert.equal(!!pty, false);
});

test('blocked: the job record waits on a person (doctor `session not blocked`)', async () => {
  const cfgDir = cfgDirFor('blocked');
  const state = { status: 'running', claude_pid: process.pid, bg_id: BG_ID };
  jobRecord(cfgDir, { tempo: 'blocked', needs: 'approve config change 825a64 in cockpit' });
  const live = await liveness('blocked', {}, state, null, cfgDir);
  assert.equal(live.running, true);
  assert.equal(live.blocked.needs, 'approve config change 825a64 in cockpit');
  assert.match(live.blocked.detail, /waits on/);
  // idle between prompts is not blocked
  jobRecord(cfgDir, { tempo: 'blocked', needs: 'send a prompt to start' });
  assert.equal((await liveness('blocked', {}, state, null, cfgDir)).blocked, null);
  jobRecord(cfgDir, { tempo: 'working', needs: '' });
  assert.equal((await liveness('blocked', {}, state, null, cfgDir)).blocked, null);
});

test('state says running but its claude is gone: stopped, with the doctor reason', async () => {
  const cfgDir = cfgDirFor('dead');
  jobRecord(cfgDir, { tempo: 'blocked', needs: 'approve something' });
  const live = await liveness('dead', {}, { status: 'running', claude_pid: deadPid, bg_id: BG_ID }, null, cfgDir);
  assert.equal(live.running, false);
  assert.equal(live.pid, null);
  assert.match(live.down, /no live claude process/);
  assert.equal(live.blocked, null, 'a dead session is not reported as waiting');
  const never = await liveness('never', {}, null, null, cfgDirFor('never'));
  assert.equal(never.running, false);
  assert.equal(never.down, null);
});

test('a pty-host still counts as running', async () => {
  const live = await liveness('pty', {}, null, { pid: process.pid, ptyPid: 4242, port: 1, token: 't' }, cfgDirFor('pty'));
  assert.equal(live.running, true);
  assert.equal(live.pid, 4242);
});

test('telegram: OWNED only with bot.pid alive under the session; a dead poller is not up', async () => {
  const cfg = { harness: { modules: { telegram: true } } };
  const state = { status: 'running', claude_pid: process.pid, bg_id: BG_ID, poller: 'OWNED' };
  const dead = cfgDirFor('tgdead');
  botPid(dead, deadPid);
  assert.deepEqual((await liveness('tgdead', cfg, state, null, dead)).poller, { state: 'DEAD', up: false });
  const owned = cfgDirFor('tgowned');
  botPid(owned, process.pid);
  // the process tree is read (off the event loop) only for this answer
  assert.deepEqual((await liveness('tgowned', cfg, state, null, owned)).poller, { state: 'OWNED', up: true });
  const stopped = await liveness('tgowned', cfg, { ...state, claude_pid: deadPid }, null, owned);
  assert.equal(stopped.poller.up, false, 'a poller with no session is an orphan, not up');
});
