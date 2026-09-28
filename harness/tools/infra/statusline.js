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

// Where Claude Code compacts, the same rule as status_footer.py _compact_ceiling():
// env CLAUDE_CODE_AUTO_COMPACT_WINDOW (the launch sets it per bot), else the
// config home settings.json autoCompactWindow, else the model window, else
// 500000; scaled by CLAUDE_AUTOCOMPACT_PCT_OVERRIDE when that is 1-100, and
// never above the model window when it is known.
function compactCeiling(size) {
  let c = Math.trunc(Number(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)) || 0;
  if (c <= 0) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(CONFIG_HOME, 'settings.json'), 'utf8'));
      c = Math.trunc(Number(s.autoCompactWindow)) || 0;
    } catch (e) {
      c = 0;
    }
  }
  if (c <= 0) c = size || 500000;
  const p = Number(process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE);
  if (p >= 1 && p <= 100) c = Math.trunc(c * p / 100);
  if (size) c = Math.min(c, size);
  return c;
}

function fmtTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
  return String(n);
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
      effort: j.effort,
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

    const BAR = 10;
    const cw = j.context_window || {};
    const cu = cw.current_usage;
    let bar;
    if (cu) {
      const used = (cu.input_tokens || 0) + (cu.cache_read_input_tokens || 0) + (cu.cache_creation_input_tokens || 0);
      const ceiling = compactCeiling(Number(cw.context_window_size) || 0);
      const usedPct = Math.round(used / ceiling * 100);
      const filled = Math.min(BAR, Math.round(usedPct / 100 * BAR));
      bar = '[' + '█'.repeat(filled) + '░'.repeat(BAR - filled) + `] ctx ${fmtTokens(used)}/${fmtTokens(ceiling)} (${usedPct}%)`;
    } else {
      // No usage yet (before the first API call): the raw-window remaining %.
      const ctxPct = Math.round(cw.remaining_percentage || 0);
      const filled = Math.round(ctxPct / 100 * BAR);
      bar = '[' + '█'.repeat(filled) + '░'.repeat(BAR - filled) + '] ' + ctxPct + '%';
    }

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
