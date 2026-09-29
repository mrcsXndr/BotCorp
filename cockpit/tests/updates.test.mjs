// The Releases panel's order: newest first by date, version breaks a tie, an
// undated entry goes last; listUpdates marks the installed release `current`.
// Run: node --test cockpit/tests/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-updates-test-'));
process.env.BOTCORP_HOME = path.join(TMP, 'rt');
process.env.BOTCORP_BOTS_DIR = path.join(TMP, 'bots');
const { sortReleases, listUpdates, installedVersion } = await import('../updates.mjs');

const tags = (list) => list.map((r) => r.tag);

test('newest first by date, not by the order the file holds them', () => {
  const rel = [{ tag: 'v0.2.7', date: '2026-09-20' }, { tag: 'v0.1.11', date: '2026-08-01' }, { tag: 'v0.2.8', date: '2026-09-25' }];
  assert.deepEqual(tags(sortReleases(rel)), ['v0.2.8', 'v0.2.7', 'v0.1.11']);
});

test('a missing or bad date sorts last; the version breaks a tie', () => {
  const rel = [{ tag: 'v0.3.0', date: null }, { tag: 'v0.2.9', date: '2026-09-25' }, { tag: 'v0.2.10', date: '2026-09-25' }, { tag: 'v0.1.0', date: 'soon' }];
  assert.deepEqual(tags(sortReleases(rel)), ['v0.2.10', 'v0.2.9', 'v0.3.0', 'v0.1.0']);
});

test('the input is left alone', () => {
  const rel = [{ tag: 'v0.1.0', date: '2026-01-01' }, { tag: 'v0.2.0', date: '2026-02-01' }];
  sortReleases(rel);
  assert.deepEqual(tags(rel), ['v0.1.0', 'v0.2.0']);
});

test('listUpdates returns them sorted, with the installed one marked current', async () => {
  const installed = await installedVersion();
  assert.ok(installed, 'botcorp.json has a version');
  fs.mkdirSync(path.join(TMP, 'rt', 'state'), { recursive: true });
  const releases = [{ tag: 'v0.0.1', date: '2020-01-01', status: 'applied' }, { tag: `v${installed}`, date: '2026-09-29', status: 'applied' }, { tag: 'v99.0.0', date: '2099-01-01', status: 'pending' }];
  fs.writeFileSync(path.join(TMP, 'rt', 'state', 'updates.json'), JSON.stringify({ releases }));
  const r = await listUpdates();
  assert.deepEqual(tags(r.releases), ['v99.0.0', `v${installed}`, 'v0.0.1']);
  assert.deepEqual(r.releases.map((x) => [x.older, x.current]), [[false, false], [true, true], [true, false]]);
});
