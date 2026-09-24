// cli.mjs - the cockpit's only write path: `node cli/botcorp.mjs <args>`.
//
// The cockpit has no liveness authority and never touches a vault, a bot.yaml
// or an access file itself. Start/stop/restart, secrets and pairing all go
// through the CLI (which is what the daemon and the operator's terminal use
// too), so there is exactly one implementation of each rule.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { BOTCORP_ROOT } from './bots.mjs';

const CLI = path.join(BOTCORP_ROOT, 'cli', 'botcorp.mjs');
const MAX_CAPTURE = 64 * 1024;

// Belt and braces: CLI output is shown in the UI, so scrub anything
// token-shaped before it leaves the server, even though the CLI masks.
const TOKEN_SHAPES = [
  /\b[0-9]{8,12}:AA[A-Za-z0-9_-]{33,}/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?!ant-)[A-Za-z0-9]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
];
export function scrub(text) {
  let t = String(text || '');
  for (const re of TOKEN_SHAPES) t = t.replace(re, '****');
  return t;
}

// Run the CLI; never throws. { code, out, err, timedOut }. `stdin` (a string)
// is written and closed - used for secret values so they never appear in argv.
export function runCli(args, { stdin = null, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false, timedOut = false;
    const finish = (code) => { if (!done) { done = true; resolve({ code, out: scrub(out).slice(0, 4096), err: scrub(err).slice(0, 4096), timedOut }); } };
    let child;
    try {
      child = spawn(process.execPath, [CLI, ...args], { cwd: BOTCORP_ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { return resolve({ code: -1, out: '', err: String(e.message || e), timedOut: false }); }
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch {} finish(-2); }, timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < MAX_CAPTURE) out += d; });
    child.stderr.on('data', (d) => { if (err.length < MAX_CAPTURE) err += d; });
    child.on('error', (e) => { clearTimeout(timer); err += String(e.message || e); finish(-1); });
    child.on('close', (code) => { clearTimeout(timer); finish(code ?? 0); });
    try {
      if (stdin !== null) child.stdin.end(stdin);
      else child.stdin.end();
    } catch {}
  });
}
