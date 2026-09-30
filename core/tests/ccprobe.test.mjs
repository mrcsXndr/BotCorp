// core/ccprobe.mjs over stream-json lines recorded from the pinned Claude Code
// 2.1.285 (no token): the control responses parse, the models normalise with
// their price and effort levels, a full id is asked by its alias, and the
// cache is keyed by the pin's sha256. Run: node --test core/tests/ccprobe.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccprobe-test-'));
process.env.BOTCORP_HOME = RT;
const { parseControlLine, parseModels, aliasOf, priceOf, ccModels } = await import('../ccprobe.mjs');

const LINES = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cc-2.1.285-probe.jsonl'), 'utf-8').split('\n').filter(Boolean);
const R = LINES.map(parseControlLine);

test('control responses parse; every other stream line is ignored', () => {
  assert.equal(R[0], null);
  assert.deepEqual(R.slice(1).map((r) => [r.id, r.ok]), [['botcorp-1', true], ['botcorp-2', true], ['botcorp-3', true], ['botcorp-4', false], ['botcorp-5', true]]);
  assert.match(R[4].error, /Unable to validate model/);
  assert.equal(parseControlLine('not json'), null);
});

test('the initialize models normalise with price, effort levels and an alias', () => {
  const models = parseModels(R[1].response);
  assert.deepEqual(models.map((m) => m.value), ['default', 'opus', 'claude-fable-5-1', 'sonnet', 'haiku']);
  const opus = models.find((m) => m.value === 'opus');
  assert.ok(opus.supportedEffortLevels.includes('max'));
  assert.deepEqual(opus.price, { input: 4, output: 20 });
  const haiku = models.find((m) => m.value === 'haiku');
  assert.deepEqual(haiku.supportedEffortLevels, []);
  assert.equal(haiku.resolvedModel, 'claude-haiku-4-5-20251001');
  assert.equal(aliasOf(models.find((m) => m.value === 'claude-fable-5-1')), 'fable');
  assert.equal(aliasOf(opus), 'opus');
  assert.equal(priceOf('no price here'), null);
  assert.deepEqual(parseModels({ models: [{ value: 1 }, null, 'x'] }), []);
});

test('ccModels caches per pin sha256 and fails closed', async () => {
  const exe = path.join(RT, 'claude.exe');
  fs.writeFileSync(exe, '');
  let probes = 0;
  const probe = async ({ version }) => { probes++; return { cc_version: version, models: parseModels(R[1].response), probed_at: 'now' }; };
  const pin = { version: '2.1.285', exe, sha256: 'aaa' };
  assert.equal((await ccModels({ pin, probe })).models.length, 5);
  assert.equal((await ccModels({ pin, probe })).cached, true);
  assert.equal(probes, 1);
  await ccModels({ pin: { ...pin, sha256: 'bbb' }, probe });   // re-pinned binary: asked again
  assert.equal(probes, 2);
  await ccModels({ pin: { ...pin, sha256: 'bbb' }, probe, refresh: true });
  assert.equal(probes, 3);
  assert.deepEqual((await ccModels({ pin: null, probe })).models, []);
  const gone = await ccModels({ pin: { ...pin, exe: path.join(RT, 'nope.exe') }, probe });
  assert.deepEqual(gone.models, []);
  assert.match(gone.error, /missing/);
  const failed = await ccModels({ pin: { ...pin, sha256: 'ccc' }, probe: async () => ({ cc_version: '2.1.285', models: [], error: 'boom' }) });
  assert.equal(failed.error, 'boom');
});
