// guard.mjs - every tool guard in ONE node process (v0.8.6 R5).
//
//   node guard.mjs pre     PreToolUse: block-dialogs, config-guard, vault-guard,
//                          operator-guard, each on its own tools (the matchers the
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
// <name>.sh says what it guards). Exit 2 blocks the tool call and feeds stderr
// back to the model. vault-guard FAILS CLOSED on a payload it cannot parse and
// on any error of its own; config-guard and operator-guard block what they
// name and let an unparsable payload through, as before; the PostToolUse
// guards never block.
//
// Gates as in _guard.sh: BOT_HOOK_TRACE=1 appends `<iso> <guard>` to
// memory/metrics/hook-trace.log for each guard that runs, before its gate; a
// guard named in BOT_DISABLED_HOOKS is skipped (bot.yaml refuses to disable
// vault-guard and operator-guard).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = process.env.CLAUDE_PLUGIN_ROOT || path.dirname(HOOKS_DIR);
const BOT_HOME = process.env.BOT_HOME || process.env.CLAUDE_PROJECT_DIR || process.cwd();

// The tools each guard used to be registered for (hooks.json matchers).
const PRE = [
  ['block-dialogs', ['AskUserQuestion', 'ExitPlanMode']],
  ['config-guard', ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']],
  ['vault-guard', ['Read', 'Glob', 'Grep', 'Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']],
  ['operator-guard', ['Bash', 'PowerShell']],
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
const disabled = (name) => `,${process.env.BOT_DISABLED_HOOKS || ''},`.includes(`,${name},`);

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
function configGuard(p) {
  if (!p.ok || p.d === null) return null;
  let file;
  try { const ti = toolInput(p.d); file = ti.file_path || ti.notebook_path || ''; } catch { return null; }
  if (!file) return null;
  const f = low(str(file));
  const home = low(BOT_HOME);
  const cfg = low(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  const hit = f === `${home}/bot.yaml` || f === `${home}/.claude/settings.json` || f.startsWith(`${home}/.vault/`)
    || f === `${cfg}/channels/telegram/access.json`;
  if (!hit) return null;
  return `BLOCKED: ${str(file)} is harness-managed. Use \`botcorp config set <bot> <path> <value>\` for bot.yaml (widening changes need operator approval in the cockpit), \`botcorp secrets set\` for the vault, the cockpit pairing panel for access.json; settings.json is generated by \`botcorp sync\` — edit bot.yaml or settings.local.json instead.`;
}

// ---- vault-guard -----------------------------------------------------------------
// Line by line, as grep read the joined fields. `.vault` as a path segment: the
// bash guard anchored it on `/` or a line start only, so `cat .vault/x` or
// `ls .vault` passed; a shell word boundary counts too now.
const VAULT_RULES = [
  [/(^|[\s/"'=:;|&(<>])\.vault([\s/"';|&)<>]|$)/, ".vault (a bot's secrets vault directory)"],
  [/(secrets|vault|accounts)\.ps1/, 'secrets.ps1/vault.ps1/accounts.ps1'],
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
    for (const k of ['file_path', 'notebook_path', 'path', 'pattern', 'glob', 'command']) if (ti[k]) parts.push(str(ti[k]));
    if (Array.isArray(ti.edits)) for (const e of ti.edits) if (isObj(e) && e.file_path) parts.push(str(e.file_path));
  } catch { return VAULT_UNPARSED; }
  const text = lines(low(parts.join('\n')));
  for (const [re, what] of VAULT_RULES) {
    if (text.some((l) => re.test(l))) return `BLOCKED: ${what} is the secrets vault / secrets CLI. Bots never read or write vault files; the daemon injects declared keys at launch (bot.yaml secrets:). Use botcorp secrets set|list via the operator, never from a session.`;
  }
  return null;
}

// ---- operator-guard --------------------------------------------------------------
// Matches the COMMAND field only, never file paths or Grep patterns.
const BC = String.raw`botcorp(\.mjs)?["']?\s+`;
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
  if (!p.ok || p.d === null) return null;
  let cmd;
  try { cmd = String(toolInput(p.d).command || ''); } catch { return null; }
  if (!cmd) return null;
  const ls = lines(cmd.toLowerCase());
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
  'config-guard': { run: configGuard, block: true },
  'vault-guard': { run: vaultGuard, block: true, closed: 'BLOCKED: vault-guard failed, so it cannot rule out a vault access; it fails closed.' },
  'operator-guard': { run: operatorGuard, block: true },
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
    names = table.filter(([n, tools]) => (tool === null ? n !== 'block-dialogs' : tools.includes(tool))).map(([n]) => n);
  } else if (GUARDS[mode]) names = [mode];
  else { fs.writeSync(2, `guard.mjs: unknown mode '${mode}' (pre | post | ${Object.keys(GUARDS).join(' | ')})\n`); process.exit(0); }

  const warnings = [];
  for (const name of names) {
    trace(name);
    if (disabled(name)) continue;
    const g = GUARDS[name];
    let out = null;
    try { out = await g.run(p); } catch { out = g.closed || null; }
    if (!out) continue;
    // writeSync: an exit right after an async pipe write can drop the message
    if (g.block) { fs.writeSync(2, out + '\n'); process.exit(2); }
    warnings.push(out);
  }
  if (warnings.length) fs.writeSync(1, warnings.join('\n') + '\n');
  process.exit(0);
}

main();
