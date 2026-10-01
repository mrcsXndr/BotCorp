// guard.mjs - every tool guard in ONE node process (v0.8.6 R5).
//
//   node guard.mjs pre     PreToolUse: block-dialogs, config-guard, vault-guard,
//                          operator-guard, destructive-guard, each on its own tools (the matchers the
//                          separate hooks had), first block wins
//   node guard.mjs post    PostToolUse: core-guard, tools-nudge (warn-only)
//   node guard.mjs <name>  one guard, whatever the tool (the <name>.sh wrappers,
//                          the tests and `botcorp doctor` run it this way)
//
// hooks.json runs it in Claude Code's exec form (no shell). Each guard used to be
// `bash -c 'bash guard.sh'` plus a python parse and a fork per helper: on a box
// where a Git Bash start costs seconds, the 5 s timeout cancelled them and a
// cancelled PreToolUse hook lets the tool call through. Node starts in ~70 ms.
//
// The decisions are the bash guards', ported as they were (the header of each
// <name>.sh says what it guards), with the bypasses the 2026-09-30 review found
// closed. Exit 2 blocks the tool call and feeds stderr back to the model.
// vault-guard, config-guard, operator-guard and destructive-guard FAIL CLOSED on a payload they
// cannot parse and on any error of their own; the PostToolUse guards never
// block.
//
// Gates as in _guard.sh: BOT_HOOK_TRACE=1 appends `<iso> <guard>` to
// memory/metrics/hook-trace.log for each guard that runs, before its gate; a
// guard named in BOT_DISABLED_HOOKS is skipped, except vault-guard and
// operator-guard (bot.yaml refuses to disable them; see ALWAYS_ON).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { recordTiming } from './_timing.mjs';

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = process.env.CLAUDE_PLUGIN_ROOT || path.dirname(HOOKS_DIR);
const BOT_HOME = process.env.BOT_HOME || process.env.CLAUDE_PROJECT_DIR || process.cwd();

