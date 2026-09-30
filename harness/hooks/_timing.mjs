// _timing.mjs - one line per hook run, for `botcorp doctor` (p50/p95 per hook
// against its hooks.json timeout): run.mjs and guard.mjs append
//   {"ts", "hook", "ms", "rc", "timed_out"?}
// to <rt>/state/<bot>/hooks-timing.jsonl. In process, no extra spawn,
// fail-open. Only into a state dir that exists (the daemon's automations pass
// creates it every tick), so a retired bot or a hand run leaves no debris.
// Bounded: once the file passes MAX_BYTES it is cut to the last KEEP lines,
// once per few thousand runs, never a rewrite per run.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TIMING_FILE = 'hooks-timing.jsonl';
const KEEP = 2000;
const MAX_BYTES = 256 * 1024;

export function recordTiming(hook, ms, rc, timedOut = false, env = process.env) {
  try {
    if (!env.BOT_NAME) return;
    const dir = path.join(env.BOTCORP_HOME || path.join(os.homedir(), '.botcorp'), 'state', env.BOT_NAME);
    if (!fs.existsSync(dir)) return;
    const file = path.join(dir, TIMING_FILE);
    const rec = { ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), hook, ms: Math.round(ms), rc: rc ?? null };
    if (timedOut) rec.timed_out = true;
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    if (fs.statSync(file).size <= MAX_BYTES) return;
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).slice(-KEEP);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, lines.join('\n') + '\n');
      fs.renameSync(tmp, file);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  } catch {}
}
