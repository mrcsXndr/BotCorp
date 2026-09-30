// The state files the CLI and the daemon both rewrite (code review 2026-09-30,
// L3): writes are atomic (unique temp file + rename, retried while a reader
// holds the file), and a read tells "absent" from "exists but torn", so a
// read-modify-write never rebuilds state/<bot>.json from nothing.
// Run: node --test cli/tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '_lib.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-state-test-'));
process.env.BOTCORP_HOME = path.join(TMP, 'rt');
const { readJsonState, writeJsonAtomic } = await import(pathToFileURL(LIB).href);

test('readJsonState: absent is undefined, a good file its value, a torn one an error that leaves it as it is', () => {
  const f = path.join(TMP, 'demo.json');
  assert.equal(readJsonState(f), undefined);
  writeJsonAtomic(f, { bot: 'demo', bg_id: 'abc', claude_pid: 42 });
  assert.deepEqual(readJsonState(f), { bot: 'demo', bg_id: 'abc', claude_pid: 42 });
  const torn = '{\n  "bot": "demo",\n  "bg_id": "ab';
  fs.writeFileSync(f, torn);
  assert.throws(() => readJsonState(f, { tries: 2, waitMs: 1 }), /exists but does not read as JSON/);
  assert.equal(fs.readFileSync(f, 'utf-8'), torn, 'the torn file is left for its writer to finish');
  fs.writeFileSync(f, '');
  assert.throws(() => readJsonState(f, { tries: 2, waitMs: 1 }), /does not read as JSON/, 'an empty file is not "absent"');
});

test('writeJsonAtomic: two writers and a reader at once; every read parses, no temp file is left', async () => {
  const f = path.join(TMP, 'shared.json');
  writeJsonAtomic(f, { n: 0 });
  const big = 'x'.repeat(20_000);   // a write that takes long enough to be caught half done
  const writer = (id) => spawn(process.execPath, ['--input-type=module', '-e',
    `const { writeJsonAtomic } = await import(${JSON.stringify(pathToFileURL(LIB).href)});
     for (let i = 0; i < 150; i++) writeJsonAtomic(${JSON.stringify(f)}, { n: i, by: ${id}, pad: ${JSON.stringify(big)} });`],
  { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
  const ws = [writer(1), writer(2)];
  const errs = [];
  for (const w of ws) w.stderr.on('data', (d) => errs.push(String(d)));
  const done = Promise.all(ws.map((w) => new Promise((r) => w.on('exit', r))));
  let reads = 0, running = true;
  done.then(() => { running = false; });
  while (running) {
    const v = readJsonState(f);
    assert.equal(typeof v.n, 'number');
    reads++;
    await new Promise((r) => setImmediate(r));
  }
  const codes = await done;
  assert.deepEqual(codes, [0, 0], errs.join(''));
  assert.ok(reads > 5, `the reader ran alongside (${reads} reads)`);
  assert.deepEqual(fs.readdirSync(TMP).filter((n) => n.startsWith('shared.json.')), [], 'no temp file left');
});
