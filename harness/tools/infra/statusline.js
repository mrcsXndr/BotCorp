#!/usr/bin/env node
// statusline.js — folder (git), model + effort, context, rate limits, account.
// One convention with the TG footer (harness/tools/v2/status_footer.py format_line —
// change both together), segments joined by " · ", empty ones dropped:
//   mybot (main*) · Opus 5.5 high · ctx 361K/500K (72%) · 🟢 5h 12% · wk 62% ↻02:50 · acct ⇄backup
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

// Effort: stdin effort.level -> env CLAUDE_CODE_EFFORT_LEVEL -> settings effortLevel
// (the workspace's .claude/settings.json, then the config home's). Same order as
// status_footer.py _effort().
function effortLevel(j, dir) {
  const e = j.effort;
  const level = (e && typeof e === 'object' ? e.level : e) || process.env.CLAUDE_CODE_EFFORT_LEVEL;
  if (level) return String(level).trim().toLowerCase();
  const files = [dir && path.join(dir, '.claude', 'settings.json'), path.join(CONFIG_HOME, 'settings.json')];
  for (const f of files) {
    if (!f) continue;
    try {
      const v = JSON.parse(fs.readFileSync(f, 'utf8')).effortLevel;
      if (v) return String(v).toLowerCase();
    } catch (e2) {}
  }
  return '';
}

// Account of the newest launch record in <config_home>/botcorp/launch-env.json, like
// status_footer.py _account_status(). Empty for the bot's own token (nothing to say).
function accountSegment() {
  try {
    const launches = Object.values(JSON.parse(fs.readFileSync(path.join(CONFIG_HOME, 'botcorp', 'launch-env.json'), 'utf8')).launches || {})
      .filter(r => r && typeof r === 'object');
    if (!launches.length) return '';
    const newest = launches.reduce((a, b) => (String(b.at || '') > String(a.at || '') ? b : a));
    const account = String(newest.account || '');
    if (!account || account === 'own') return '';
    const moved = ['failover', 'failback'].includes(newest.account_reason);
    return `acct ${moved ? '⇄' : ''}${account}`;
  } catch (e) {
    return '';
  }
}

// The one line format, mirrored by status_footer.py format_line().
function formatLine({ folder, git, model, effort, ctx, usage, account, short }) {
  const parts = [[folder, git].filter(Boolean).join(' '), [model, effort].filter(Boolean).join(' '), ctx];
  if (!short) parts.push(usage, account);
  return parts.filter(Boolean).join(' · ');
}

function pct(v) {
  if (v == null) return '?';
  const n = Number(v);
  return (Math.abs(n - Math.round(n)) < 0.05 ? n.toFixed(0) : n.toFixed(1)) + '%';
}

// Rate-limit segment: "<dot> 5h <5h%> · wk <7d%> ↻HH:MM". Missing windows render as '?'
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
  return `${dot} 5h ${pct(u5)} · wk ${pct(u7)}` + (hhmm ? ` ↻${hhmm}` : '');
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

// "(branch)" / "(branch*)". git status is the slow part of a render (two git
// processes on every keystroke-driven redraw), so the result is cached per folder
// in <config_home>/botcorp/git-status.json for GIT_TTL_S, shared with
// status_footer.py _git_status(): at most one render per TTL pays for git.
const GIT_TTL_S = 30;
function gitSegment(dir) {
  const file = path.join(CONFIG_HOME, 'botcorp', 'git-status.json');
  const key = dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const now = Date.now() / 1000;
  let cache = {};
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c && typeof c === 'object') cache = c;
  } catch (e) {}
  const hit = cache[key];
  if (hit && typeof hit.git === 'string' && now - hit.ts >= 0 && now - hit.ts < GIT_TTL_S) return hit.git;
  let g = '';
  try {
    const b = execSync('git symbolic-ref --short HEAD', { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
    const s = execSync('git --no-optional-locks status --porcelain', { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
    g = s.trim() ? `(${b}*)` : `(${b})`;
  } catch (e) {}
  try {
    cache[key] = { ts: now, git: g };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, file);
  } catch (e) {}
  return g;
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

    const g = gitSegment(dir);

    const cw = j.context_window || {};
    const cu = cw.current_usage;
    let ctx;
    if (cu) {
      const used = (cu.input_tokens || 0) + (cu.cache_read_input_tokens || 0) + (cu.cache_creation_input_tokens || 0);
      const ceiling = compactCeiling(Number(cw.context_window_size) || 0);
      ctx = `ctx ${fmtTokens(used)}/${fmtTokens(ceiling)} (${Math.round(used / ceiling * 100)}%)`;
    } else {
      // No usage yet (before the first API call): the raw-window remaining %.
      ctx = `ctx ${Math.round(100 - (cw.remaining_percentage == null ? 100 : cw.remaining_percentage))}%`;
    }

    const short = process.argv.includes('--short');
    console.log(formatLine({
      folder: path.basename(dir), git: g, model: m, effort: effortLevel(j, dir), ctx,
      usage: usageStatus(j.rate_limits), account: accountSegment(), short,
    }));
  } catch (e) {
    console.error(process.env.BOTCORP_DEBUG ? e.stack : '');
    console.log('...');
  }
});
