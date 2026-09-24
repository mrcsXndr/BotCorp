#!/usr/bin/env node
// statusline.js — model, git, context %, cost, rate limits, TG health, harness version.
//
// Renders one line from Claude Code's statusline stdin JSON, and on every
// render also writes <config_home>/botcorp/status.json — the file the daemon
// and the TG status footer read instead of each re-deriving the same numbers.
//
// Cost and rate limits come straight from stdin (j.cost, j.rate_limits) — this
// used to scan every session transcript under ~/.claude/projects to compute a
// lifetime cost estimate, which is slow (grows without bound) and duplicates
// what Claude Code already reports for the current session. Deleted; the
// number shown here is this session's cost, not a lifetime total.
//
// Usage: statusline.js [--dump <path>]   (--dump also appends the raw stdin
// JSON as one line to <path>, for capturing a real payload once.)
// Root package.json declares "type": "module" for the whole tree, so this
// file (kept as .js — Claude Code's statusLine config points at this exact
// path) must be real ESM rather than CommonJS `require`.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

function harnessVersion() {
  try {
    const p = path.join(__dirname, '..', '..', '.claude-plugin', 'plugin.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return j.version || '?';
  } catch (e) {
    return '?';
  }
}

// TG channel health: green if the plugin's bot.pid process is alive, red otherwise.
// Only shown for the instance that OWNS the TG poller — set BOT_HAS_TG=0 when a
// foreign owner holds the poll slot (this instance launched without --channels).
// Unset => legacy/unknown, keep showing it.
function tgStatus() {
  if (process.env.BOT_HAS_TG === '0') return '';
  try {
    const pidFile = path.join(CONFIG_HOME, 'channels', 'telegram', 'bot.pid');
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (!pid) return 'TG\u{1F534}';
    process.kill(pid, 0); // throws ESRCH if dead, EPERM if alive-but-not-ours (still alive)
    return 'TG\u{1F7E2}';
  } catch (e) {
    if (e && e.code === 'EPERM') return 'TG\u{1F7E2}';
    return 'TG\u{1F534}';
  }
}

function pct(v) {
  if (v == null) return '?';
  const n = Number(v);
  return (Math.abs(n - Math.round(n)) < 0.05 ? n.toFixed(0) : n.toFixed(1)) + '%';
}

// Rate-limit segment: "<dot><5h%>/<7d%>↻HH:MM". Missing windows render as '?'
// rather than being dropped, so the shape stays predictable; the whole segment
// is omitted only when BOTH windows are entirely absent.
function usageStatus(rateLimits) {
  if (!rateLimits || typeof rateLimits !== 'object') return '';
  const fiveH = rateLimits.five_hour;
  const sevenD = rateLimits.seven_day;
  if (!fiveH && !sevenD) return '';
  const u5 = fiveH ? fiveH.used_percentage : null;
  const u7 = sevenD ? sevenD.used_percentage : null;
  const worst = Math.max(u5 ?? 0, u7 ?? 0);
  const dot = worst >= 90 ? '\u{1F534}' : worst >= 75 ? '\u{1F7E1}' : '\u{1F7E2}';
  const resets = [fiveH && fiveH.resets_at, sevenD && sevenD.resets_at]
    .filter(Boolean)
    .map(s => new Date(s))
    .filter(d => !isNaN(d))
    .sort((a, b) => a - b);
  const hhmm = resets.length ? resets[0].toTimeString().slice(0, 5) : '';
  return `${dot}${pct(u5)}/${pct(u7)}` + (hhmm ? `↻${hhmm}` : '');
}

function writeStatusFile(j, harnessV) {
  try {
    const dir = path.join(CONFIG_HOME, 'botcorp');
    fs.mkdirSync(dir, { recursive: true });
    const out = {
      ts: Date.now() / 1000,
      session_id: j.session_id,
      version: j.version,
      model: j.model,
      context_window: j.context_window,
      cost: j.cost,
      rate_limits: j.rate_limits,
      cwd: j.workspace ? j.workspace.current_dir : undefined,
      harness_version: harnessV,
    };
    const dest = path.join(dir, 'status.json');
    const tmp = dest + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, dest);
  } catch (e) {
    // status.json is a convenience cache for other readers — never let a
    // write failure break the statusline render itself.
  }
}

function maybeDump(raw) {
  const idx = process.argv.indexOf('--dump');
  if (idx === -1 || !process.argv[idx + 1]) return;
  try {
    fs.appendFileSync(process.argv[idx + 1], raw.trim() + '\n');
  } catch (e) {}
}

let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    maybeDump(d);
    const j = JSON.parse(d);
    const harnessV = harnessVersion();
    writeStatusFile(j, harnessV);

    const m = (j.model && j.model.display_name || '?').replace(/^Claude /, '');
    const dir = (j.workspace && j.workspace.current_dir) || '';

    let g = '';
    try {
      const b = execSync('git symbolic-ref --short HEAD', { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
      const s = execSync('git --no-optional-locks status --porcelain', { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
      g = s.trim() ? `(${b}*)` : `(${b})`;
    } catch (e) {}

    const ctxPct = Math.round((j.context_window && j.context_window.remaining_percentage) || 0);
    const BAR = 10;
    const filled = Math.round(ctxPct / 100 * BAR);
    const bar = '[' + '█'.repeat(filled) + '░'.repeat(BAR - filled) + '] ' + ctxPct + '%';

    const totalCost = j.cost && typeof j.cost.total_cost_usd === 'number' ? j.cost.total_cost_usd : null;
    const costStr = totalCost != null ? `$${totalCost.toFixed(2)}` : '';

    const line = [
      m,
      dir + (g ? ' ' + g : ''),
      bar,
      costStr,
      usageStatus(j.rate_limits),
      tgStatus(),
      `harness v${harnessV}`,
    ].filter(Boolean).join(' | ');
    console.log(line);
  } catch (e) {
    console.error(process.env.BOTCORP_DEBUG ? e.stack : '');
    console.log('...');
  }
});
