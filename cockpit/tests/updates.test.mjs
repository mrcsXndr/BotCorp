// The Updates page's data: newest first by version, the installed release
// marked `current`, and each release's notes: the stored ones, else the
// installed CHANGELOG.md's section (an entry from before v0.8.2 held only
// what/why/value, which the page showed as "(none given)").
// Run: node --test cockpit/tests/*.test.mjs (Node 25: pass the files, not the folder)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-updates-test-'));
process.env.BOTCORP_HOME = path.join(TMP, 'rt');
process.env.BOTCORP_BOTS_DIR = path.join(TMP, 'bots');
const { sortReleases, listUpdates, installedVersion } = await import('../updates.mjs');
const { releaseNotes } = await import('../../core/changelog.mjs');
const CL = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'CHANGELOG.md'), 'utf-8');

const tags = (list) => list.map((r) => r.tag);
const write = (releases) => {
  fs.mkdirSync(path.join(TMP, 'rt', 'state'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'rt', 'state', 'updates.json'), JSON.stringify({ releases }));
};

test('newest first by version, not by date and not by the order the file holds them', () => {
  const rel = [{ tag: 'v0.2.7', date: '2026-09-20' }, { tag: 'v0.1.11', date: '2026-09-26' }, { tag: 'v0.2.8', date: '2026-09-25' }];
  assert.deepEqual(tags(sortReleases(rel)), ['v0.2.8', 'v0.2.7', 'v0.1.11']);
});

test('listUpdates returns them sorted, with the installed one marked current and the view split', async () => {
  const installed = await installedVersion();
  assert.ok(installed, 'botcorp.json has a version');
  write([{ tag: 'v0.0.1', date: '2020-01-01', status: 'applied' }, { tag: `v${installed}`, date: '2026-09-29', status: 'applied' }, { tag: 'v99.0.0', date: '2099-01-01', status: 'pending' }]);
  const r = await listUpdates();
  assert.deepEqual(tags(r.releases), ['v99.0.0', `v${installed}`, 'v0.0.1']);
  assert.deepEqual(r.releases.map((x) => [x.older, x.current]), [[false, false], [true, true], [true, false]]);
  assert.equal(r.current.tag, `v${installed}`);
  assert.deepEqual(tags(r.available), ['v99.0.0']);
  assert.deepEqual(tags(r.history), ['v0.0.1']);
});

test('notes: stored ones win; a pre-v0.8.2 entry (what/why/value only) reads its section of the installed CHANGELOG.md', async () => {
  write([
    { tag: 'v0.8.0', status: 'applied', what: ['A limit is recognised as a limit. A bg session blocked on its 5-hour or'], why: ['see changelog'], value: ['see changelog'] },
    { tag: 'v0.7.8', status: 'applied', summary: 'Stored summary.', notes: [{ title: 'T', text: 'x' }], notes_tail: 'Upgrading: y' },
    { tag: 'v99.0.0', status: 'pending', what: ['a truncated first line of'] },
  ]);
  const r = await listUpdates();
  const get = (t) => r.releases.find((x) => x.tag === t);
  const want = releaseNotes(CL, 'v0.8.0');
  assert.equal(get('v0.8.0').summary, want.summary);
  assert.deepEqual(get('v0.8.0').notes, want.notes);
  assert.ok(get('v0.8.0').notes.length > 3 && !('what' in get('v0.8.0')));
  assert.deepEqual([get('v0.7.8').summary, get('v0.7.8').notes, get('v0.7.8').tail], ['Stored summary.', [{ title: 'T', text: 'x' }], 'Upgrading: y']);
  // not in the installed changelog and nothing stored: no notes, never the truncated line
  assert.deepEqual([get('v99.0.0').summary, get('v99.0.0').notes], ['', []]);
});

test('the installed version with no entry of its own still gets its notes', async () => {
  const installed = await installedVersion();
  write([{ tag: 'v99.0.0', status: 'pending' }]);
  const r = await listUpdates();
  assert.equal(r.current.synthetic, true);
  const want = releaseNotes(CL, `v${installed}`);
  if (want.found) assert.equal(r.current.summary, want.summary);
});
