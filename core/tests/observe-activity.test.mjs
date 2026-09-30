// core/observe.mjs: a fresh job record with tempo 'active' reads working, ahead
// of a breakpoint and a quiet transcript (D7, D12). Run: node --test core/tests/observe-activity.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activityOf, jobFileActive, QUIET_MIN } from '../observe.mjs';

const QUIET = (QUIET_MIN + 10) * 60_000;

test('a turn in progress is working over a fresh breakpoint and a quiet transcript', () => {
  assert.equal(activityOf({ alive: true, breakpoint: true, quietMs: QUIET, active: true }), 'working');
  assert.equal(activityOf({ alive: true, breakpoint: false, quietMs: QUIET, active: true }), 'working');
  // without it the old rules stand
  assert.equal(activityOf({ alive: true, breakpoint: true, quietMs: 0 }), 'idle');
  assert.equal(activityOf({ alive: true, quietMs: QUIET }), 'idle');
  // a hard block and a dead session still win
  assert.equal(activityOf({ alive: true, blocked: true, active: true }), 'blocked');
  assert.equal(activityOf({ alive: false, active: true }), 'down');
});

test('jobFileActive: only tempo active in a record written within 30 min', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-job-'));
  try {
    const f = path.join(dir, 'state.json');
    fs.writeFileSync(f, '{}');
    const now = Date.now();
    assert.equal(jobFileActive(f, { tempo: 'active', state: 'working' }, now), true);
    assert.equal(jobFileActive(f, { tempo: 'idle', state: 'working' }, now), false, 'state working alone is not a turn');
    assert.equal(jobFileActive(f, { tempo: 'active' }, now + 31 * 60_000), false, 'a stale record is not trusted');
    assert.equal(jobFileActive(path.join(dir, 'missing.json'), { tempo: 'active' }, now), false);
    assert.equal(jobFileActive(null, null, now), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