// The tools each guard runs for: the matchers the separate hooks had, plus
// every other tool that runs a command (Monitor, an MCP shell tool; review
// 2026-09-30), which the guards only ever read the command/path fields of.
const SHELL = ['Bash', 'PowerShell', 'Monitor', /^mcp__/];
const PRE = [
  ['block-dialogs', ['AskUserQuestion', 'ExitPlanMode']],
  ['config-guard', ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']],
  ['vault-guard', ['Read', 'Glob', 'Grep', ...SHELL, 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']],
  ['operator-guard', SHELL],
  ['destructive-guard', SHELL],
];
const POST = [
  ['core-guard', ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']],
  ['tools-nudge', ['Write', 'Edit']],
];

const fwd = (s) => String(s).replace(/\\/g, '/');
const low = (s) => fwd(s).toLowerCase();
const lines = (s) => String(s).split('\n');

function trace(name) {
  if (process.env.BOT_HOOK_TRACE !== '1') return;
  try {
    const dir = path.join(BOT_HOME, 'memory', 'metrics');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'hook-trace.log'), `${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')} ${name}\n`);
  } catch {}
}
// bot.yaml refuses to disable these two, and a settings `env` could set
// BOT_DISABLED_HOOKS behind its back, so the env is not asked for them.
const ALWAYS_ON = new Set(['vault-guard', 'operator-guard']);
const disabled = (name) => !ALWAYS_ON.has(name) && `,${process.env.BOT_DISABLED_HOOKS || ''},`.includes(`,${name},`);

// {ok, d}: d is the parsed payload; ok false = not JSON. An empty payload is null.
function parse(raw) {
  if (!raw) return { ok: true, d: null };
  try { return { ok: true, d: JSON.parse(raw) }; } catch { return { ok: false, d: null }; }
}
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// python's `d.get('tool_input') or {}`: a non-object payload or tool_input throws there
function toolInput(d) {
  if (!isObj(d)) throw new Error('payload is not an object');
  const ti = d.tool_input;
  if (!ti) return {};
  if (!isObj(ti)) throw new Error('tool_input is not an object');
  return ti;
}
const str = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

// ---- block-dialogs ---------------------------------------------------------------
function blockDialogs() {
  return `BLOCKED: AskUserQuestion / ExitPlanMode are disabled in this bot — a blocking TUI dialog freezes the headless/Telegram-driven flow (no one can answer it over Telegram). Do NOT retry. Instead: pick the sensible default and proceed, stating the choice in your reply. If you genuinely need the operator's input, send a NON-blocking question via 'python "${HARNESS}/tools/tg/tg_send.py" "..."' and continue with a reasonable default rather than waiting.`;
}

// ---- config-guard ----------------------------------------------------------------
const unparsed = (name) => `BLOCKED: ${name} could not parse this tool call, so it cannot tell what it touches; it fails closed.`;

// .claude/settings.local.json and the config home's settings.json are the
// bot's to edit (its own hooks), but Claude Code applies their `env` over the
// launch env, hooks included, and `disableAllHooks` stops every hook: either
// switches the guards off. -> why the edit is refused, or null. The edit is
// applied to the file as it is now and the two keys compared before/after.
function settingsSwitch(file, ti) {
  const strip = (s) => String(s).replace(/^﻿/, '');
  let now = '';
  try { now = strip(fs.readFileSync(file, 'utf-8')); } catch {}
  let before = {};
  try { before = JSON.parse(now); } catch {}
  let text = now;
  if (typeof ti.content === 'string') text = strip(ti.content);
  else {
    for (const e of Array.isArray(ti.edits) ? ti.edits : [ti]) {
      if (!isObj(e) || typeof e.old_string !== 'string' || typeof e.new_string !== 'string') continue;
      text = e.replace_all ? text.split(e.old_string).join(e.new_string) : text.replace(e.old_string, () => e.new_string);
    }
  }
  let after;
  try { after = JSON.parse(text); } catch { return 'leaves it unparsable, so what it switches cannot be checked'; }
  const keys = (o) => JSON.stringify(isObj(o) ? [o.env ?? null, o.disableAllHooks ?? null] : [null, null]);
  return keys(before) === keys(after) ? null : 'changes `env` or `disableAllHooks`';
}

function configGuard(p) {
  if (p.ok && p.d === null) return null;
  if (!p.ok) return unparsed('config-guard');
  let ti, file;
  try { ti = toolInput(p.d); file = ti.file_path || ti.notebook_path || ''; } catch { return unparsed('config-guard'); }
  if (!file) return null;
  const f = low(str(file));
  const home = low(BOT_HOME);
  const cfg = low(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  if (f === `${home}/.claude/settings.local.json` || f === `${cfg}/settings.json`) {
    const why = settingsSwitch(str(file), ti);
    return why ? `BLOCKED: this edit of ${str(file)} ${why}. A settings env (BOT_DISABLED_HOOKS, PATH, NODE_OPTIONS, ...) or disableAllHooks can switch the hook guards off for the session. The session env comes from bot.yaml (botcorp config set <bot> ...); hooks and other keys in this file stay yours to edit.` : null;
  }
  // "All bots" knowledge: the source docs and the synced copies reach every bot's instructions
  const rt = low(process.env.BOTCORP_HOME || path.join(os.homedir(), '.botcorp'));
  const n = path.posix.normalize(f);
  if (n.startsWith(`${rt}/global/`) || (n.startsWith(`${cfg}/rules/`) && path.posix.basename(n).startsWith('botcorp-global-'))) {
    return `BLOCKED: ${str(file)} is "All bots" knowledge: one doc reaches every bot's instructions, so only the operator changes it (\`botcorp knowledge set --global <doc>\` in their terminal, or the cockpit). A bot edits its own docs: \`botcorp knowledge set <bot> <doc>\`, CLAUDE.md or .claude/rules/.`;
  }
  const hit = f === `${home}/bot.yaml` || f === `${home}/.claude/settings.json` || f.startsWith(`${home}/.vault/`)
    || f === `${cfg}/channels/telegram/access.json`;
  if (!hit) return null;
  return `BLOCKED: ${str(file)} is harness-managed. Use \`botcorp config set <bot> <path> <value>\` for bot.yaml (widening changes need operator approval in the cockpit), \`botcorp secrets set\` for the vault, the cockpit pairing panel for access.json; settings.json is generated by \`botcorp sync\` — edit bot.yaml or settings.local.json instead.`;
}

// ---- vault-guard -----------------------------------------------------------------
// Line by line, as grep read the joined fields. `.vault` as a path segment: the
// bash guard anchored it on `/` or a line start only, so `cat .vault/x` or
// `ls .vault` passed; any non-name character before it counts now.
const VAULT_RULES = [
  [/(^|[^a-z0-9_-])\.vault($|[^a-z0-9_-])/, ".vault (a bot's secrets vault directory)"],
  [/(secrets|vault|accounts)\.ps1/, 'secrets.ps1/vault.ps1/accounts.ps1'],
  // the vault's own functions, reachable by dot-sourcing daemon/_common.ps1 (it loads vault.ps1)
  [/(get|set|read|write|remove|unprotect|unlock)-vault/, 'the vault functions (Get-VaultSecret, Read-VaultStore, ...)'],
  [/botcorp.*secrets.*(get|unlock|lock|import-bundle|export-bundle|migrate)/, 'botcorp secrets get/unlock/lock/import-bundle/export-bundle/migrate'],
  [/protecteddata/, 'ProtectedData (the DPAPI API)'],
  [/secret-access\.jsonl/, 'secret-access.jsonl (the secrets audit log)'],
  // owner-only, but a bot runs as the same user: its tool calls must not reach it
  [/cockpit-approve-token/, "cockpit-approve-token (the cockpit's operator token)"],
  // the paired-browser HMAC key and the pairing codes/devices: holding either mints the operator cookie
  [/cockpit-(operator|pairing)/, "cockpit-operator.key / cockpit-pairing.json (the cockpit's browser pairing)"],
  // <rt>/state/<bot>/launch-id: what makes a caller that bot (an admin bot's powers hang on it)
  [/(^|[^a-z0-9_-])launch-id($|[^a-z0-9_-])/, "launch-id (a bot's per-launch identity)"],
];
const VAULT_UNPARSED = 'BLOCKED: vault-guard could not parse this tool call, so it cannot rule out a vault access; it fails closed.';

function vaultGuard(p) {
  if (p.ok && p.d === null) return null;
  if (!p.ok) return VAULT_UNPARSED;
  let parts = [];
  try {
    const ti = toolInput(p.d);
    for (const k of ['file_path', 'notebook_path', 'path', 'pattern', 'glob', 'command', 'files']) if (ti[k]) parts.push(str(ti[k]));
    if (Array.isArray(ti.edits)) for (const e of ti.edits) if (isObj(e) && e.file_path) parts.push(str(e.file_path));
  } catch { return VAULT_UNPARSED; }
  const text = lines(low(parts.join('\n')));
  for (const [re, what] of VAULT_RULES) {
    if (text.some((l) => re.test(l))) return `BLOCKED: ${what} is the secrets vault / secrets CLI. Bots never read or write vault files; the daemon injects declared keys at launch (bot.yaml secrets:). Use botcorp secrets set|list via the operator, never from a session.`;
  }
  return null;
}

// ---- operator-guard --------------------------------------------------------------
// Matches the COMMAND field only, never file paths or Grep patterns, after
// joining continued lines (`\` or a PowerShell backtick before a newline) and
// dropping quotes, so `"approve"` is approve. `$BC` is the CLI as the bots'
// own runtime notes spell it (BC=node .../botcorp.mjs).
const BC = String.raw`(botcorp(\.mjs)?|\$\{?bc\}?)\s+`;
const normCmd = (cmd) => cmd.replace(/[\\`]\r?\n/g, ' ').replace(/["']/g, '').toLowerCase();
const NEVER = [
  [new RegExp(`${BC}cockpit\\s+(expose|unexpose|pair|unpair)([^a-z0-9_-]|$)`), 'BLOCKED: botcorp cockpit expose / unexpose / pair / unpair are the operator\'s alone (an admin bot cannot run them either).'],
  [new RegExp(`${BC}accounts\\s+(rename([^a-z0-9_-]|$)|seed\\s[^;&|]*--link([^a-z0-9_-]|$))`), 'BLOCKED: botcorp accounts rename / accounts seed --link are the operator\'s alone (an admin bot cannot run them either): the cockpit Accounts page or the operator\'s terminal.'],
];
const OPERATOR_VERB = new RegExp(`${BC}(approve|reject|accounts\\s+(use|add|remove|seed|backups)|secrets\\s+(set|delete)|pair\\s+[a-z0-9_-]+\\s+[0-9]+|update\\s.*--(apply|skip|rollback|cancel))([^a-z0-9_-]|$)`);
const START_STOP = new RegExp(`${BC}(start|stop|restart)\\s+_?[a-z0-9][a-z0-9-]*`, 'g');

// An admin bot passes: `botcorp whoami` judges THIS session's own env (its
// BOT_NAME and launch id), never what the command sets inline. Anything that
// fails to answer is a no.
function isAdmin() {
  try {
    const r = spawnSync(process.execPath, [path.join(HARNESS, '..', 'cli', 'botcorp.mjs'), 'whoami', '--json'], { encoding: 'utf-8', timeout: 10_000, windowsHide: true });
    return r.status === 0 && JSON.parse(r.stdout).admin === true;
  } catch { return false; }
}

function operatorGuard(p) {
  if (p.ok && p.d === null) return null;
  if (!p.ok) return unparsed('operator-guard');
  let cmd;
  try { cmd = String(toolInput(p.d).command || ''); } catch { return unparsed('operator-guard'); }
  if (!cmd) return null;
  const ls = lines(normCmd(cmd));
  for (const [re, msg] of NEVER) if (ls.some((l) => re.test(l))) return msg;
  let need = '';
  if (ls.some((l) => OPERATOR_VERB.test(l))) need = 'operator-only verb';
  else {
    const own = process.env.BOT_NAME || '';
    const other = ls.flatMap((l) => [...l.matchAll(START_STOP)].map((m) => m[0].trim().split(/\s+/).pop())).find((n) => n !== own);
    if (other) need = `start/stop/restart of another bot (${other})`;
  }
  if (!need || isAdmin()) return null;
  return `BLOCKED: ${need}: operator-only (or an admin bot: bot.yaml role: admin). botcorp approve / reject, accounts add|remove|seed|use|backups, secrets set|delete, pair <id>, update --apply|--skip|--rollback|--cancel and start/stop/restart of another bot are the operator's. A bot queues a widening change (botcorp config set) and the operator decides it in the cockpit or their own terminal. To read the queue: botcorp approvals.`;
}

// ---- destructive-guard -----------------------------------------------------------
// Blocks a shell command no bot should run: a recursive delete of the filesystem
// root, a drive root, the home folder, the BotCorp root, a bot folder, a .git
// directory or a folder holding one of them; a force push to main/master;
// `git reset --hard` with `git clean -fdx`; format <drive>: / Format-Volume /
// diskpart / mkfs. Narrow on purpose: a relative or deeper path passes (rm -rf
// node_modules), and so does a push without force. String work only, no process.

// The command as segments (split on ; | & newline and brackets outside quotes)
// of words {v, q}; a quoted word keeps its spaces and has q set.
function shellWords(cmd) {
  const segs = [[]];
  let w = null;
  let quote = '';
  const end = () => { if (w) segs[segs.length - 1].push(w); w = null; };
  for (const c of cmd.replace(/[\\`]\r?\n/g, ' ').replace(/\$\{([^}]*)\}/g, '$$$1')) {
    if (quote) { if (c === quote) quote = ''; else w.v += c; continue; }
    if (c === '"' || c === "'") { quote = c; w = w || { v: '', q: false }; w.q = true; continue; }
    if (';|&\n(){}'.includes(c)) { end(); if (segs[segs.length - 1].length) segs.push([]); continue; }
    if (/\s/.test(c)) { end(); continue; }
    w = w || { v: '', q: false };
    w.v += c;
  }
  end();
  return segs.map((seg) => seg.filter((x) => x.q || x.v !== '$')).filter((seg) => seg.length);
}

// -> what a recursive delete of path t would wipe, or null. Relative paths are
// judged by their last segment only (.git); variables other than the home and
// bot-folder ones are not expanded.
function protectedPath(t) {
  if (!t) return null;
  const home = low(os.homedir());
  const botHome = process.env.BOT_HOME || process.env.CLAUDE_PROJECT_DIR || '';
  let s = low(t)
    .replace(/^(~|\$home|\$env:userprofile|\$env:home|%userprofile%)(?=\/|$)/, home)
    .replace(/^\/mnt\/([a-z])(?=\/|$)/, '$1:').replace(/^\/([a-z])(?=\/|$)/, '$1:');   // Git Bash / WSL drive forms
  if (botHome) s = s.replace(/^(\$bot_home|\$env:bot_home|\$claude_project_dir|\$env:claude_project_dir|%bot_home%)(?=\/|$)/, low(path.resolve(botHome)));
  const abs = /^([a-z]:)?\//.test(s) || /^[a-z]:$/.test(s);
  if (abs) s = path.posix.normalize(s);
  // trailing globs, `.` and slashes go: /* is the root, C:\*.* the drive
  for (let prev = ''; prev !== s;) { prev = s; s = s.replace(/\/(\*(\.\*)?|\.)$/, '').replace(/\/+$/, ''); }
  if (abs && s === '') return 'the filesystem root';
  if (/^[a-z]:$/.test(s)) return 'a drive root';
  if (path.posix.basename(s) === '.git') return 'a .git directory';
  if (!abs) return null;
  const holds = (dir) => s === dir || dir.startsWith(`${s}/`);
  const root = low(path.resolve(HARNESS, '..'));
  if (holds(home)) return 'the home folder';
  if (holds(root)) return 'the BotCorp root';
  if (s === `${root}/bots` || path.posix.dirname(s) === `${root}/bots`) return 'a bot folder';
  if (botHome && holds(low(path.resolve(botHome)))) return 'the bot folder';
  return null;
}

const RM = new Set(['rm', 'remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir']);
const CMD_RM = new Set(['del', 'erase', 'rd', 'rmdir']);       // cmd.exe: /s recurses, /q is a switch
const PREFIX = new Set(['sudo', 'command', 'exec', 'nohup', 'time', 'call', 'env']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'pwsh', 'powershell', 'eval', 'iex', 'invoke-expression']);
const cmdBase = (v) => low(v).split('/').pop().replace(/\.exe$/, '');

function destructiveSegment(words, ctx, depth) {
  let i = 0;
  for (; i < words.length; i++) {   // skip VAR=x, sudo -u x, cmd /c ...
    const b = cmdBase(words[i].v);
    if (!words[i].q && /^[a-z_][a-z0-9_]*=/i.test(words[i].v)) continue;
    if (PREFIX.has(b)) { while (words[i + 1] && words[i + 1].v.startsWith('-')) i++; continue; }
    if (b === 'cmd') { while (words[i + 1] && /^\/[a-z]$/i.test(words[i + 1].v)) i++; continue; }
    break;
  }
  const w = words[i];
  if (!w) return null;
  if (depth < 4 && w.q && /\s/.test(w.v)) return destructiveCmd(w.v, ctx, depth + 1);   // cmd /c "rd /s /q C:\"
  const b = cmdBase(w.v);
  const args = words.slice(i + 1).map((x) => x.v);
  const lc = args.map((a) => a.toLowerCase());
  if (RM.has(b)) {
    const cmdStyle = CMD_RM.has(b);
    const recursive = lc.some((a) => /^-[fvidr]*r[fvidr]*$/.test(a) || a === '--recursive'
      || (a.length >= 2 && '-recurse'.startsWith(a.split(':')[0])) || (cmdStyle && a === '/s'));
    if (!recursive) return null;
    for (const a of args) {
      if (a.startsWith('-') || (cmdStyle && /^\/[a-z]$/i.test(a))) continue;
      const what = protectedPath(a);
      if (what) return `a recursive delete of ${what} (${a})`;
    }
    return null;
  }
  if (b === 'git') {
    let j = 0;
    while (j < args.length && args[j].startsWith('-')) j += /^-[cC]$/.test(args[j]) ? 2 : 1;   // git -C <dir> / -c k=v
    const sub = lc[j];
    const rest = args.slice(j + 1);
    if (sub === 'push') {
      const forced = rest.some((a) => a === '--force' || a.startsWith('--force-with-lease') || /^-[a-z]*f[a-z]*$/i.test(a));
      for (const a of rest) {
        if (a.startsWith('-')) continue;
        const dst = a.replace(/^\+/, '').split(':').pop().replace(/^refs\/heads\//i, '').toLowerCase();
        if ((forced || a.startsWith('+')) && (dst === 'main' || dst === 'master')) return `a force push to ${dst} (git push ${rest.join(' ')})`;
      }
    }
    if (sub === 'reset' && rest.includes('--hard')) ctx.reset = true;
    if (sub === 'clean') {
      const f = rest.filter((a) => /^-[a-zA-Z]+$/.test(a)).join('') + (rest.includes('--force') ? 'f' : '');
      if (f.includes('f') && f.includes('d') && f.includes('x')) ctx.clean = true;
    }
    return null;
  }
  if (b === 'format' && args.some((a) => /^[a-z]:[\\/]?$/i.test(a))) return `formatting a drive (format ${args.join(' ')})`;
  if (b === 'format-volume' || b === 'diskpart' || b === 'mkfs' || b.startsWith('mkfs.')) return `${b} (formats or repartitions a disk)`;
  if (SHELLS.has(b) && depth < 4) {
    for (const x of words.slice(i + 1)) if (x.q && /\s/.test(x.v)) { const r = destructiveCmd(x.v, ctx, depth + 1); if (r) return r; }
    const k = lc.findIndex((a) => a.length >= 2 && '-command'.startsWith(a));   // bash -c / pwsh -Command, unquoted
    if (k >= 0) return destructiveSegment(words.slice(i + 2 + k), ctx, depth + 1);
  }
  return null;
}

function destructiveCmd(cmd, ctx, depth) {
  for (const words of shellWords(cmd)) { const r = destructiveSegment(words, ctx, depth); if (r) return r; }
  return null;
}

function destructiveGuard(p) {
  if (p.ok && p.d === null) return null;
  if (!p.ok) return unparsed('destructive-guard');
  let cmd;
  try { cmd = String(toolInput(p.d).command || ''); } catch { return unparsed('destructive-guard'); }
  if (!cmd) return null;
  const ctx = { reset: false, clean: false };
  let what = destructiveCmd(cmd, ctx, 0);
  if (!what && ctx.reset && ctx.clean) what = '`git reset --hard` together with `git clean -fdx` (wipes every uncommitted and ignored file in the repo)';
  return what ? `BLOCKED: ${what}. destructive-guard keeps bots away from commands that wipe a disk, a home folder, the BotCorp root, a bot folder, a repo's .git or main. If it is really meant, the operator runs it from their own terminal.` : null;
}

// ---- core-guard (warn-only) ------------------------------------------------------
// A TRACKED file of the shared BotCorp checkout modified off a suggest/* branch:
// the updater refuses a dirty tree, so it blocks every future update.
function coreGuard(p) {
  if (!p.ok || p.d === null) return null;
  let file;
  try { const ti = toolInput(p.d); file = ti.file_path || ti.notebook_path || ''; } catch { return null; }
  if (!file) return null;
  const botcorp = fwd(path.resolve(HARNESS, '..'));
  let f = fwd(str(file));
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(f);       // Git Bash form /c/... -> c:/...
  if (m && process.platform === 'win32') f = `${m[1]}:/${m[2]}`;
  const win = process.platform === 'win32';
  const cmp = (s) => (win ? s.toLowerCase() : s);
  if (!cmp(f).startsWith(`${cmp(botcorp)}/`)) return null;
  const rel = f.slice(botcorp.length + 1);
  if (rel.startsWith('bots/')) return null;
  const git = (...a) => spawnSync('git', ['-C', botcorp, ...a], { encoding: 'utf-8', timeout: 10_000, windowsHide: true });
  if (git('ls-files', '--error-unmatch', '--', rel).status !== 0) return null;
  const b = git('rev-parse', '--abbrev-ref', 'HEAD');
  const branch = b.status === 0 ? b.stdout.trim() : '?';
  if (branch.startsWith('suggest/')) return null;
  return `⚠️ HARNESS-CONTRACT WARNING: you just modified a TRACKED BotCorp file
(${rel}) on branch '${branch}'. This checkout is shared by every bot on this
machine, and the updater refuses a dirty tree: until this edit is reverted it
blocks every future engine update. Revert it (\`git -C "${botcorp}" checkout -- ${rel}\`)
and put the behavior in your bot folder (bot.yaml, bot-local rules, memory/)
instead, or make the change on a suggest/<topic> branch and open a PR:
\`botcorp suggest <bot> --topic <t>\`.`;
}

// ---- tools-nudge (warn-only) -----------------------------------------------------
// An executable under tools/ or scripts/ that no bot.yaml `tools:` entry covers.
async function toolsNudge(p) {
  if (!p.ok || p.d === null) return null;
  let file;
  try { file = toolInput(p.d).file_path || ''; } catch { return null; }
  if (!file || !fs.existsSync(path.join(BOT_HOME, 'bot.yaml'))) return null;
  const home = fwd(path.resolve(BOT_HOME));
  const f = fwd(str(file));
  const under = (d) => f.toLowerCase().startsWith(`${home.toLowerCase()}/${d}/`);
  if (!under('tools') && !under('scripts')) return null;
  const rel = f.slice(home.length + 1);
  if (!/\.(py|mjs|js|cjs|sh|ps1)$/i.test(rel)) return null;
  if (/^(_|test_)/i.test(path.posix.basename(rel))) return null;   // private modules and tests are not tools
  const root = path.resolve(HARNESS, '..');
  const load = (p2) => import(pathToFileURL(path.join(root, p2)).href);
  const { loadBotYaml } = await load('daemon/botyaml.mjs');
  const { covers } = await load('cli/tools.mjs');
  const { isShim } = await load('daemon/sync.mjs');
  const cfg = loadBotYaml(path.join(home, 'bot.yaml'));
  if (!Array.isArray(cfg.tools) || cfg.tools.some((t) => covers(t, rel)) || isShim(path.join(home, rel))) return null;
  const name = path.posix.basename(rel).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'tool';
  return `unregistered tool ${rel}: register it this turn with botcorp tools ${cfg.name} register --name ${name} --path ${rel} --kind cli --purpose "<what it does>" (kind integration if it uses a secret or writes outside the box)` + (cfg.harness.tools_registry === 'enforce' ? '; the registry is enforced: doctor FAILs until registered' : '');
}

const GUARDS = {
  'block-dialogs': { run: blockDialogs, block: true },
  'config-guard': { run: configGuard, block: true, closed: 'BLOCKED: config-guard failed, so it cannot tell what this edit touches; it fails closed.' },
  'vault-guard': { run: vaultGuard, block: true, closed: 'BLOCKED: vault-guard failed, so it cannot rule out a vault access; it fails closed.' },
  'operator-guard': { run: operatorGuard, block: true, closed: 'BLOCKED: operator-guard failed, so it cannot rule out an operator verb; it fails closed.' },
  'destructive-guard': { run: destructiveGuard, block: true, closed: 'BLOCKED: destructive-guard failed, so it cannot rule out a destructive command; it fails closed.' },
  'core-guard': { run: coreGuard, block: false },
  'tools-nudge': { run: toolsNudge, block: false },
};

async function main() {
  const mode = process.argv[2] || '';
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf-8'); } catch {}
  const p = parse(raw.trim());
  let names;
  if (mode === 'pre' || mode === 'post') {
    const table = mode === 'pre' ? PRE : POST;
    const tool = p.ok && isObj(p.d) && typeof p.d.tool_name === 'string' ? p.d.tool_name : null;
    // no tool name: every guard but the dialog one (an unparsable payload still meets vault-guard)
    const meets = (tools) => tools.some((t) => (typeof t === 'string' ? t === tool : t.test(tool)));
    names = table.filter(([n, tools]) => (tool === null ? n !== 'block-dialogs' : meets(tools))).map(([n]) => n);
  } else if (GUARDS[mode]) names = [mode];
  else { fs.writeSync(2, `guard.mjs: unknown mode '${mode}' (pre | post | ${Object.keys(GUARDS).join(' | ')})\n`); process.exit(0); }

  // the hooks.json entry points (guard-pre / guard-post) are timed, a direct guard run is not
  const exit = (code) => { if (mode === 'pre' || mode === 'post') recordTiming(`guard-${mode}`, performance.now(), code); process.exit(code); };
  const warnings = [];
  for (const name of names) {
    trace(name);
    if (disabled(name)) continue;
    const g = GUARDS[name];
    let out = null;
    try { out = await g.run(p); } catch { out = g.closed || null; }
    if (!out) continue;
    // writeSync: an exit right after an async pipe write can drop the message
    if (g.block) { fs.writeSync(2, out + '\n'); exit(2); }
    warnings.push(out);
  }
  if (warnings.length) fs.writeSync(1, warnings.join('\n') + '\n');
  exit(0);
}

main();
