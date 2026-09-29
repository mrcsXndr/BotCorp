// core/releases.mjs: newest first by version, and releases read as cumulative
// against the installed version. The fixture is the operator's host on
// 2026-09-29 (TG 10838): installed v0.7.7, v0.7.8 pending, v0.8.0
// apply_requested, v0.8.1 pending, plus the v0.2.x / v0.3.0 entries the daemon
// recorded long ago. Run: node --test core/tests/releases.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortReleases, releaseView, cmpVersion, isOlder } from '../releases.mjs';

const OPERATOR = [
  { tag: 'v0.2.11', status: 'pending', date: '2026-09-25T13:03:57+02:00' },
  { tag: 'v0.2.12', status: 'pending', date: '2026-09-25T13:16:18+02:00' },
  { tag: 'v0.1.15', status: 'applied', date: '2026-09-25T13:40:22+02:00' },
  { tag: 'v0.2.13', status: 'pending', date: '2026-09-25T13:49:06+02:00' },
  { tag: 'v0.3.0', status: 'applied', date: '2026-09-26T12:41:43+02:00' },
  { tag: 'v0.7.8', status: 'pending', date: '2026-09-29T15:16:42+02:00' },
  { tag: 'v0.8.0', status: 'apply_requested', date: '2026-09-29T16:51:51+02:00' },
  { tag: 'v0.8.1', status: 'pending', date: '2026-09-29T18:27:29+02:00' },
];
const tags = (l) => l.map((r) => r.tag);
const by = (l, t) => l.find((r) => r.tag === t);

test('sortReleases: by version, newest first, whatever the dates say (a v0.1.x hotfix tagged later sorts below v0.2.x)', () => {
  assert.deepEqual(tags(sortReleases(OPERATOR)), ['v0.8.1', 'v0.8.0', 'v0.7.8', 'v0.3.0', 'v0.2.13', 'v0.2.12', 'v0.2.11', 'v0.1.15']);
  assert.deepEqual(tags(sortReleases([{ tag: 'v0.2.10' }, { tag: 'v0.2.9' }, { tag: 'v0.10.0' }])), ['v0.10.0', 'v0.2.10', 'v0.2.9']);
  const input = [{ tag: 'v0.1.0' }, { tag: 'v0.2.0' }];
  sortReleases(input);
  assert.deepEqual(tags(input), ['v0.1.0', 'v0.2.0'], 'the input is left alone');
  assert.ok(cmpVersion('v0.8.10', 'v0.8.9') > 0 && isOlder('v0.7.7', '0.7.7') && !isOlder('v0.7.8', '0.7.7') && !isOlder('v1.0.0', null));
});

test('the operator\'s case: installed on top, the request, the one after it, and the one it will include', () => {
  const v = releaseView(OPERATOR, '0.7.7');
  assert.deepEqual(v.current, { tag: 'v0.7.7', synthetic: true, view: 'installed', actions: [] });
  assert.deepEqual(v.available.map((r) => [r.tag, r.view, r.included_in || null, r.actions]), [
    ['v0.8.1', 'available', null, ['apply', 'skip']],
    ['v0.8.0', 'requested', null, ['cancel']],
    ['v0.7.8', 'will_be_included', 'v0.8.0', []],   // no Apply / Skip: v0.8.0 carries it
  ]);
  // the old ones sit behind History, newest first, each with a roll back and what carried it in
  assert.deepEqual(v.history.map((r) => [r.tag, r.view, r.included_in, r.actions]), [
    ['v0.3.0', 'history', null, ['rollback']],
    ['v0.2.13', 'history', 'v0.3.0', ['rollback']],
    ['v0.2.12', 'history', 'v0.3.0', ['rollback']],
    ['v0.2.11', 'history', 'v0.3.0', ['rollback']],
    ['v0.1.15', 'history', null, ['rollback']],
  ]);
});

test('after the apply lands: v0.8.0 installed, v0.7.8 included in it, v0.8.1 the only thing to apply', () => {
  const after = OPERATOR.map((r) => (r.tag === 'v0.8.0' ? { ...r, status: 'applied' } : r.tag === 'v0.7.8' ? { ...r, status: 'included', included_in: 'v0.8.0' } : r));
  const v = releaseView(after, '0.8.0');
  assert.equal(v.current.tag, 'v0.8.0');
  assert.equal(v.current.synthetic, undefined);
  assert.deepEqual(v.available.map((r) => [r.tag, r.view, r.actions]), [['v0.8.1', 'available', ['apply', 'skip']]]);
  assert.deepEqual([by(v.history, 'v0.7.8').view, by(v.history, 'v0.7.8').included_in], ['history', 'v0.8.0']);
  assert.ok(v.history.every((r) => r.actions.join() === 'rollback'));
});

test('no request: the newest pending is the one to apply; the ones below it come with it (Apply kept, to stop there)', () => {
  const rel = [{ tag: 'v1.2.0', status: 'pending' }, { tag: 'v1.1.0', status: 'pending' }, { tag: 'v1.0.1', status: 'failed' }];
  const v = releaseView(rel, '1.0.0');
  assert.deepEqual(v.available.map((r) => [r.tag, r.view, r.included_in || null, r.actions]), [
    ['v1.2.0', 'available', null, ['apply', 'skip']],
    ['v1.1.0', 'comes_with', 'v1.2.0', ['apply']],
    ['v1.0.1', 'comes_with', 'v1.2.0', ['apply']],
  ]);
});

test('a skipped newest release leaves the next one as the head; a failed head offers a retry', () => {
  let v = releaseView([{ tag: 'v1.2.0', status: 'skipped' }, { tag: 'v1.1.0', status: 'pending' }, { tag: 'v1.0.1', status: 'pending' }], '1.0.0');
  assert.deepEqual(v.available.map((r) => [r.tag, r.view, r.actions]), [['v1.2.0', 'skipped', ['apply']], ['v1.1.0', 'available', ['apply', 'skip']], ['v1.0.1', 'comes_with', ['apply']]]);
  v = releaseView([{ tag: 'v1.1.0', status: 'failed' }], '1.0.0');
  assert.deepEqual(v.available.map((r) => [r.view, r.actions]), [['failed', ['apply']]]);
});

test('a roll back request reads as such in History and can be cancelled; the installed entry is used when recorded', () => {
  const v = releaseView([{ tag: 'v0.8.1', status: 'applied', summary: 's' }, { tag: 'v0.8.0', status: 'apply_requested', rollback: true }, { tag: 'v0.7.8', status: 'included', included_in: 'v0.8.0' }], '0.8.1');
  assert.equal(v.current.summary, 's');
  assert.deepEqual(v.history.map((r) => [r.tag, r.view, r.actions]), [['v0.8.0', 'rollback_requested', ['cancel']], ['v0.7.8', 'history', ['rollback']]]);
  assert.deepEqual(v.available, []);
});

test('an unknown installed version reads every release as newer; nothing crashes on junk', () => {
  const v = releaseView([{ tag: 'v1.0.0', status: 'pending' }, null, { status: 'pending' }], null);
  assert.equal(v.current, null);
  assert.deepEqual(tags(v.available), ['v1.0.0']);
  assert.deepEqual(v.history, []);
});
