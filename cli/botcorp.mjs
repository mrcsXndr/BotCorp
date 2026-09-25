#!/usr/bin/env node
// botcorp.mjs - the operator CLI. The ONE implementation of every rule the
// daemon, the cockpit and the operator's terminal share: creating a bot (with
// the feature-catalogue checklist), syncing bot.yaml into generated files, the
// vault (through daemon/secrets.ps1), Telegram pairing, the guarded config
// writer with its approval queue, start/stop/restart through the pty-host,
// export/import/backup of a bot folder, status, automations, the admin-only
// update queue, cockpit exposure, doctor (including the host checks).
//
//   node cli/botcorp.mjs <command> [args] [--json]     (docs/cli.md)
//
// Exit codes: 0 ok, 1 error, 2 usage, 3 duplicate Telegram token.
// Plain text, one fact per line; --json on read commands returns objects.
// Secrets: never on argv, never printed (children mask, we scrub again).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULTS, deepMerge, loadBotYaml, validate } from '../daemon/botyaml.mjs';
import { sync } from '../daemon/sync.mjs';
import { zipWrite, zipList, zipExtract, zipEntryData } from './_zip.mjs';
import {
  ROOT, BOTCORP_HOME, STATE_DIR, NAME_RE, SENDER_RE,
  botHome, configDir, botYamlPath, botExists, listBots,
  CliError, fail, usage,
  readJson, writeJsonAtomic, writeTextAtomic,
  pidAlive, firstInt, processParents, isDescendant, pollerVerdict, scrub, run, runPwshFile, runPwshCommand, resolveClaude, runClaude, resolvePython, sleep,
  resolvePwsh, resolveGit, gitExe, PYTHON_LOOKED_IN, matchesAnyGlob, coversMesh, findOnPath,
  stdinIsPiped, readStdinAll, promptHidden, promptVisible,
  ptyJsonPath, ptyLive, ptyPublic,
  isObj, loadRawYaml, parseYaml, dumpYaml, writeRawYaml, harnessVersion, humanAge, spawnDetached,
} from './_lib.mjs';

const VALUE_FLAGS = new Set(['name', 'persona', 'as', 'topic', 'lesson', 'requested-by', 'telegram-owner', 'modules', 'no-modules', 'out', 'team', 'aud', 'apply', 'skip', 'deny', 'config-dir', 'label', 'plan', 'account', 'cwd', 'tail', 'files', 'manifest']);
const OWNER_RE = /^[0-9]{5,12}$/;   // a Telegram user id
const COCKPIT_PORT = Number(process.env.COCKPIT_PORT || process.env.PORT || 4477);

// ---- argv -------------------------------------------------------------------------
function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (VALUE_FLAGS.has(k)) { flags[k] = argv[++i]; if (flags[k] === undefined) usage(`--${k} needs a value`); }
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

function out(line = '') { process.stdout.write(line + '\n'); }
function outJson(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); }

function requireBot(name) {
  if (!name) usage('bot name required');
  if (!NAME_RE.test(name)) usage(`bad bot name '${name}' (lowercase, digits, hyphens; max 32)`);
  if (!botExists(name)) fail(`no bot '${name}' (no ${botYamlPath(name)})`);
  return name;
}

function doSync(bot, dryRun = false) {
  const r = sync(bot, { botcorpRoot: ROOT, dryRun });
  for (const [k, v] of Object.entries(r.report)) out(`${v.padEnd(14)} ${k}`);
  out(`sync: ${bot} ${dryRun ? '(dry-run) ' : ''}ok`);
  return r;
}

// `botcorp sync`: the generated files, plus the Telegram plugin in the config
// home when the module is on and it is missing (an imported or adopted bot).
// Not in daemon/sync.mjs: the tick runs that one and must not touch the network.
function cmdSync({ pos, flags }) {
  const bot = requireBot(pos[1]);
  const dryRun = !!flags['dry-run'];
  doSync(bot, dryRun);
  let telegram = false;
  try { telegram = !!loadBotYaml(botYamlPath(bot)).harness.modules.telegram; } catch {}
  if (!telegram || telegramPluginInstalled(bot)) return 0;
  if (dryRun) { out(`telegram plugin: missing from .claude-${bot}/plugins (sync without --dry-run installs it)`); return 0; }
  return installTelegramPlugin(bot) ? 0 : 1;
}

// ---- secrets (daemon/secrets.ps1) ---------------------------------------------------
const SECRETS_PS1 = path.join(ROOT, 'daemon', 'secrets.ps1');

// The value goes to the script on STDIN with -FromStdin; argv only ever carries
// the key name. Returns the child's exit code (3 = duplicate Telegram token).
function secretsSet(bot, key, value) {
  const r = runPwshFile(SECRETS_PS1, ['-Bot', bot, '-Action', 'set', '-Key', key, '-FromStdin', '-BotCorpRoot', ROOT], { stdin: value + '\n', timeoutMs: 60_000 });
  if (r.out.trim()) out(r.out.trim());
  if (r.err.trim()) process.stderr.write(r.err.trim() + '\n');
  if (r.timedOut) process.stderr.write('secrets: timed out\n');
  return r.code;
}

function secretsListJson(bot) {
  const r = runPwshFile(SECRETS_PS1, ['-Bot', bot, '-Action', 'list', '-Json', '-BotCorpRoot', ROOT], { timeoutMs: 60_000 });
  if (r.code !== 0) return { ok: false, err: (r.err || r.out).trim(), rows: [] };
  try {
    const parsed = JSON.parse(r.out.trim() || '[]');
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return { ok: true, rows: rows.map(({ key, masked, fp, updated_at }) => ({ key, masked, fp, updated_at })) };
  } catch { return { ok: false, err: 'secrets list: unparsable output', rows: [] }; }
}

async function readSecretValue(label) {
  if (stdinIsPiped()) return readStdinAll().trim();
  return promptHidden(label);
}

// state/secret-access.jsonl: one line per decrypt, written by daemon/vault.ps1.
// Audit history outlives bots, so this reads bot-name-as-filter, never through
// requireBot/botExists.
const SECRET_ACCESS_LOG = path.join(STATE_DIR, 'secret-access.jsonl');

function cmdSecretsAudit(bot, flags) {
  let text;
  try { text = fs.readFileSync(SECRET_ACCESS_LOG, 'utf-8'); }
  catch { out('no secret access recorded yet'); return 0; }
  let tail = 50;
  if (flags.tail !== undefined) {
    const n = parseInt(flags.tail, 10);
    if (!Number.isFinite(n) || n <= 0) usage('--tail needs a positive number');
    tail = Math.min(n, 5000);
  }
  const lines = text.split('\n').filter(Boolean).slice(-tail);
  const rows = [];
  for (const line of lines) { try { rows.push(JSON.parse(line)); } catch {} }
  const filtered = bot ? rows.filter((r) => r && r.bot === bot) : rows;
  if (flags.json) { outJson(filtered); return 0; }
  if (!filtered.length) { out('no secret access recorded yet'); return 0; }
  for (const r of filtered) {
    out(`${String(r.ts || '').padEnd(24)} ${String(r.bot || '').padEnd(12)} ${String(r.key || '').padEnd(20)} ${String(r.reason || '').padEnd(11)} ${String(r.pid ?? '').padEnd(7)} ${r.ok === false ? 'FAILED' : 'ok'}`);
  }
  return 0;
}

async function cmdSecrets({ pos, flags }) {
  const [, action, bot, key] = pos;
  if (!action) usage('secrets set|list|delete|acl|audit|migrate|lock|unlock|export-bundle|import-bundle <bot> [key]   (key = any name; oauth|telegram|hub alias oauth_token|telegram_token|hub_token; others reach automations as UPPERCASE env via automations[].secrets)');
  if (action === 'audit') return cmdSecretsAudit(bot, flags);
  requireBot(bot);
  if (action === 'list') {
    const r = flags.json ? secretsListJson(bot) : runPwshFile(SECRETS_PS1, ['-Bot', bot, '-Action', 'list', '-BotCorpRoot', ROOT], { timeoutMs: 60_000 });
    if (flags.json) { if (!r.ok) fail(r.err); outJson(r.rows); return 0; }
    if (r.out.trim()) out(r.out.trim());
    if (r.err.trim()) process.stderr.write(r.err.trim() + '\n');
    return r.code;
  }
  if (action === 'set') {
    if (!key) usage('secrets set <bot> <key>   (any key name, e.g. aws_secret_access_key; value on stdin, or a hidden prompt)');
    const value = await readSecretValue(`Value for ${bot}/${key} (hidden): `);
    if (!value) fail('secrets set: empty value');
    return secretsSet(bot, key, value);
  }
  if (action === 'delete') {
    if (!key) usage('secrets delete <bot> <key>');
    const r = runPwshFile(SECRETS_PS1, ['-Bot', bot, '-Action', 'delete', '-Key', key, '-BotCorpRoot', ROOT], { timeoutMs: 60_000 });
    if (r.out.trim()) out(r.out.trim());
    if (r.err.trim()) process.stderr.write(r.err.trim() + '\n');
    return r.code;
  }
  if (action === 'acl') return echoPs(runPwshFile(SECRETS_PS1, ['-Bot', bot, '-Action', 'acl', '-BotCorpRoot', ROOT], { timeoutMs: 60_000 }));
  if (action === 'migrate') return echoPs(runPwshFile(SECRETS_PS1, ['-Bot', bot, '-Action', 'migrate', '-BotCorpRoot', ROOT], { timeoutMs: 60_000 }));
  // Operator lock (docs/secrets.md): the passphrase travels on stdin to the
  // .ps1 exactly like a secret value, never on argv. `lock` on an already
  // locked vault re-locks without a passphrase (drops the until-reboot cache).
  if (action === 'lock') {
    const st = vaultLockState(bot);
    let stdin = null;
    if (st.mode !== 'operator') {
      const pass = await readSecretValue(`Operator passphrase to lock ${bot} (hidden; you will need it after every reboot): `);
      if (!pass) fail('secrets lock: empty passphrase');
      stdin = pass + '\n';
    }
    return echoPs(runPwshFile(SECRETS_PS1, ['-Bot', bot, '-Action', 'lock', '-BotCorpRoot', ROOT], { stdin, timeoutMs: 120_000 }));
  }
  if (action === 'unlock') {
    const pass = await readSecretValue(`Operator passphrase for ${bot} (hidden): `);
    if (!pass) fail('secrets unlock: empty passphrase');
    const args = ['-Bot', bot, '-Action', 'unlock', '-BotCorpRoot', ROOT];
    if (flags.permanent) args.push('-Permanent');
    return echoPs(runPwshFile(SECRETS_PS1, args, { stdin: pass + '\n', timeoutMs: 120_000 }));
  }
  // The encrypted bundle (daemon/bundle.ps1, docs/secrets.md): the passphrase
  // travels on stdin to the .ps1 exactly like a secret value, never on argv.
  if (action === 'export-bundle') {
    if (!flags.out) usage('secrets export-bundle <bot> --out <dir> [--files a,~/b]   (passphrase on stdin, or a hidden prompt; ~/x = relative to USERPROFILE, scope home)');
    const pass = await readSecretValue(`Bundle passphrase for ${bot} (hidden): `);
    if (!pass) fail('secrets export-bundle: empty passphrase');
    const args = ['-Bot', bot, '-Action', 'export-bundle', '-OutDir', path.resolve(String(flags.out)), '-BotCorpRoot', ROOT];
    // ONE comma-joined value: `pwsh -File` binds only the first of `-Files a b`.
    if (flags.files) args.push('-Files', String(flags.files).split(',').map((s) => s.trim()).filter(Boolean).join(','));
    return echoPs(runPwshFile(SECRETS_PS1, args, { stdin: pass + '\n', timeoutMs: 120_000 }));
  }
  if (action === 'import-bundle') {
    if (!key) usage('secrets import-bundle <bot> <bundle.enc> [--manifest <json>] [--dry-run] [--allow-home] [--force]   (passphrase on stdin, or a hidden prompt)');
    const bundle = path.resolve(key);
    if (!fs.existsSync(bundle)) fail(`secrets import-bundle: ${bundle} not found`);
    const pass = await readSecretValue(`Bundle passphrase for ${bot} (hidden): `);
    if (!pass) fail('secrets import-bundle: empty passphrase');
    const args = ['-Bot', bot, '-Action', 'import-bundle', '-Bundle', bundle, '-BotCorpRoot', ROOT];
    if (flags.manifest) args.push('-Manifest', path.resolve(String(flags.manifest)));
    if (flags['dry-run']) args.push('-DryRun');
    if (flags['allow-home']) args.push('-AllowHome');   // scope: home files (under USERPROFILE) restore only on request
    if (flags.force) args.push('-Force');               // existing targets are never overwritten silently
    return echoPs(runPwshFile(SECRETS_PS1, args, { stdin: pass + '\n', timeoutMs: 120_000 }));
  }
  usage(`secrets: unknown action '${action}'`);
}

// `secrets.ps1 -Action doctor -Json`: ACL state + lock state + one audited decrypt probe.
function secretsDoctorJson(bot) {
  const r = runPwshFile(SECRETS_PS1, ['-Bot', bot, '-Action', 'doctor', '-Json', '-BotCorpRoot', ROOT], { timeoutMs: 60_000 });
  if (r.code !== 0) return null;
  try { return JSON.parse(r.out.trim()); } catch { return null; }
}

// Lock state for `status` / the cockpit: {mode, version, locked, detail}. A v1
// vault or a DPAPI-wrapped v2 key is readable from key.json alone; whether an
// operator-locked vault has a good unlock cache for THIS boot only the vault
// code can tell (`secrets.ps1 -Action lock-state`, which decrypts no entry).
function vaultLockState(bot) {
  const kf = readJson(path.join(botHome(bot), '.vault', 'key.json'));
  if (!kf) return { mode: 'none', version: 1, locked: false, detail: `v1 vault (bot-name entropy); botcorp secrets migrate ${bot} moves it to a per-bot key` };
  if (kf.wraps && kf.wraps.dpapi) return { mode: 'none', version: 2, locked: false, detail: 'per-bot key, DPAPI-wrapped (readable across an unattended reboot)' };
  const r = runPwshFile(SECRETS_PS1, ['-Bot', bot, '-Action', 'lock-state', '-Json', '-BotCorpRoot', ROOT], { timeoutMs: 60_000 });
  try { if (r.code === 0) { const j = JSON.parse(r.out.trim()); return { mode: String(j.mode), version: Number(j.version) || 2, locked: !!j.locked, detail: String(j.detail || '') }; } } catch {}
  return { mode: 'operator', version: 2, locked: true, detail: `operator lock (state unreadable: ${(r.err || r.out).trim().split(/\r?\n/)[0].slice(0, 120)})` };
}

// Git for Windows bash for the hook probes (System32\bash.exe is WSL, not it).
function resolveBash() {
  if (process.platform !== 'win32') return findOnPath(['bash']) || 'bash';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  for (const c of [path.join(pf, 'Git', 'bin', 'bash.exe'), path.join(pf, 'Git', 'usr', 'bin', 'bash.exe')]) if (fs.existsSync(c)) return c;
  return findOnPath(['bash.exe'], { skip: /\\system32/i });
}

// Feed the vault-guard hook a synthetic Read of a SIBLING bot's vault and
// expect it to block (exit 2). This is the isolation a bot session actually
// gets: every bot runs as one Windows user, so no ACL can keep one bot's
// process out of another's vault - the tool guard is the boundary.
function vaultIsolationCheck(bot) {
  const hooks = readJson(path.join(ROOT, 'harness', 'hooks', 'hooks.json'));
  const registered = !!(hooks && (hooks.hooks?.PreToolUse || []).some((g) => /\bRead\b/.test(g.matcher || '') && /\bBash\b/.test(g.matcher || '') && (g.hooks || []).some((h) => /vault-guard\.sh/.test(h.command || ''))));
  if (!registered) return { level: 'FAIL', detail: 'harness/hooks/hooks.json does not register hooks/vault-guard.sh for Read|...|Bash' };
  const bash = resolveBash();
  if (!bash) return { level: 'WARN', detail: 'no bash to probe the hook (Git for Windows expected)' };
  const sibling = path.join(ROOT, 'bots', bot === 'other-bot' ? 'another-bot' : 'other-bot', '.vault', 'secrets.json');
  const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: sibling } });
  const r = run(bash, [path.join(ROOT, 'harness', 'hooks', 'vault-guard.sh')], { stdin: payload, timeoutMs: 30_000, env: { BOT_HOME: botHome(bot), BOT_NAME: bot, CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'harness') } });
  if (r.code === 2 && /BLOCKED/.test(r.err)) return { level: 'PASS', detail: 'vault-guard blocks a Read of a sibling .vault (exit 2)' };
  return { level: 'FAIL', detail: `vault-guard did NOT block a sibling .vault read (exit ${r.code}${r.timedOut ? ', timed out' : ''}): ${(r.err || r.out).trim().split(/\r?\n/)[0].slice(0, 120)}` };
}

// ---- accounts registry (daemon/accounts.ps1): logins for `chat`, separate from bots -----
const ACCOUNTS_PS1 = path.join(ROOT, 'daemon', 'accounts.ps1');
function accountsPs(args, opts = {}) { return runPwshFile(ACCOUNTS_PS1, [...args, '-BotCorpRoot', ROOT], { timeoutMs: 60_000, ...opts }); }
function accountsListJson() {
  const r = accountsPs(['-Action', 'list', '-Json']);
  if (r.code !== 0) return { ok: false, err: (r.err || r.out).trim(), rows: [] };
  try { const p = JSON.parse(r.out.trim() || '[]'); return { ok: true, rows: Array.isArray(p) ? p : [p] }; }
  catch { return { ok: false, err: 'accounts list: unparsable output', rows: [] }; }
}
function echoPs(r) {
  if (r.out.trim()) out(r.out.trim());
  if (r.err.trim()) process.stderr.write(r.err.trim() + '\n');
  if (r.timedOut) process.stderr.write('accounts: timed out\n');
  return r.code;
}

async function cmdAccounts({ pos, flags }) {
  const [, action, id] = pos;
  if (!action) usage('accounts add <id> [--label <text>] [--plan <text>] | list [--json] | remove <id> | seed');
  if (action === 'list') {
    if (!flags.json) return echoPs(accountsPs(['-Action', 'list']));
    const r = accountsListJson();
    if (!r.ok) fail(r.err);
    outJson(r.rows);
    return 0;
  }
  if (action === 'seed') return echoPs(accountsPs(['-Action', 'seed', ...(flags.json ? ['-Json'] : [])]));
  if (!id || !NAME_RE.test(id)) usage(`accounts ${action}: <id> required (lowercase, digits, hyphens; max 32)`);
  if (action === 'add') {
    const value = await readSecretValue(`Setup token for account ${id} (from \`claude setup-token\`; hidden): `);
    if (!value) fail('accounts add: empty token');
    const extra = [...(flags.label ? ['-Label', String(flags.label)] : []), ...(flags.plan ? ['-Plan', String(flags.plan)] : [])];
    return echoPs(accountsPs(['-Action', 'add', '-Id', id, '-FromStdin', ...extra], { stdin: value + '\n' }));
  }
  if (action === 'remove') return echoPs(accountsPs(['-Action', 'remove', '-Id', id]));
  usage(`accounts: unknown action '${action}'`);
}

// ---- chat: a plain interactive claude for an account, in its own WT tab (daemon/chat.ps1) ----
function readChatRecent() {
  const j = readJson(path.join(STATE_DIR, 'chat-recent.json'));
  return isObj(j) && Array.isArray(j.recent) ? j.recent.filter((r) => r && typeof r.cwd === 'string') : [];
}

async function cmdChat({ flags }) {
  const chatPs = path.join(ROOT, 'daemon', 'chat.ps1');
  const interactive = !!process.stdin.isTTY;
  let accts = accountsListJson();
  if (!accts.ok) fail(accts.err);
  if (!accts.rows.length) {
    // Zero-command setup: an empty registry is seeded from the bots' own tokens
    // on the first chat (install does not seed). After that, seeding is on demand.
    const r = accountsPs(['-Action', 'seed', '-Json']);
    let seeded = [];
    try { seeded = JSON.parse(r.out.trim() || '{}').seeded || []; } catch {}
    if (seeded.length) out(`chat: accounts registry was empty; seeded from the bots: ${seeded.map((s) => String(s).split(' ')[0]).join(', ')} (botcorp accounts list)`);
    accts = accountsListJson();
    if (!accts.ok) fail(accts.err);
    if (!accts.rows.length) fail('chat: no accounts and no bot holds an oauth_token to seed from (botcorp accounts add <id>)');
  }
  let account = flags.account ? String(flags.account) : '';
  if (!account) {
    if (accts.rows.length === 1) account = accts.rows[0].id;
    else if (!interactive) usage('chat: --account <id> required (botcorp accounts list)');
    else {
      out('account:');
      accts.rows.forEach((r, i) => out(`  ${i + 1}) ${r.id}  ${r.label}${r.plan ? ` (${r.plan})` : ''}  ${r.masked || '(no token)'}`));
      const ans = await promptVisible('Account [1]: ');
      const n = parseInt(ans || '1', 10);
      account = (accts.rows[n - 1] || {}).id || (accts.rows.find((r) => r.id === ans) || {}).id || '';
      if (!account) usage(`chat: no such account '${ans}'`);
    }
  }
  if (!accts.rows.some((r) => r.id === account)) fail(`chat: no account '${account}' (botcorp accounts list)`);
  let generic = !!flags.generic;
  let cwd = flags.cwd ? String(flags.cwd) : '';
  if (generic && cwd) usage('chat: --generic or --cwd, not both');
  if (!generic && !cwd) {
    if (!interactive) usage('chat: --cwd <folder> or --generic required');
    const recent = readChatRecent();
    out('workspace:');
    out('  1) generic (plain Claude, your user settings)');
    recent.forEach((r, i) => out(`  ${i + 2}) ${r.cwd}`));
    out('  b) browse for a folder');
    out('  or type a folder path');
    const ans = await promptVisible('Workspace [1]: ');
    if (!ans || ans === '1') generic = true;
    else if (/^[bB]$/.test(ans)) {
      const r = runPwshCommand("Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Folder for the new chat'; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }", { timeoutMs: 300_000 });
      cwd = r.out.trim();
      if (!cwd) fail('chat: no folder chosen');
    } else if (/^\d+$/.test(ans) && recent[parseInt(ans, 10) - 2]) cwd = recent[parseInt(ans, 10) - 2].cwd;
    else cwd = ans;
  }
  if (cwd && !fs.existsSync(cwd)) fail(`chat: folder not found: ${cwd}`);
  const args = ['-Account', account, ...(generic ? ['-Generic'] : ['-Cwd', path.resolve(cwd)]), ...(flags['dry-run'] ? ['-DryRun'] : [])];
  const r = runPwshFile(chatPs, args, { timeoutMs: 60_000 });
  return echoPs(r);
}

// ---- attach / tray (daemon/attach.ps1, daemon/tray-register.ps1) -------------------------
function cmdAttach({ pos, flags }) {
  const bot = requireBot(pos[1]);
  const r = runPwshFile(path.join(ROOT, 'daemon', 'attach.ps1'), ['-Bot', bot, ...(flags.elevate ? ['-Elevate'] : []), ...(flags['dry-run'] ? ['-DryRun'] : [])], { timeoutMs: 60_000 });
  return echoPs(r);
}

function cmdTray({ pos, flags }) {
  const bot = requireBot(pos[1]);
  const action = pos[2] || 'status';
  const map = { on: [...(flags['attach-at-login'] ? ['-AttachAtLogin'] : [])], off: ['-Remove'], status: ['-Status'] };
  if (!(action in map)) usage('tray <bot> on [--attach-at-login] | off | status');
  const r = runPwshFile(path.join(ROOT, 'daemon', 'tray-register.ps1'), ['-Bot', bot, ...map[action], ...(flags['dry-run'] ? ['-DryRun'] : [])], { timeoutMs: 60_000 });
  return echoPs(r);
}

// ---- pairing (access.json + approved/<id> + bot.yaml) --------------------------------
function accessPath(bot) { return path.join(configDir(bot), 'channels', 'telegram', 'access.json'); }

function readAccess(bot) {
  const cur = readJson(accessPath(bot));
  const base = { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} };
  const data = isObj(cur) ? { ...base, ...cur } : base;
  if (!Array.isArray(data.allowFrom)) data.allowFrom = [];
  if (!isObj(data.pending)) data.pending = {};
  if (!isObj(data.groups)) data.groups = {};
  return { data, present: isObj(cur) };
}

function idValue(id) {
  const s = String(id);
  return /^[0-9]{1,15}$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : s;
}

// What the official plugin's access skill does on approve, plus bot.yaml so
// sync and the file agree. Idempotent.
function pairApply(bot, senderId, { touchYaml = true } = {}) {
  const id = String(senderId);
  const { data } = readAccess(bot);
  const had = data.allowFrom.map(String).includes(id);
  if (!had) data.allowFrom.push(id);
  let cleared = 0;
  for (const [code, p] of Object.entries(data.pending)) {
    if (String(p && p.senderId) === id) { delete data.pending[code]; cleared++; }
  }
  writeJsonAtomic(accessPath(bot), data);
  const approvedDir = path.join(configDir(bot), 'channels', 'telegram', 'approved');
  fs.mkdirSync(approvedDir, { recursive: true });
  const approvedFile = path.join(approvedDir, id);
  if (!fs.existsSync(approvedFile)) fs.writeFileSync(approvedFile, '');
  let yamlChanged = false;
  if (touchYaml) {
    const raw = loadRawYaml(bot);
    raw.integrations = isObj(raw.integrations) ? raw.integrations : {};
    raw.integrations.telegram = isObj(raw.integrations.telegram) ? raw.integrations.telegram : {};
    const list = Array.isArray(raw.integrations.telegram.allow_from) ? raw.integrations.telegram.allow_from : [];
    if (!list.map(String).includes(id)) { list.push(idValue(id)); yamlChanged = true; }
    raw.integrations.telegram.allow_from = list;
    if (yamlChanged) writeRawYaml(bot, raw);
  }
  return { added: !had, cleared, yamlChanged, approvedFile };
}

// What the cockpit's pairing panel shows. Ages in seconds so a UI can format
// them; a negative expires_in_s = the code has expired (the plugin prunes it).
function pairingState(bot) {
  const { data, present } = readAccess(bot);
  const now = Date.now();
  const pending = Object.entries(data.pending).map(([code, p]) => ({
    code: String(code).slice(0, 12),
    senderId: String(p?.senderId ?? ''),
    chatId: String(p?.chatId ?? ''),
    age_s: Number(p?.createdAt) ? Math.max(0, Math.round((now - Number(p.createdAt)) / 1000)) : null,
    expires_in_s: Number(p?.expiresAt) ? Math.round((Number(p.expiresAt) - now) / 1000) : null,
  })).filter((p) => SENDER_RE.test(p.senderId));
  return { present, file: accessPath(bot), policy: data.dmPolicy, allowFrom: data.allowFrom.map(String), pending };
}

function pairDeny(bot, senderId) {
  const { data } = readAccess(bot);
  let removed = 0;
  for (const [code, p] of Object.entries(data.pending)) {
    if (String(p && p.senderId) === String(senderId)) { delete data.pending[code]; removed++; }
  }
  if (removed) writeJsonAtomic(accessPath(bot), data);
  return removed;
}

function cmdPair({ pos, flags }) {
  const [, bot, senderId] = pos;
  requireBot(bot);
  if (flags.deny) {
    const id = String(flags.deny);
    if (!SENDER_RE.test(id)) usage('--deny takes a numeric Telegram sender id');
    const n = pairDeny(bot, id);
    if (flags.json) { outJson({ denied: id, removed: n }); return 0; }
    out(n ? `pair: denied ${id}: ${n} pending code(s) removed` : `pair: no pending code for ${id} (nothing to deny)`);
    return 0;
  }
  if (flags.list || !senderId) {
    if (!flags.list) usage('pair <bot> <senderId> | pair <bot> --list [--json] | pair <bot> --deny <senderId>');
    const st = pairingState(bot);
    if (flags.json) { outJson(st); return 0; }
    out(`access.json: ${st.present ? st.file : 'absent (start the bot with telegram on once, or pair an id to create it)'}`);
    out(`dm_policy: ${st.policy}`);
    out(`allowFrom: ${st.allowFrom.length ? st.allowFrom.join(', ') : '(none)'}`);
    if (!st.pending.length) out('pending: (none)');
    for (const p of st.pending) out(`pending: senderId=${p.senderId} chatId=${p.chatId} age=${p.age_s === null ? '?' : humanAge(p.age_s * 1000)}${p.expires_in_s !== null && p.expires_in_s < 0 ? ' (expired)' : ''}`);
    return 0;
  }
  if (!SENDER_RE.test(senderId)) usage('senderId must be a numeric Telegram id');
  const r = pairApply(bot, senderId);
  out(`pair: ${bot} allowFrom ${r.added ? 'added' : 'already had'} ${senderId}`);
  out(`pair: pending entries cleared: ${r.cleared}`);
  out(`pair: approved marker ${r.approvedFile}`);
  out(`pair: bot.yaml integrations.telegram.allow_from ${r.yamlChanged ? 'updated' : 'unchanged'}`);
  doSync(bot);
  return 0;
}

// ---- config: the guarded writer -------------------------------------------------------
const AUTOMATION_FIELDS = new Set(['enabled', 'secrets', 'timeout_min', 'max_per_day', 'idle_gated', 'critical', 'command', 'trigger', 'backoff']);
const DM_RANK = { disabled: 0, allowlist: 1, pairing: 2 };   // higher = accepts more senders

function parseValue(text) {
  const t = String(text ?? '').trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^\[.*\]$/s.test(t)) {
    const inner = t.slice(1, -1).trim();
    return inner ? inner.split(',').map((s) => parseValue(s)) : [];
  }
  return t;
}

function splitPath(dotted) {
  const segs = String(dotted || '').split('.').filter(Boolean);
  if (!segs.length) usage('a dotted path is required, e.g. harness.modules.telegram');
  return segs;
}

// Every path must exist in DEFAULTS (typo guard); automations elements are
// addressed by name or index and take a known field.
function checkKnownPath(segs, { forGet = false } = {}) {
  if (segs[0] === 'name' && !forGet) fail('config set: renaming a bot is not supported here (the folder and the config home would have to move)');
  let d = DEFAULTS;
  for (let i = 0; i < segs.length; i++) {
    const k = segs[i];
    if (Array.isArray(d)) {
      const field = segs[i + 1];
      if (segs[0] !== 'automations' || !field || !AUTOMATION_FIELDS.has(field) || i + 2 !== segs.length) {
        fail(`config: unknown path ${segs.join('.')} (automations.<name>.<${[...AUTOMATION_FIELDS].join('|')}>)`);
      }
      return;
    }
    if (!isObj(d) || !(k in d)) fail(`config: unknown path ${segs.join('.')}`);
    d = d[k];
  }
}

function findElem(list, key) {
  if (/^\d+$/.test(key)) return list[Number(key)];
  return list.find((e) => isObj(e) && String(e.name) === key);
}

function getDeep(obj, segs) {
  let cur = obj;
  for (const k of segs) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) ? findElem(cur, k) : cur[k];
  }
  return cur;
}

function setDeep(obj, segs, value) {
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i];
    if (Array.isArray(cur)) {
      const el = findElem(cur, k);
      if (!el) fail(`config: no automation '${k}' in bot.yaml`);
      cur = el;
    } else {
      if (i === 0 && k === 'automations' && !Array.isArray(cur[k])) fail(`config: no automation '${segs[1]}' in bot.yaml`);
      if (cur[k] === undefined || cur[k] === null) cur[k] = {};
      if (!isObj(cur[k]) && !Array.isArray(cur[k])) fail(`config: ${segs.slice(0, i + 1).join('.')} is a scalar, cannot descend`);
      cur = cur[k];
    }
  }
  const last = segs[segs.length - 1];
  if (Array.isArray(cur)) fail('config: cannot replace a list element wholesale');
  cur[last] = value;
}

function listOf(v) { return Array.isArray(v) ? v.map(String) : []; }

// "Widening" = the change lets more people or more capability reach the bot.
// Those never apply from a chat message; they wait in the approval queue.
function isWidening(cfg, segs, value) {
  const p = segs.join('.');
  if (p === 'integrations.telegram.allow_from') {
    const cur = listOf(cfg.integrations.telegram.allow_from);
    return listOf(value).some((id) => !cur.includes(id)) ? 'adds a Telegram sender' : null;
  }
  if (p === 'integrations.telegram.dm_policy') {
    const a = DM_RANK[cfg.integrations.telegram.dm_policy] ?? 0, b = DM_RANK[value];
    if (b === undefined) return null;   // validate() rejects it later
    return b > a ? `loosens dm_policy ${cfg.integrations.telegram.dm_policy} -> ${value}` : null;
  }
  if (p === 'permissions') return value === 'bypass' && cfg.permissions !== 'bypass' ? 'switches permissions to bypass' : null;
  if (p === 'harness.modules.remote_control') return value === true && cfg.harness.modules.remote_control !== true ? 'enables Remote Control' : null;
  if (segs[0] === 'automations' && segs[2] === 'secrets') {
    const el = findElem(cfg.automations, segs[1]);
    const cur = listOf(el && el.secrets);
    return listOf(value).some((k) => !cur.includes(k)) ? 'injects a vault secret into an automation' : null;
  }
  return null;
}

// Apply to the RAW file (so the file stays minimal), validate the effective
// result before writing, then sync.
function applySet(bot, segs, value) {
  const raw = loadRawYaml(bot);
  setDeep(raw, segs, value);
  const effective = deepMerge(DEFAULTS, raw);
  if (!effective.name) effective.name = bot;
  const errs = validate(effective);
  if (errs.length) fail(`config set: rejected, bot.yaml would be invalid:\n  ${errs.join('\n  ')}`);
  writeRawYaml(bot, raw);
}

function approvalsPath(bot) { return path.join(STATE_DIR, `${bot}.approvals.json`); }
function readApprovals(bot) { const a = readJson(approvalsPath(bot)); return Array.isArray(a) ? a : []; }
function writeApprovals(bot, list) { writeJsonAtomic(approvalsPath(bot), list); }
function logApproval(bot, line) {
  try {
    const f = path.join(BOTCORP_HOME, 'logs', bot, 'approvals.log');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `${new Date().toISOString()}  ${line}\n`);
  } catch {}
}

function requestedBy(flags) {
  if (flags['requested-by']) return String(flags['requested-by']);
  if (process.env.BOT_NAME) return `bot:${process.env.BOT_NAME}`;
  return `operator:${process.env.USERNAME || process.env.USER || 'unknown'}`;
}

function cmdConfig({ pos, flags }) {
  const [, action, bot, dotted, ...rest] = pos;
  if (!action) usage('config get <bot> <path> | config set <bot> <path> <value>');
  requireBot(bot);
  if (action === 'get') {
    const cfg = loadBotYaml(botYamlPath(bot));
    if (!dotted) { if (flags.json) outJson(cfg); else out(dumpYaml(cfg).trimEnd()); return 0; }
    const segs = splitPath(dotted);
    checkKnownPath(segs, { forGet: true });
    const v = getDeep(cfg, segs);
    if (flags.json) outJson({ path: dotted, value: v === undefined ? null : v });
    else out(typeof v === 'string' ? v : JSON.stringify(v === undefined ? null : v));
    return 0;
  }
  if (action !== 'set') usage(`config: unknown action '${action}'`);
  if (!dotted || rest.length === 0) usage('config set <bot> <path> <value>');
  const segs = splitPath(dotted);
  checkKnownPath(segs);
  const value = parseValue(rest.join(' '));
  const cfg = loadBotYaml(botYamlPath(bot));
  const why = isWidening(cfg, segs, value);
  if (why) {
    const entry = { id: crypto.randomBytes(3).toString('hex'), ts: new Date().toISOString(), path: segs.join('.'), value, requested_by: requestedBy(flags), reason: why };
    const q = readApprovals(bot);
    q.push(entry);
    writeApprovals(bot, q);
    logApproval(bot, `QUEUED ${entry.id} ${entry.path}=${JSON.stringify(value)} by ${entry.requested_by} (${why})`);
    out(`not applied: ${entry.path} ${why}`);
    out(`queued for operator approval: botcorp approve ${bot} ${entry.id}`);
    if (flags.json) outJson({ applied: false, queued: entry });
    return 0;
  }
  applySet(bot, segs, value);
  out(`config: ${bot} ${segs.join('.')} = ${JSON.stringify(value)} (applied; takes effect at the next session roll)`);
  doSync(bot);
  return 0;
}

function applyApproved(bot, entry) {
  const segs = splitPath(entry.path);
  const before = loadBotYaml(botYamlPath(bot));
  applySet(bot, segs, entry.value);
  const notes = [];
  if (entry.path === 'integrations.telegram.allow_from') {
    const added = listOf(entry.value).filter((id) => !listOf(before.integrations.telegram.allow_from).includes(id));
    const after = loadBotYaml(botYamlPath(bot));
    if (after.harness.modules.telegram) {
      for (const id of added) { if (SENDER_RE.test(id)) { pairApply(bot, id, { touchYaml: false }); notes.push(`access.json + approved/${id} written`); } }
    } else notes.push('telegram module off: access.json not written (sync writes it once harness.modules.telegram is true)');
  }
  return notes;
}

function cmdApprove({ pos, flags }) {
  const [, bot, id] = pos;
  requireBot(bot);
  const q = readApprovals(bot);
  if (flags.list) {
    if (flags.json) { outJson(q); return 0; }
    if (!q.length) { out(`approvals: ${bot} queue empty`); return 0; }
    for (const e of q) out(`${e.id}  ${e.ts}  ${e.path} = ${JSON.stringify(e.value)}  by ${e.requested_by}  (${e.reason || 'widening'})`);
    return 0;
  }
  if (!id && !flags.all) usage('approve <bot> <id|--all> | approve <bot> --list');
  const pick = flags.all ? q : q.filter((e) => e.id === id);
  if (!pick.length) { if (flags.all) { out(`approvals: ${bot} queue empty`); return 0; } fail(`approve: no pending entry ${id} for ${bot}`); }
  const remaining = q.filter((e) => !pick.includes(e));
  for (const e of pick) {
    const notes = applyApproved(bot, e);
    logApproval(bot, `APPROVED ${e.id} ${e.path}=${JSON.stringify(e.value)}`);
    out(`approved ${e.id}: ${e.path} = ${JSON.stringify(e.value)}`);
    for (const n of notes) out(`  ${n}`);
  }
  writeApprovals(bot, remaining);
  doSync(bot);
  out(`approvals: ${remaining.length} pending`);
  return 0;
}

function cmdReject({ pos }) {
  const [, bot, id] = pos;
  requireBot(bot);
  if (!id) usage('reject <bot> <id>');
  const q = readApprovals(bot);
  const e = q.find((x) => x.id === id);
  if (!e) fail(`reject: no pending entry ${id} for ${bot}`);
  writeApprovals(bot, q.filter((x) => x !== e));
  logApproval(bot, `REJECTED ${e.id} ${e.path}=${JSON.stringify(e.value)}`);
  out(`rejected ${e.id}: ${e.path} = ${JSON.stringify(e.value)}`);
  return 0;
}

// ---- start / stop / restart (daemon/pty-host.mjs) ---------------------------------------
const PTY_HOST = path.join(ROOT, 'daemon', 'pty-host.mjs');
const pausedPath = bot => path.join(STATE_DIR, `${bot}.paused`);

// bot.yaml harness.session: bg (claude --bg under the daemon's launcher; the
// cockpit attaches) | pty (the bot runs inside pty-host). docs/host-service.md.
function sessionKind(bot) {
  try { return loadBotYaml(botYamlPath(bot)).harness.session === 'pty' ? 'pty' : 'bg'; } catch { return 'bg'; }
}
function botState(bot) { return readJson(path.join(STATE_DIR, `${bot}.json`)) || {}; }

// Launch attestation (docs/secrets.md): `botcorp start` is a trusted start
// path. It mints a 32-byte nonce, records ONLY its sha256 in state/<bot>.json
// `launch` (state files are readable by every process of this user) and hands
// the raw nonce to launch.ps1 in the environment - never argv, never disk.
// Without it launch.ps1 runs unattested: no secrets injected.
function mintLaunchNonce(bot) {
  const nonce = crypto.randomBytes(32).toString('hex');
  const file = path.join(STATE_DIR, `${bot}.json`);
  const st = readJson(file) || { bot };
  st.launch = {
    nonce_sha256: crypto.createHash('sha256').update(nonce, 'utf8').digest('hex'),
    minted_by_pid: process.pid,
    at: new Date().toISOString(),
    at_unix: Math.floor(Date.now() / 1000),
    consumed_at: null,
  };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(st, null, 2) + '\n');
  return nonce;
}

async function startBot(bot, fresh, debug = false) {
  // The daemon skips cold-starting a paused bot; an explicit start un-pauses it.
  try { fs.unlinkSync(pausedPath(bot)); } catch {}
  const lock = vaultLockState(bot);
  if (lock.locked) fail(`${bot}: vault is LOCKED (operator lock, not unlocked since boot) - a launch now would run without secrets. Unlock first: botcorp secrets unlock ${bot} (or the cockpit)`);
  if (sessionKind(bot) === 'bg') {
    const st = botState(bot);
    if (st.bg_id && pidAlive(Number(st.claude_pid))) fail(`${bot} is already running (background session ${st.bg_id}, pid ${st.claude_pid}); use restart`);
    const args = ['-Bot', bot, '-Bg', '-StartedBy', 'cli', ...(fresh ? ['-Fresh'] : []), ...(debug ? ['-DebugLog'] : [])];
    const r = runPwshFile(path.join(ROOT, 'daemon', 'launch.ps1'), args, { timeoutMs: 150_000, env: { BOTCORP_LAUNCH_NONCE: mintLaunchNonce(bot) } });
    for (const l of (r.out + r.err).split(/\r?\n/)) if (l.trim()) out(l.trim());
    if (r.code !== 0) fail(`start: launch.ps1 -Bg exited ${r.code}`);
    const after = botState(bot);
    out(`started ${bot}: background session ${after.bg_id || '?'} (session_id ${after.session_id || '?'}, pid ${after.claude_pid || '?'}); attach: claude attach ${after.bg_id || '<id>'} (elevated) or the cockpit`);
    return 0;
  }
  const live = ptyLive(bot);
  if (live) fail(`${bot} is already running (pty host pid ${live.pid}, pty pid ${live.ptyPid}); use restart`);
  if (debug) out('start: --debug applies to bg bots; a pty bot takes bot.yaml harness.debug: true (botcorp config set <bot> harness.debug true)');
  // pty-host passes its environment to the pwsh running launch.ps1 inside the pty.
  const pid = spawnDetached(process.execPath, [PTY_HOST, '--bot', bot, '--botcorp', ROOT, fresh ? '--fresh' : '--continue'], { env: { BOTCORP_LAUNCH_NONCE: mintLaunchNonce(bot) } });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const rec = ptyLive(bot);
    if (rec) {
      out(`started ${bot}: pty pid=${rec.ptyPid} host pid=${rec.pid} ws=127.0.0.1:${rec.port} mode=${rec.mode}`);
      return 0;
    }
    if (!pidAlive(pid)) break;
    await sleep(250);
  }
  fail(`start: ${bot} pty-host (pid ${pid}) did not publish ${ptyJsonPath(bot)} within 10 s${pidAlive(pid) ? '' : ' (it exited)'}`);
}

function stopBot(bot) {
  const before = ptyLive(bot);
  if (sessionKind(bot) === 'bg') {
    // claude stop <bg id> + the guarded tree-kill (daemon/stop.ps1); the
    // conversation is kept, the next start resumes it.
    const r = runPwshFile(path.join(ROOT, 'daemon', 'stop.ps1'), ['-Bot', bot], { timeoutMs: 90_000 });
    for (const l of (r.out + r.err).split(/\r?\n/)) if (l.trim()) out(l.trim());
    if (r.code !== 0) fail(`stop: stop.ps1 exited ${r.code}`);
  } else {
    const r = run(process.execPath, [PTY_HOST, '--stop', bot], { timeoutMs: 60_000 });
    for (const l of (r.out + r.err).split(/\r?\n/)) if (l.trim()) out(l.trim());
    if (r.code !== 0) fail(`stop: pty-host --stop exited ${r.code}`);
  }
  // Without this marker the daemon's next tick would cold-start the bot again.
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(pausedPath(bot), `${new Date().toISOString()} botcorp stop\n`);
  // The plugin's own stale-pid cleanup needs `ps` and is a no-op on Windows;
  // a dead bot.pid / owner-lock would make the next launch think the poller
  // is foreign and start WITHOUT --channels.
  const cfg = configDir(bot);
  const botPid = path.join(cfg, 'channels', 'telegram', 'bot.pid');
  if (fs.existsSync(botPid)) {
    const p = firstInt(fs.readFileSync(botPid, 'utf-8'));
    if (!pidAlive(p)) { fs.unlinkSync(botPid); out(`stop: removed stale bot.pid (pid ${p} dead)`); }
    else out(`stop: bot.pid ${p} still alive (left in place)`);
  }
  const lock = path.join(cfg, 'botcorp', 'tg_owner.lock');
  if (fs.existsSync(lock)) {
    const p = firstInt(fs.readFileSync(lock, 'utf-8').split(/\r?\n/)[0]);
    if (!pidAlive(p)) { fs.unlinkSync(lock); out(`stop: removed stale tg_owner.lock (owner ${p} dead)`); }
    else out(`stop: tg_owner.lock owner ${p} still alive (left in place)`);
  }
  return before;
}

async function cmdStart({ pos, flags }) { return startBot(requireBot(pos[1]), !!flags.fresh, !!flags.debug); }
async function cmdStop({ pos }) { stopBot(requireBot(pos[1])); return 0; }

async function cmdRestart({ pos, flags }) {
  const bot = requireBot(pos[1]);
  const before = stopBot(bot);
  if (before) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && pidAlive(before.ptyPid)) await sleep(250);
    if (pidAlive(before.ptyPid)) fail(`restart: old pty pid ${before.ptyPid} still alive after 10 s`);
  }
  if (flags.fresh) {
    // < 300 s old = launch.ps1 honours it and starts FRESH (one-shot marker).
    const marker = path.join(botHome(bot), '.claude', '.botcorp_fresh_restart');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString() + '\n');
    out(`restart: fresh marker ${marker}`);
  }
  return startBot(bot, !!flags.fresh, !!flags.debug);
}

// ---- status -----------------------------------------------------------------------------
function botStatus(bot) {
  let cfg = null, yamlError = null;
  try { cfg = loadBotYaml(botYamlPath(bot)); const errs = validate(cfg); if (errs.length) yamlError = errs.join('; '); }
  catch (e) { yamlError = e.message; }
  const pty = ptyLive(bot);
  const state = readJson(path.join(STATE_DIR, `${bot}.json`));
  // Liveness is measured, never read back from the state file: a bg bot whose
  // claude worker died leaves `poller: OWNED` behind, so the poller is only
  // reported while a claude (or pty) process is actually alive; a live bun
  // poller with no claude is an orphan. While alive, OWNED needs the plugin's
  // bot.pid alive under this bot's claude (pollerVerdict); otherwise DEAD.
  const claudeAlive = !!(state && pidAlive(Number(state.claude_pid)));
  let botPid = 0;
  try { botPid = firstInt(fs.readFileSync(path.join(configDir(bot), 'channels', 'telegram', 'bot.pid'), 'utf-8')); } catch {}
  const alive = !!pty || claudeAlive;
  const botPidAlive = pidAlive(botPid);
  const telegram = !!(cfg && cfg.harness.modules.telegram);
  let underClaude = null;
  if (alive && telegram && botPidAlive) {
    const parents = processParents();
    const root = claudeAlive ? Number(state.claude_pid) : Number(pty && pty.ptyPid);
    if (parents) underClaude = isDescendant(parents, botPid, root);
  }
  const poller = pollerVerdict({ alive, telegram, recorded: (state && state.poller) ?? null, botPid, botPidAlive, underClaude });
  const status = readJson(path.join(configDir(bot), 'botcorp', 'status.json'));
  let statusAgeS = null, ctxUsedPct = null, rateLimits = null;
  if (status) {
    statusAgeS = Number.isFinite(status.ts) ? Math.round(Date.now() / 1000 - status.ts) : null;
    const rem = status.context_window && status.context_window.remaining_percentage;
    ctxUsedPct = Number.isFinite(rem) ? Math.round(100 - rem) : null;
    const rl = status.rate_limits || {};
    rateLimits = {
      five_hour: rl.five_hour ? { used_percentage: rl.five_hour.used_percentage ?? null, resets_at: rl.five_hour.resets_at ?? null } : null,
      seven_day: rl.seven_day ? { used_percentage: rl.seven_day.used_percentage ?? null, resets_at: rl.seven_day.resets_at ?? null } : null,
    };
  }
  return {
    name: bot,
    running: alive,
    pty: ptyPublic(pty),
    state: state ? { status: alive ? state.status ?? null : 'stopped', started_by: state.started_by ?? null, poller, claude_pid: claudeAlive ? state.claude_pid : null, started_at: state.started_at ?? null } : null,
    telegram,
    poller_pid: botPidAlive ? botPid : null,
    model: cfg ? cfg.model : null,
    vault: vaultLockState(bot),
    harness_version: harnessVersion(),
    yaml_error: yamlError,
    status_json: status ? { age_s: statusAgeS, ctx_used_pct: ctxUsedPct, rate_limits: rateLimits, version: status.version ?? null } : null,
    approvals_pending: readApprovals(bot).length,
  };
}

function pct(v) { return v === null || v === undefined ? '?' : `${Math.round(Number(v))}%`; }

function printStatus(s) {
  out(`bot: ${s.name}`);
  out(`  running: ${s.running ? 'yes' : 'no'}`);
  if (s.pty) out(`  pty: pid=${s.pty.ptyPid} host=${s.pty.pid} ws=127.0.0.1:${s.pty.port} mode=${s.pty.mode} since=${s.pty.startedAt}`);
  if (s.state) out(`  state: status=${s.state.status} started_by=${s.state.started_by} poller=${s.state.poller}${s.poller_pid ? ` bot.pid=${s.poller_pid}` : ''} claude_pid=${s.state.claude_pid ?? '-'}`);
  else out('  state: (no state.json yet)');
  out(`  telegram: ${s.telegram ? 'on' : 'off'}  model: ${s.model ?? '?'}  harness: ${s.harness_version ? 'v' + s.harness_version : '?'}`);
  out(`  vault: ${s.vault.mode} v${s.vault.version}${s.vault.locked ? ` LOCKED - botcorp secrets unlock ${s.name}` : ''}`);
  if (s.yaml_error) out(`  bot.yaml: INVALID - ${s.yaml_error}`);
  if (s.status_json) {
    const rl = s.status_json.rate_limits || {};
    out(`  status.json: ${s.status_json.age_s}s ago  ctx used ${pct(s.status_json.ctx_used_pct)}  5h ${pct(rl.five_hour && rl.five_hour.used_percentage)} / 7d ${pct(rl.seven_day && rl.seven_day.used_percentage)}  cc ${s.status_json.version ?? '?'}`);
  } else out('  status.json: absent (written by the statusline once a session renders)');
  out(`  approvals pending: ${s.approvals_pending}`);
}

function cmdStatus({ pos, flags }) {
  const names = pos[1] ? [requireBot(pos[1])] : listBots();
  const all = names.map(botStatus);
  if (flags.json) { outJson(pos[1] ? all[0] : all); return 0; }
  if (!all.length) out('status: no bots under bots/ (botcorp new)');
  all.forEach(printStatus);
  return 0;
}

// ---- automations ---------------------------------------------------------------------------
function cmdAutomations({ pos, flags }) {
  const [, bot, action = 'list', name] = pos;
  requireBot(bot);
  const cfg = loadBotYaml(botYamlPath(bot));
  const list = Array.isArray(cfg.automations) ? cfg.automations : [];
  if (action === 'list') {
    const stateFile = path.join(STATE_DIR, bot, 'automations.json');
    const st = readJson(stateFile);
    const byName = (n) => (Array.isArray(st) ? st.find((x) => x && x.name === n) : isObj(st) ? st[n] : null) || null;
    const rows = list.map((a) => ({ name: a.name, enabled: a.enabled !== false, trigger: a.trigger || null, command: a.command, state: byName(a.name) }));
    if (flags.json) { outJson({ bot, state_file: st ? stateFile : null, automations: rows }); return 0; }
    if (!rows.length) { out(`automations: ${bot} has none (bot.yaml automations: [])`); return 0; }
    out(`daemon state: ${st ? stateFile : 'absent (no daemon run yet)'}`);
    for (const r of rows) {
      const s = r.state ? Object.entries(r.state).filter(([k]) => ['last_run', 'last_status', 'next_due', 'failure_streak', 'runs_today', 'last_exit'].includes(k)).map(([k, v]) => `${k}=${v}`).join(' ') : '';
      out(`${r.enabled ? 'on ' : 'off'}  ${r.name}  trigger=${JSON.stringify(r.trigger)}  command=${r.command}${s ? '  ' + s : ''}`);
    }
    return 0;
  }
  if (!name) usage(`automations <bot> ${action} <name>`);
  if (!list.some((a) => a.name === name)) fail(`automations: no '${name}' in ${bot}'s bot.yaml`);
  if (action === 'pause' || action === 'resume') {
    return cmdConfig({ pos: ['config', 'set', bot, `automations.${name}.enabled`, action === 'resume' ? 'true' : 'false'], flags });
  }
  if (action === 'run') {
    const q = path.join(STATE_DIR, bot, 'events', 'run-now.queue');
    fs.mkdirSync(path.dirname(q), { recursive: true });
    fs.appendFileSync(q, JSON.stringify({ automation: name, ts: new Date().toISOString() }) + '\n');
    out(`automations: queued run-now for ${name} in ${q} (the daemon's automations tick consumes it)`);
    return 0;
  }
  usage(`automations: unknown action '${action}' (list|pause|resume|run)`);
}

// ---- new ------------------------------------------------------------------------------------
function firstFreeName() {
  for (let i = 1; i < 1000; i++) { const n = `bot-${i}`; if (!fs.existsSync(botHome(n))) return n; }
  fail('new: no free bot-N name');
}

function gitIdentity() {
  const name = run(gitExe(), ['-C', ROOT, 'config', '--get', 'user.name'], { timeoutMs: 15_000 }).out.trim();
  const email = run(gitExe(), ['-C', ROOT, 'config', '--get', 'user.email'], { timeoutMs: 15_000 }).out.trim();
  return name && email ? { name, email } : { name: 'botcorp', email: 'botcorp@users.noreply.github.com' };
}

function git(cwd, args, timeoutMs = 60_000) {
  const r = run(gitExe(), ['-C', cwd, ...args], { timeoutMs, env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });
  if (r.code !== 0) fail(`git ${args[0]} failed (${r.code}): ${(r.err || r.out).trim()}`);
  return r;
}

function installTelegramPlugin(bot) {
  const env = { CLAUDE_CONFIG_DIR: configDir(bot) };
  const steps = [
    // The owner/repo shorthand clones over SSH (fails without a GitHub key);
    // the https form works everywhere. docs/cc-compat.md.
    ['marketplace add', ['plugin', 'marketplace', 'add', 'https://github.com/anthropics/claude-plugins-official']],
    ['install', ['plugin', 'install', 'telegram@claude-plugins-official', '--scope', 'user']],
    // Installed but DISABLED: enablement rides in ONLY via --settings
    // tg-enable.settings.json when the launcher owns the poller lock.
    ['disable', ['plugin', 'disable', 'telegram@claude-plugins-official']],
  ];
  out(`telegram plugin: using ${resolveClaude()} with CLAUDE_CONFIG_DIR=${configDir(bot)}`);
  for (const [label, args] of steps) {
    const r = runClaude(args, { env, timeoutMs: 180_000, cwd: botHome(bot) });
    const tail = (r.out + r.err).trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || '';
    out(`telegram plugin ${label}: ${r.timedOut ? 'TIMEOUT (180 s)' : r.code === 0 ? 'ok' : `exit ${r.code}`}${tail ? ' - ' + tail.slice(0, 160) : ''}`);
    if (r.code !== 0 && label !== 'disable') return false;
  }
  return true;
}

// `new` installs the plugin into the config home; `import` and `adopt` never
// did, so such a bot's `--channels` named a plugin that was not there.
function telegramPluginInstalled(bot) {
  const j = readJson(path.join(configDir(bot), 'plugins', 'installed_plugins.json'));
  const rows = j && j.plugins && j.plugins['telegram@claude-plugins-official'];
  return Array.isArray(rows) && rows.some((r) => r && r.installPath && fs.existsSync(path.join(r.installPath, 'server.ts')));
}

// The plugin's own stderr lands in Claude Code's per-project MCP log, keyed by
// the bot home slug; its last `error` line for THIS session says why the
// poller never came up (`TELEGRAM_BOT_TOKEN required` = the session ran
// without the token). null = no log line for the session at all.
function telegramMcpLastError(bot, sessionId) {
  try {
    const dir = path.join(process.env.LOCALAPPDATA || '', 'claude-cli-nodejs', 'Cache', botHome(bot).replace(/[^A-Za-z0-9]/g, '-'), 'mcp-logs-plugin-telegram-telegram');
    // one file per connection attempt, named by its start time: newest first
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort().reverse()) {
      // the plugin's own stderr beats the generic "Connection closed" that follows it
      let last = null, stderr = null, seen = false;
      for (const line of fs.readFileSync(path.join(dir, f), 'utf-8').split(/\r?\n/)) {
        try {
          const row = JSON.parse(line);
          if (sessionId && row.sessionId !== sessionId) continue;
          seen = true;
          if (!row.error) continue;
          const first = String(row.error).replace(/^Server stderr:\s*/, '').split(/\r?\n/)[0].trim();
          if (/^Server stderr:/.test(String(row.error))) stderr = first; else last = first;
        } catch {}
      }
      if (seen) return { file: path.join(dir, f), error: (stderr || last) ? scrub(stderr || last).slice(0, 160) : null };
    }
    return null;
  } catch { return null; }
}

// Interactive CC runs first-run onboarding (theme + browser login) and the
// workspace trust dialog even with CLAUDE_CODE_OAUTH_TOKEN set; nobody in the
// cockpit can answer those. Seed the state that skips them (the project key is
// the cwd with forward slashes). docs/cc-compat.md. Also run on import: the
// config home is fresh on the new machine.
function seedClaudeJson(name) {
  const claudeJson = path.join(configDir(name), '.claude.json');
  if (fs.existsSync(claudeJson)) return false;
  writeJsonAtomic(claudeJson, {
    hasCompletedOnboarding: true,
    theme: 'dark',
    projects: { [botHome(name).replace(/\\/g, '/')]: { allowedTools: [], hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  });
  out(`seeded ${claudeJson} (onboarding done, workspace trusted)`);
  return true;
}

// ---- the feature catalogue (what `new` offers) ------------------------------------------
const MODULE_DESC = {
  telegram: 'Telegram DMs through the official plugin (off = cockpit/terminal-only bot)',
  board: 'GitHub Projects v2 board tools + poll tick (integrations.board)',
  cost_meter: 'one sessions.csv row per session',
  usage_resume: 'relaunch after a usage-limit window if the process died',
  alert_triage: 'headless fix-or-card pass over memory/metrics/alerts.log',
  hub: 'status push to a hub URL (integrations.hub, vault key hub_token)',
  janitor: 'disk/transcript/orphan hygiene on the daemon tick',
  remote_control: 'Claude Remote Control (needs an interactive /login in this bot\'s config home)',
  lessons: 'inject harness/lessons/INDEX.md at session start',
  debrief: 'headless session debrief on Stop (real spend)',
  auto_commit: 'commit on Stop; a no-op unless the backup module made the folder a repo',
  memory_sync: 'push memory/ to the bot\'s own remote on Stop',
  sound: 'play a sound on Stop',
  telemetry: 'OpenTelemetry export to the local sink (subagent/usage observability)',
};
// Modules a bot configures rather than just switches on: shown once, under integrations.
const INTEGRATION_MODULES = ['telegram', 'board', 'hub'];
const INTEGRATION_DESC = {
  telegram: MODULE_DESC.telegram + '; asks for your Telegram user id so you are pre-allowed',
  board: MODULE_DESC.board + '; owner/number later via config set integrations.board.*',
  hub: MODULE_DESC.hub + '; url later via config set integrations.hub.url',
  backup: 'git backup of memory/ to a private remote (backup.git_remote; run by botcorp backup)',
  access: 'cockpit exposure behind Cloudflare Access - machine-wide, not per bot: botcorp cockpit expose',
};

function frontmatterDescription(file) {
  try {
    const m = fs.readFileSync(file, 'utf-8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const d = m && m[1].match(/^description:\s*(.+)$/m);
    return d ? d[1].trim().replace(/^["']|["']$/g, '').slice(0, 90) : '';
  } catch { return ''; }
}

function catalogueLists() {
  let skills = [], agents = [];
  try { skills = fs.readdirSync(path.join(ROOT, 'harness', 'skills'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch {}
  try { agents = fs.readdirSync(path.join(ROOT, 'harness', 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')).sort(); } catch {}
  return {
    skills: skills.map((s) => ({ key: s, desc: frontmatterDescription(path.join(ROOT, 'harness', 'skills', s, 'SKILL.md')) })),
    agents: agents.map((a) => ({ key: a, desc: frontmatterDescription(path.join(ROOT, 'harness', 'agents', `${a}.md`)) })),
  };
}

function defaultSelection(lists) {
  return {
    modules: { ...DEFAULTS.harness.modules },
    skills: new Set(lists.skills.map((s) => s.key)),
    agents: new Set(lists.agents.map((a) => a.key)),
    backup: false,
  };
}

// One numbered list across the four groups; the number is what the operator types.
function catalogueItems(sel, lists) {
  const items = [];
  for (const [k, v] of Object.entries(sel.modules)) if (!INTEGRATION_MODULES.includes(k)) items.push({ group: 'modules', key: k, on: v, desc: MODULE_DESC[k] || '' });
  for (const s of lists.skills) items.push({ group: 'skills', key: s.key, on: sel.skills.has(s.key), desc: s.desc });
  for (const a of lists.agents) items.push({ group: 'agents', key: a.key, on: sel.agents.has(a.key), desc: a.desc });
  for (const k of INTEGRATION_MODULES) items.push({ group: 'integrations', key: k, on: sel.modules[k], desc: INTEGRATION_DESC[k] });
  items.push({ group: 'integrations', key: 'backup', on: sel.backup, desc: INTEGRATION_DESC.backup });
  items.push({ group: 'integrations', key: 'access', on: fs.existsSync(path.join(BOTCORP_HOME, 'access.json')), desc: INTEGRATION_DESC.access, info: true });
  return items;
}

function toggleItem(sel, item) {
  if (item.group === 'modules' || (item.group === 'integrations' && INTEGRATION_MODULES.includes(item.key))) sel.modules[item.key] = !sel.modules[item.key];
  else if (item.group === 'skills') { if (sel.skills.has(item.key)) sel.skills.delete(item.key); else sel.skills.add(item.key); }
  else if (item.group === 'agents') { if (sel.agents.has(item.key)) sel.agents.delete(item.key); else sel.agents.add(item.key); }
  else if (item.key === 'backup') sel.backup = !sel.backup;
}

async function runChecklist(name, sel, lists) {
  for (;;) {
    const items = catalogueItems(sel, lists);
    out('');
    out(`feature catalogue for ${name}  ([x] = on; defaults pre-marked)`);
    let group = '';
    items.forEach((it, i) => {
      if (it.group !== group) { group = it.group; out(`  ${group}`); }
      const mark = it.info ? (it.on ? ' i ' : ' i ') : (it.on ? '[x]' : '[ ]');
      out(`    ${mark} ${String(i + 1).padStart(2)}  ${it.key.padEnd(16)} ${it.desc}`);
    });
    const ans = await promptVisible('toggle by number (e.g. 2 5 12), Enter to accept: ');
    if (!ans) return;
    for (const tok of ans.split(/[\s,]+/).filter(Boolean)) {
      const it = items[Number(tok) - 1];
      if (!/^\d+$/.test(tok) || !it) { out(`  no item ${tok}`); continue; }
      if (it.info) { out(`  ${it.key}: ${it.desc}`); continue; }
      toggleItem(sel, it);
    }
  }
}

function applyModuleFlags(sel, flags) {
  const known = Object.keys(DEFAULTS.harness.modules);
  const parse = (v) => String(v).split(',').map((s) => s.trim()).filter(Boolean);
  for (const [flag, value] of [['modules', true], ['no-modules', false]]) {
    if (!flags[flag]) continue;
    for (const m of parse(flags[flag])) {
      if (m === 'backup') usage(`--${flag} backup: the backup module is switched by its remote: botcorp config set <bot> backup.git_remote <url>`);
      if (!known.includes(m)) usage(`--${flag}: unknown module '${m}' (${known.join(', ')})`);
      sel.modules[m] = value;
    }
  }
  if (flags.telegram || flags['telegram-owner']) sel.modules.telegram = true;
}

// bot.yaml carries only what differs from DEFAULTS (plus name and persona).
function yamlFromSelection(name, persona, sel, lists, owner, backupRemote) {
  const doc = { name, persona };
  const harness = {};
  const mods = {};
  for (const [k, v] of Object.entries(sel.modules)) if (v !== DEFAULTS.harness.modules[k]) mods[k] = v;
  if (Object.keys(mods).length) harness.modules = mods;
  if (sel.skills.size !== lists.skills.length) harness.skills = lists.skills.map((s) => s.key).filter((k) => sel.skills.has(k));
  if (sel.agents.size !== lists.agents.length) harness.agents = lists.agents.map((a) => a.key).filter((k) => sel.agents.has(k));
  if (Object.keys(harness).length) doc.harness = harness;
  if (owner) doc.integrations = { telegram: { allow_from: [idValue(owner)] } };
  if (backupRemote) doc.backup = { git_remote: backupRemote };
  return doc;
}

function printCatalogue(name) {
  const cfg = loadBotYaml(botYamlPath(name));
  const lists = catalogueLists();
  const on = Object.entries(cfg.harness.modules).filter(([, v]) => v === true).map(([k]) => k);
  const off = Object.keys(cfg.harness.modules).filter((k) => !on.includes(k));
  const listOrAll = (v, all) => (Array.isArray(v) ? `${v.length}/${all.length}: ${v.join(', ') || '(none)'}` : `all (${all.length})`);
  const allow = listOf(cfg.integrations.telegram.allow_from);
  out(`catalogue for ${name}:`);
  out(`  modules       on:  ${on.join(', ') || '(none)'}`);
  out(`                off: ${off.join(', ') || '(none)'}`);
  out(`  skills        ${listOrAll(cfg.harness.skills, lists.skills)}`);
  out(`  agents        ${listOrAll(cfg.harness.agents, lists.agents)}`);
  out(`  integrations  telegram: ${cfg.harness.modules.telegram ? `on (dm_policy ${cfg.integrations.telegram.dm_policy}, allow_from ${allow.join(', ') || 'EMPTY - nobody can talk to the bot without a pairing code'})` : 'off'}`);
  out(`                board: ${cfg.harness.modules.board ? 'on' : 'off'}  hub: ${cfg.harness.modules.hub ? 'on' : 'off'}  backup: ${cfg.backup.git_remote ? 'on (' + cfg.backup.git_remote + ')' : 'off'}  access: machine-wide (${fs.existsSync(path.join(BOTCORP_HOME, 'access.json')) ? 'cockpit exposed' : 'loopback-only'})`);
}

async function cmdNew({ flags }) {
  const name = flags.name ? String(flags.name) : firstFreeName();
  if (!NAME_RE.test(name)) usage(`bad bot name '${name}' (lowercase, digits, hyphens; max 32)`);
  if (fs.existsSync(botHome(name))) fail(`new: bots/${name} already exists`);
  const persona = flags.persona ? String(flags.persona) : DEFAULTS.persona;
  const interactive = !!process.stdin.isTTY && !flags.yes;
  let rc = 0;

  // 0. the catalogue: checklist on a terminal, flags otherwise
  const lists = catalogueLists();
  const sel = defaultSelection(lists);
  applyModuleFlags(sel, flags);
  if (interactive) await runChecklist(name, sel, lists);
  let owner = flags['telegram-owner'] ? String(flags['telegram-owner']) : '';
  if (owner && !OWNER_RE.test(owner)) usage('--telegram-owner must be a numeric Telegram user id (5-12 digits)');
  if (sel.modules.telegram && !owner && interactive) {
    owner = await promptVisible('Your Telegram user id (numeric; message @userinfobot to read it; blank = pair later): ');
    if (owner && !OWNER_RE.test(owner)) { out(`telegram: '${owner}' is not a numeric user id; skipped (botcorp pair ${name} <id> later)`); owner = ''; }
  }
  let backupRemote = '';
  if (sel.backup) {
    backupRemote = interactive ? await promptVisible('Backup git remote (https:// or git@; blank = skip): ') : '';
    if (backupRemote && !/^(https:\/\/|ssh:\/\/|git@)/.test(backupRemote)) { out(`backup: '${backupRemote}' is not an https:// / ssh:// / git@ URL; skipped`); backupRemote = ''; }
  }
  const telegram = sel.modules.telegram;

  // 1. minimal bot.yaml: everything else comes from DEFAULTS at load time.
  fs.mkdirSync(botHome(name), { recursive: true });
  const header = '# bot.yaml - the only harness file this bot edits (via `botcorp config set`).\n# Every key and its default: templates/bot/bot.yaml. Tokens never go here (botcorp secrets).\n';
  writeTextAtomic(botYamlPath(name), header + dumpYaml(yamlFromSelection(name, persona, sel, lists, owner, backupRemote)));
  out(`created ${botYamlPath(name)}`);

  // 2. generated + bot-owned files, config home (a plain folder: no git init)
  doSync(name);
  const claudeMd = path.join(botHome(name), 'CLAUDE.md');
  try {
    const body = fs.readFileSync(claudeMd, 'utf-8');
    if (body.includes('{{bot_name}}')) fs.writeFileSync(claudeMd, body.replace(/\{\{bot_name\}\}/g, name));
  } catch {}
  seedClaudeJson(name);

  // 3. the ONE token a bot needs to start
  let oauth = '';
  if (flags['oauth-stdin']) oauth = readStdinAll().trim();
  else oauth = await promptHidden(`OAuth token for ${name} (from \`claude setup-token\`; hidden, blank to skip): `);
  if (oauth) {
    const c = secretsSet(name, 'oauth', oauth);
    if (c !== 0) { rc = c; out(`oauth: vault write failed (exit ${c}); re-enter with: botcorp secrets set ${name} oauth`); }
  } else out(`oauth: none given; the session will need /login until: botcorp secrets set ${name} oauth`);

  // 4. optional Telegram
  if (telegram) {
    const tg = await promptHidden(`Telegram bot token for ${name} (from BotFather /newbot; hidden, blank to skip): `);
    if (tg) {
      const c = secretsSet(name, 'telegram', tg);
      if (c !== 0) { rc = c; out(`telegram: vault write failed (exit ${c})${c === 3 ? ' - another bot already holds this token' : ''}`); }
    } else out(`telegram: no token; later: botcorp secrets set ${name} telegram`);
    if (flags['no-plugin-install']) out('telegram plugin: install skipped (--no-plugin-install); the launcher needs it: re-run the three `claude plugin` steps from docs/onboarding.md');
    else if (!installTelegramPlugin(name)) { rc = rc || 1; out('telegram plugin: install incomplete; re-run the three `claude plugin` steps from docs/onboarding.md'); }
    if (!owner) out(`telegram: allow_from is empty - nobody can talk to the bot until they pair (botcorp pair ${name} <id>)`);
  }

  // 5. launch
  if (!flags['no-launch']) {
    try { await startBot(name, true); } catch (e) { rc = rc || 1; out(`start: ${e.message}`); }
  }

  out('');
  printCatalogue(name);
  out('');
  out(`next steps for ${name}:`);
  out(`  cockpit:   http://127.0.0.1:${COCKPIT_PORT}   (npm run cockpit)  -  terminal + chat for this bot`);
  if (!telegram) out(`  telegram:  botcorp secrets set ${name} telegram   then   botcorp config set ${name} harness.modules.telegram true`);
  else out(`  telegram:  botcorp start ${name} once the token is in the vault; the poller starts with the session`);
  out(`  pairing:   message the bot from Telegram, then   botcorp pair ${name} --list   ->   botcorp pair ${name} <senderId>`);
  out(`  config:    botcorp config set ${name} <path> <value>   (widening changes wait in: botcorp approve ${name} --list)`);
  out(`  move it:   botcorp export ${name}   ->   botcorp import <zip> on the other machine (tokens re-entered there)`);
  return rc;
}

// ---- export / import (a bot folder is a plain folder; the zip is how it moves) --------------
const EXPORT_SKIP_DIRS = new Set(['.vault', '.git', 'node_modules', '__pycache__']);
// Runtime state the target box regenerates: the recall index (rebuilt from the
// journals at session start), per-session metrics, and the session/debrief
// markers of the last run here. `--include-state` carries them for a real
// migration; a plain export is a clean bot, not a snapshot of this machine.
const EXPORT_STATE_RE = /^(memory\/(index|metrics)\/|\.claude\/(\.current_session_id$|\.debrief_))/;

// Everything in bots/<bot>/ except the vault (DPAPI: useless elsewhere), any
// config home (transcripts, plugin state, credentials; `import` re-seeds one
// and `sync` rebuilds the Telegram allow-list from bot.yaml), a backup-module
// `.git` (a bot folder is a plain folder on the target too; `botcorp backup`
// re-creates it from backup.git_remote), build junk and, unless asked,
// runtime state (EXPORT_STATE_RE).
function exportEntries(bot, { includeState = false } = {}) {
  const home = botHome(bot);
  const acc = [];
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (EXPORT_SKIP_DIRS.has(e.name) || /^\.claude-[a-z0-9-]+$/.test(e.name)) continue;
        walk(path.join(dir, e.name), r);
      } else if (e.isFile() && !/\.pyc$/.test(e.name)) {
        if (!includeState && EXPORT_STATE_RE.test(r)) continue;
        acc.push({ name: r, file: path.join(dir, e.name) });
      }
    }
  };
  walk(home, '');
  return acc.sort((a, b) => a.name.localeCompare(b.name));
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function cmdExport({ pos, flags }) {
  const bot = requireBot(pos[1]);
  const outFile = flags.out ? path.resolve(String(flags.out)) : path.join(BOTCORP_HOME, 'exports', `${bot}-${stamp()}.zip`);
  const entries = exportEntries(bot, { includeState: !!flags['include-state'] });
  const r = zipWrite(outFile, entries);
  if (flags.json) { outJson({ bot, file: outFile, entries: entries.map((e) => e.name), bytes: r.bytes }); return 0; }
  out(`exported ${bot}: ${outFile} (${entries.length} entries, ${r.bytes} bytes)`);
  if (flags.list || entries.length <= 40) for (const e of entries) out(`  ${e.name}`);
  else out(`  (${entries.length} entries; --list prints them)`);
  out('tokens are not exported: run botcorp secrets set on the target');
  return 0;
}

function cmdImport({ pos, flags }) {
  const zip = pos[1] ? path.resolve(pos[1]) : usage('import <zip> [--as <name>]');
  if (!fs.existsSync(zip)) fail(`import: ${zip} not found`);
  const { buf, entries } = zipList(zip);
  const yamlEntry = entries.find((e) => e.name.replace(/\\/g, '/') === 'bot.yaml');
  if (!yamlEntry) fail(`import: ${zip} has no bot.yaml at its root (not a botcorp export)`);
  const rawYaml = zipEntryData(buf, yamlEntry).toString('utf-8');
  const parsed = parseYaml(rawYaml);
  const oldName = String(parsed.name || '');
  if (!NAME_RE.test(oldName)) fail(`import: bot.yaml in the zip has no valid name (got ${JSON.stringify(parsed.name)})`);
  const name = flags.as ? String(flags.as) : oldName;
  if (!NAME_RE.test(name)) usage(`bad bot name '${name}' (lowercase, digits, hyphens; max 32)`);
  if (fs.existsSync(botHome(name))) fail(`import: bots/${name} already exists (choose --as <other-name> or remove it first)`);
  const written = zipExtract(zip, botHome(name), (rel) => {
    // never, even from a hand-made zip: the vault, a repo, any config home
    if (rel.startsWith('.vault/') || rel.startsWith('.git/') || /^\.claude-[a-z0-9-]+\//.test(rel)) return null;
    return rel;
  });
  out(`imported ${written.length} entries into ${botHome(name)}`);
  if (name !== oldName) {
    // A text edit of the one `name:` line, not a re-serialize: the operator's
    // comments (TODOs, timing rationale) must survive the move.
    const yamlFile = botYamlPath(name);
    const text = fs.readFileSync(yamlFile, 'utf-8');
    const edited = text.replace(/^name:[^\r\n]*/m, `name: ${name}`);
    if (edited === text) { const raw = loadRawYaml(name); raw.name = name; writeRawYaml(name, raw); }
    else writeTextAtomic(yamlFile, edited);
    out(`renamed in bot.yaml: ${oldName} -> ${name}`);
  }
  doSync(name);
  seedClaudeJson(name);
  out(`tokens are not in the zip: botcorp secrets set ${name} oauth   and, with telegram on,   botcorp secrets set ${name} telegram`);
  return 0;
}

// ---- backup (optional module: backup.git_remote) ----------------------------------------------
function cmdBackup({ pos, flags }) {
  const bot = requireBot(pos[1]);
  const cfg = loadBotYaml(botYamlPath(bot));
  const remote = cfg.backup.git_remote;
  if (!remote) fail(`backup: off for ${bot} (backup.git_remote is null; set it with: botcorp config set ${bot} backup.git_remote <url>)`);
  const home = botHome(bot);
  const dry = !!flags['dry-run'];
  const paths = cfg.backup.paths;
  out(`backup: ${bot} -> ${remote} (paths: ${paths.join(', ')})${dry ? ' [dry-run]' : ''}`);
  if (dry) return 0;
  if (!fs.existsSync(path.join(home, '.git'))) {
    git(home, ['init', '-q']);
    git(home, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    out('backup: git init (branch main)');
  }
  const ignore = path.join(home, '.gitignore');
  if (!fs.existsSync(ignore)) { fs.copyFileSync(path.join(ROOT, 'templates', 'bot', '.gitignore'), ignore); out('backup: .gitignore restored from the template'); }
  // The whole point of the ignore file: a backup remote must never receive these.
  for (const p of ['.vault', `.claude-${bot}`, '.claude/settings.json']) {
    if (run(gitExe(), ['-C', home, 'check-ignore', '-q', p], { timeoutMs: 15_000 }).code !== 0) fail(`backup: ${p} is NOT ignored in ${ignore}; refusing to commit (restore the template's .gitignore lines)`);
  }
  const id = gitIdentity();
  git(home, ['config', 'user.name', id.name]);
  git(home, ['config', 'user.email', id.email]);
  const cur = run(gitExe(), ['-C', home, 'remote', 'get-url', 'origin'], { timeoutMs: 15_000 });
  if (cur.code !== 0) git(home, ['remote', 'add', 'origin', remote]);
  else if (cur.out.trim() !== remote) { git(home, ['remote', 'set-url', 'origin', remote]); out(`backup: origin url updated`); }
  const present = paths.filter((p) => fs.existsSync(path.join(home, p)));
  git(home, ['add', '-A', '--', '.gitignore', ...present]);
  const staged = run(gitExe(), ['-C', home, 'diff', '--cached', '--quiet'], { timeoutMs: 30_000 }).code !== 0;
  if (staged) { git(home, ['commit', '-q', '-m', `backup ${new Date().toISOString()}`]); out('backup: committed'); }
  else out('backup: nothing new to commit');
  const push = run(gitExe(), ['-C', home, '-c', 'credential.interactive=never', '-c', 'core.askPass=', 'push', '-q', '-u', 'origin', 'HEAD:main'], { timeoutMs: 120_000, env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });
  if (push.timedOut) fail('backup: git push timed out after 120 s (no credential prompt is ever answered here; use a token URL or a stored credential)');
  if (push.code !== 0) fail(`backup: git push failed (${push.code}): ${(push.err || push.out).trim().slice(0, 300)}`);
  out(`backup: pushed to ${remote}`);
  return 0;
}

// ---- adopt (--dry-run prints the plan; the real run copies) ---------------------------------
const ADOPT_MAP = [
  ['.claude/hooks', 'harness/hooks'],
  ['tools', 'harness/tools'],
  ['.claude/agents', 'harness/agents'],
  ['.claude/rules', 'harness/rules'],
  ['.claude/skills', 'harness/skills'],
  ['.claude/commands', 'harness/commands'],
];
const SKIP_WALK = new Set(['__pycache__', 'node_modules', '.git', '.pytest_cache']);

function walkFiles(dir, base = dir, acc = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (SKIP_WALK.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, base, acc);
    else if (e.isFile() && !/\.pyc$/.test(e.name)) acc.push(path.relative(base, p).replace(/\\/g, '/'));
  }
  return acc;
}

function sameBytes(a, b) {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
}

// Never copied out of an old bot: its repo (a bot folder is not a nested repo;
// the history stays where it is), any config home, the vault, and every file a
// credential could live in. No token is ever migrated (docs/adopt-existing-bot.md).
const ADOPT_SKIP_TOP = new Set(['.git', '.vault', 'node_modules', '__pycache__', '.pytest_cache']);
const ADOPT_SKIP_FILE = /^(\.env(\..*)?|.*\.oauth_token|token\.json|credentials\.json)$/;
function adoptSkips(rel, name) {
  const top = rel.split('/')[0];
  if (ADOPT_SKIP_TOP.has(top) || /^\.claude-[a-z0-9-]+$/.test(top)) return `${top}/`;
  if (ADOPT_SKIP_FILE.test(path.basename(rel)) || rel === '.claude/.oauth_token' || rel.endsWith('channels/telegram/.env')) return rel;
  if (rel === '.claude/settings.json') return rel;   // generated by sync; bot-own hooks go to settings.local.json below
  return null;
}

function adoptGenerated(name, src) {
  const settings = readJson(path.join(src, '.claude', 'settings.json')) || {};
  const mode = settings.permissions && settings.permissions.defaultMode;
  return {
    settings,
    gen: {
      name,
      persona: DEFAULTS.persona,
      model: settings.model || DEFAULTS.model,
      effort: settings.effortLevel || DEFAULTS.effort,
      permissions: mode === 'bypassPermissions' ? 'bypass' : mode ? 'default' : DEFAULTS.permissions,
      harness: { modules: { telegram: fs.existsSync(path.join(src, '.claude', 'tg-enable.settings.json')) } },
    },
  };
}

function adoptReal(src, name, flags) {
  const dest = botHome(name);
  if (fs.existsSync(dest)) fail(`adopt: bots/${name} already exists (choose --as <other-name> or remove it first)`);
  const skipped = new Set();
  let copied = 0;
  for (const rel of walkFiles(src)) {
    const s = adoptSkips(rel, name);
    if (s) { skipped.add(s); continue; }
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(src, rel), to);
    copied++;
  }
  out(`adopt: copied ${copied} file(s) ${src} -> ${dest} (the source is untouched; rollback = delete bots/${name})`);
  for (const s of [...skipped].sort()) out(`  left behind  ${s}`);

  // duplicates of harness files: the plugin provides them, so only an edited copy is worth keeping
  let dropped = 0;
  for (const [rel, hrel] of ADOPT_MAP) {
    const ddir = path.join(dest, rel), hdir = path.join(ROOT, hrel);
    if (!fs.existsSync(ddir)) continue;
    for (const f of walkFiles(ddir)) {
      const h = path.join(hdir, f);
      if (!fs.existsSync(h)) continue;
      if (sameBytes(path.join(ddir, f), h)) { fs.rmSync(path.join(ddir, f)); dropped++; }
      else out(`  kept (differs from ${hrel}/${f})  ${rel}/${f}`);
    }
  }
  out(`adopt: dropped ${dropped} file(s) identical to the harness`);

  // bot-own hooks survive in settings.local.json (sync never touches it once it exists)
  const { settings, gen } = adoptGenerated(name, src);
  const harnessFiles = new Set([...walkFiles(path.join(ROOT, 'harness', 'hooks')), ...walkFiles(path.join(ROOT, 'harness', 'tools'))].map((f) => path.basename(f)));
  const ownHooks = {};
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      const hooks = (Array.isArray(g.hooks) ? g.hooks : []).filter((h) => h && h.command && !harnessFiles.has(path.basename((String(h.command).match(/[\w./\\-]+\.(sh|py|cjs|mjs|js|ps1)/) || [''])[0])));
      if (hooks.length) (ownHooks[event] ||= []).push({ ...g, hooks });
    }
  }
  if (Object.keys(ownHooks).length) {
    const localFile = path.join(dest, '.claude', 'settings.local.json');
    const local = readJson(localFile) || {};
    if (!local.hooks) { local.hooks = ownHooks; writeJsonAtomic(localFile, local); out(`adopt: ${Object.values(ownHooks).flat().length} bot-own hook group(s) -> .claude/settings.local.json`); }
    else out('adopt: settings.local.json already has hooks; the old bot-own hooks were NOT merged (review by hand)');
  }

  const yamlFile = botYamlPath(name);
  if (fs.existsSync(yamlFile)) out('adopt: bot.yaml came with the bot; kept as is');
  else {
    const header = '# bot.yaml - the only harness file this bot edits (via `botcorp config set`).\n# Every key and its default: templates/bot/bot.yaml. Tokens never go here (botcorp secrets).\n';
    writeTextAtomic(yamlFile, header + dumpYaml(gen));
    out(`adopt: wrote ${yamlFile} (model/effort/permissions/telegram inferred from the old settings.json)`);
  }
  doSync(name);
  seedClaudeJson(name);

  // the one config-home file worth carrying: the Telegram allow-list
  if (flags['config-dir']) {
    const acc = path.join(path.resolve(String(flags['config-dir'])), 'channels', 'telegram', 'access.json');
    if (fs.existsSync(acc)) {
      const to = path.join(configDir(name), 'channels', 'telegram', 'access.json');
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(acc, to);
      out(`adopt: copied the Telegram allow-list from ${acc}`);
    } else out(`adopt: no channels/telegram/access.json under ${flags['config-dir']}`);
  }
  out('tokens: NO token is migrated - enter the OAuth token and the Telegram token by hand:');
  out(`  botcorp secrets set ${name} oauth     botcorp secrets set ${name} telegram`);
  return 0;
}

function cmdAdopt({ pos, flags }) {
  const src = pos[1] ? path.resolve(pos[1]) : usage('adopt <path> --as <name> [--dry-run] [--config-dir <old CLAUDE_CONFIG_DIR>]');
  const name = flags.as ? String(flags.as) : usage('adopt: --as <name> required');
  if (!NAME_RE.test(name)) usage(`bad bot name '${name}'`);
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) fail(`adopt: ${src} is not a directory`);
  if (path.resolve(src) === path.resolve(botHome(name))) fail(`adopt: ${src} already is bots/${name}`);
  if (!flags['dry-run']) return adoptReal(src, name, flags);
  if (fs.existsSync(botHome(name))) out(`note: bots/${name} already exists; the real adopt would refuse`);

  out(`adopt plan (dry-run, nothing touched): ${src} -> ${botHome(name)}`);
  out('');
  out('copy (top level; the source is left untouched):');
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = adoptSkips(e.name, name);
    if (s) { out(`  leave  ${s}  (${e.name === '.git' ? 'a bot folder is not a nested repo; the history stays here' : 'never migrated'})`); continue; }
    out(`  copy   ${e.name}${e.isDirectory() ? '/' : ''}`);
  }

  out('');
  out('duplicates of harness files (delete after the move; the plugin provides them):');
  let dups = 0;
  for (const [rel, hrel] of ADOPT_MAP) {
    const sdir = path.join(src, rel), hdir = path.join(ROOT, hrel);
    if (!fs.existsSync(sdir)) continue;
    for (const f of walkFiles(sdir)) {
      const h = path.join(hdir, f);
      if (!fs.existsSync(h)) continue;
      dups++;
      out(`  ${sameBytes(path.join(sdir, f), h) ? 'identical' : 'differs  '}  ${rel}/${f}  ~  ${hrel}/${f}`);
    }
  }
  if (!dups) out('  (none)');

  out('');
  const { settings, gen } = adoptGenerated(name, src);
  out(`bot.yaml that would be generated (from ${path.join(src, '.claude', 'settings.json')}${settings.model ? '' : ' - absent or no model, defaults used'}):`);
  for (const l of dumpYaml(gen).trimEnd().split('\n')) out(`  ${l}`);

  const hooks = [];
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    for (const g of Array.isArray(groups) ? groups : []) for (const h of Array.isArray(g.hooks) ? g.hooks : []) if (h && h.command) hooks.push([event, String(h.command)]);
  }
  if (hooks.length) {
    out('');
    out('hooks in settings.json (the plugin carries the harness hooks; the rest goes to settings.local.json or is dropped):');
    const harnessFiles = new Set([...walkFiles(path.join(ROOT, 'harness', 'hooks')), ...walkFiles(path.join(ROOT, 'harness', 'tools'))].map((f) => path.basename(f)));
    for (const [event, cmd] of hooks) {
      const script = (cmd.match(/[\w./\\-]+\.(sh|py|cjs|mjs|js|ps1)/) || [''])[0];
      const base = path.basename(script);
      out(`  ${harnessFiles.has(base) ? 'harness ' : 'bot-own '}  ${event}: ${cmd}`);
    }
  }

  out('');
  const envFile = path.join(src, '.env');
  if (fs.existsSync(envFile)) {
    const keys = fs.readFileSync(envFile, 'utf-8').split(/\r?\n/).map((l) => (l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/) || [])[1]).filter(Boolean);
    out(`.env keys (names only; ${keys.length}):`);
    for (const k of keys) {
      const note = k === 'TELEGRAM_BOT_TOKEN' ? 'vault key telegram_token' : k === 'CLAUDE_CODE_OAUTH_TOKEN' ? 'vault key oauth_token' : /TOKEN|SECRET|KEY|PASS/i.test(k) ? 'vault (automations[].secrets) or bot-own .env' : 'bot-own .env';
      out(`  ${k}  ->  ${note}`);
    }
  } else out('.env: absent');
  out('');
  out('tokens: NO token is migrated - enter the OAuth token and the Telegram token by hand:');
  out(`  botcorp secrets set ${name} oauth     botcorp secrets set ${name} telegram`);
  return 0;
}

// ---- update / install (daemon scripts, if present) -----------------------------------------
function shellDaemonScript(script, args, label) {
  const file = path.join(ROOT, 'daemon', script);
  if (!fs.existsSync(file)) { out(`daemon/${script} not present`); return 1; }
  const r = runPwshFile(file, args, { timeoutMs: 300_000 });
  for (const l of (r.out + r.err).split(/\r?\n/)) if (l.trim()) out(l.trim());
  if (r.timedOut) out(`${label}: timed out`);
  return r.code;
}

// Updates are ADMIN actions: the daemon's hourly check only records releases in
// <rt>/state/updates.json with plain-language notes; this command lists them and
// records the operator's Apply / Skip. The apply itself happens in the daemon at
// each bot's next safe restart (smoke test + rollback kept). Never `-Apply` here.
function updatesPath() { return path.join(STATE_DIR, 'updates.json'); }
function readUpdates() {
  const j = readJson(updatesPath());
  return isObj(j) && Array.isArray(j.releases) ? j : { releases: [] };
}

function cmdUpdate({ flags }) {
  if (flags.check) return shellDaemonScript('update.ps1', ['-Check'], 'update');
  if (flags.apply && flags.skip) usage('update: --apply <tag> or --skip <tag>, not both');
  const tag = flags.apply || flags.skip;
  if (tag) {
    const who = requestedBy(flags);
    if (who.startsWith('bot:')) fail('update: apply/skip is an operator action; a bot session cannot decide a harness update');
    const u = readUpdates();
    const rel = u.releases.find((r) => r && String(r.tag) === String(tag));
    if (!rel) fail(`update: no release ${tag} in ${updatesPath()} (botcorp update lists them; --check records new ones)`);
    if (rel.status === 'applied') fail(`update: ${tag} is already applied`);
    const target = flags.apply ? 'apply_requested' : 'skipped';
    if (rel.status === target) { out(`update: ${tag} already ${target}`); return 0; }
    rel.status = target;
    rel.decided_at = new Date().toISOString();
    rel.decided_by = who;
    writeJsonAtomic(updatesPath(), u);
    out(flags.apply
      ? `update: ${tag} -> apply_requested (the daemon applies it at each bot's next safe restart; smoke test and rollback stay on)`
      : `update: ${tag} -> skipped`);
    return 0;
  }
  const u = readUpdates();
  if (flags.json) { outJson(u); return 0; }
  if (!u.releases.length) { out(`update: no releases recorded in ${updatesPath()} (the daemon's hourly check writes it; botcorp update --check runs one now)`); return 0; }
  for (const r of u.releases) {
    out(`${String(r.status || '?').padEnd(15)} ${r.tag}  ${r.date || ''}  ${r.sha ? String(r.sha).slice(0, 10) : ''}`);
    for (const k of ['what', 'why', 'value']) if (r[k]) out(`    ${k.padEnd(6)} ${String(r[k]).replace(/\s+/g, ' ')}`);
  }
  const pending = u.releases.filter((r) => r.status === 'pending').length;
  out(`update: ${pending} pending  ->  botcorp update --apply <tag> | --skip <tag>   (applied at each bot's next safe restart, never from here)`);
  return 0;
}

const INSTALL_PIPE_HINT = 'pipe it on stdin, never on the command line (process listings show argv):  $pw | node cli\\botcorp.mjs install   (elevated), or register without a stored password with --s4u';

async function cmdInstall({ pos, flags }) {
  const file = path.join(ROOT, 'daemon', 'install.ps1');
  if (flags.unregister) return shellDaemonScript('install.ps1', ['-Unregister'], 'install');
  if (!fs.existsSync(file)) { out('daemon/install.ps1 not present'); return 1; }
  // A password on argv is refused outright: `install -Password x` used to be
  // silently ignored (and then prompted, which hangs without a console).
  if (pos.length > 1 || Object.keys(flags).some((k) => /^password$/i.test(k))) fail(`install: refusing a password on the command line; ${INSTALL_PIPE_HINT}`);
  let args = [];
  let stdin = null;
  if (flags.s4u) args = ['-LogonType', 'S4U'];
  else {
    // Stored-password mode (the default: DPAPI + git credentials need a real
    // logon). Piped stdin when there is one; a hidden prompt only on a real
    // TTY; anything else fails fast. S4U is never a silent fallback.
    const tty = process.stdin.isTTY;
    const pw = tty ? await promptHidden('Windows password for the daemon task (hidden): ') : readStdinAll().trim();
    if (!pw) fail(`install: ${tty ? 'no password given' : 'no TTY to prompt on and no password on stdin'}; ${INSTALL_PIPE_HINT}`);
    args = ['-PasswordFromStdin']; stdin = pw + '\n';
  }
  if (flags['dry-run']) args.push('-DryRun');
  const r = runPwshFile(file, args, { timeoutMs: 300_000, stdin });
  for (const l of (r.out + r.err).split(/\r?\n/)) if (l.trim()) out(l.trim());
  if (r.timedOut) out('install: timed out');
  return r.code;
}

// ---- cockpit exposure (machine-wide: ONE cockpit per box) -------------------------------------
function cmdCockpit({ pos, flags }) {
  const action = pos[1];
  const file = path.join(BOTCORP_HOME, 'access.json');
  if (action === 'expose') {
    const team = flags.team ? String(flags.team) : usage('cockpit expose --team <slug> --aud <aud> --yes');
    const aud = flags.aud ? String(flags.aud) : usage('cockpit expose --team <slug> --aud <aud> --yes');
    if (!/^[a-z0-9-]{1,64}$/i.test(team)) usage('--team is the Access team slug (<team>.cloudflareaccess.com)');
    out(`cockpit expose is MACHINE-WIDE: ${file} lets the ONE cockpit on this box (every bot's terminal, chat and vault panel) bind off-loopback and accept a tunnel, gated by Cloudflare Access team=${team} (JWT verified on every request, fail-closed). A bot cannot opt out per bot.`);
    if (!flags.yes) { out('not written: re-run with --yes to confirm'); return 1; }
    writeJsonAtomic(file, { team, aud });
    out(`wrote ${file} (team=${team}, aud=****${aud.slice(-4)}); restart the cockpit to pick it up`);
    return 0;
  }
  if (action === 'unexpose') {
    if (!fs.existsSync(file)) { out('cockpit: already loopback-only (no access.json)'); return 0; }
    fs.unlinkSync(file);
    out(`removed ${file}: the cockpit is loopback-only again (restart it; stop any running tunnel too)`);
    return 0;
  }
  usage('cockpit expose --team <t> --aud <a> --yes | cockpit unexpose');
}

// ---- suggest -------------------------------------------------------------------------------
function slugify(s) { return String(s).toLowerCase().replace(/\.md$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64); }

function cmdSuggest({ pos, flags }) {
  const bot = requireBot(pos[1]);
  const topic = flags.topic ? slugify(flags.topic) : usage('suggest <bot> --topic <t> [--lesson <file>] [--dry-run]');
  if (!topic) usage('suggest: --topic must contain letters or digits');
  if (!fs.existsSync(path.join(ROOT, '.git'))) fail(`suggest: ${ROOT} is not a git checkout (no .git); suggestions are PRs against the BotCorp repo`);
  const dry = !!flags['dry-run'];
  const wt = path.join(BOTCORP_HOME, 'work', topic);
  const branch = `suggest/${bot}/${topic}`;
  const hasOrigin = run(gitExe(), ['-C', ROOT, 'rev-parse', '--verify', '-q', 'origin/main'], { timeoutMs: 15_000 }).code === 0;
  const base = hasOrigin ? 'origin/main' : 'HEAD';
  const lesson = flags.lesson ? path.resolve(String(flags.lesson)) : null;
  if (lesson && !fs.existsSync(lesson)) fail(`suggest: lesson file ${lesson} not found`);
  const lessonSlug = lesson ? slugify(path.basename(lesson)) : null;
  const dest = lesson ? path.join(wt, 'harness', 'lessons', `${lessonSlug}.md`) : null;

  out(`${dry ? 'would run' : 'running'}: git -C ${ROOT} worktree add -b ${branch} ${wt} ${base}`);
  if (lesson) out(`${dry ? 'would copy' : 'copying'}: ${lesson} -> ${dest} (then scripts/debrand-lint.py on it)`);
  if (!dry) {
    if (fs.existsSync(wt)) fail(`suggest: ${wt} already exists`);
    git(ROOT, ['worktree', 'add', '-b', branch, wt, base], 120_000);
    if (lesson) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(lesson, dest);
      const py = resolvePython();
      if (!py) fail('suggest: python not found for scripts/debrand-lint.py');
      const lint = run(py.file, [...py.pre, path.join(ROOT, 'scripts', 'debrand-lint.py'), dest], { timeoutMs: 60_000, env: { PYTHONIOENCODING: 'utf-8' } });
      for (const l of (lint.out + lint.err).split(/\r?\n/)) if (l.trim()) out(`lint: ${l.trim()}`);
      if (lint.code !== 0) fail(`suggest: debrand-lint found identity strings in the lesson; fix ${dest} in the worktree, then commit and open the PR by hand`);
      const id = gitIdentity();
      git(wt, ['config', 'user.name', id.name]);
      git(wt, ['config', 'user.email', id.email]);
      git(wt, ['add', path.relative(wt, dest).replace(/\\/g, '/')]);
      git(wt, ['commit', '-q', '-m', `suggest(${bot}): ${topic}\n\nLesson: harness/lessons/${lessonSlug}.md`]);
      out(`committed harness/lessons/${lessonSlug}.md on ${branch}`);
    }
  }
  out('');
  out('next (not run by this command):');
  out(`  git -C ${wt} push -u origin ${branch}`);
  out(`  gh pr create --head ${branch} --base main --label suggest --label bot:${bot} --title "suggest(${bot}): ${topic}" --body "What / Why / Value: <fill in>"`);
  return 0;
}

// ---- doctor ------------------------------------------------------------------------------
function semver(text) {
  const m = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function semverGte(a, b) {
  for (let i = 0; i < 3; i++) { if (a[i] > b[i]) return true; if (a[i] < b[i]) return false; }
  return true;
}

async function httpOk(url, timeoutMs = 3000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return r.status;
  } catch { return null; }
}

// ---- doctor: host checks (the "remote box" requirements) ----------------------------------
// One bounded pwsh run reads everything registry/service/firewall/powercfg
// side and returns JSON; each field is null when its read failed, and a null
// prints as WARN "could not read" - never a crash, never a FAIL on a guess.
const HOST_PS = `
$r = [ordered]@{}
try { $s = Get-Service -Name CloudflareWARP -ErrorAction Stop; $r.warp_service = @{ status = "$($s.Status)"; start = "$($s.StartType)" } } catch { $r.warp_service = $null }
try {
  $vals = @()
  foreach ($k in 'HKLM:\\SOFTWARE\\Cloudflare\\CloudflareWARP','HKLM:\\SOFTWARE\\Policies\\Cloudflare\\WARP') {
    if (Test-Path $k) { $p = Get-ItemProperty -Path $k; foreach ($n in $p.PSObject.Properties.Name) { if ($n -notlike 'PS*') { $vals += "$k\\$n=$($p.$n)" } } }
  }
  $r.warp_reg = $vals
} catch { $r.warp_reg = $null }
try { $r.rdp_deny = (Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server' -ErrorAction Stop).fDenyTSConnections } catch { $r.rdp_deny = $null }
try { $r.rdp_nla = (Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp' -ErrorAction Stop).UserAuthentication } catch { $r.rdp_nla = $null }
try {
  # Enumerating every port filter is denied non-elevated (protected rules); per-rule filters are not.
  # A rule counts only with LocalPort 3389 on it: the Remote Desktop group's Shadow rule and e.g.
  # "Chrome Remote Desktop Host" are LocalPort Any and used to pass on their name alone.
  # Fast pass = the built-in Remote Desktop group + rules named after RDP/3389; a full per-rule scan
  # (~15 s on 230 rules) only when the fast pass has no rule whose RemoteAddress looks like the mesh.
  $all = @(Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow -ErrorAction Stop)
  $rdp3389 = {
    param($rules)
    @(foreach ($rule in $rules) {
      try {
        $ports = @(($rule | Get-NetFirewallPortFilter -ErrorAction Stop).LocalPort)
        if ($ports -contains '3389') { @{ name = $rule.DisplayName; group = "$($rule.DisplayGroup)"; profile = "$($rule.Profile)"; ports = $ports; remote = @(($rule | Get-NetFirewallAddressFilter -ErrorAction Stop).RemoteAddress) } }
      } catch {}
    })
  }
  $named = @($all | Where-Object { $_.DisplayGroup -eq 'Remote Desktop' -or $_.DisplayName -match 'RDP|3389' -or $_.Name -match 'RDP|RemoteDesktop|3389' })
  $r.fw = @(& $rdp3389 $named)
  $r.fw_scan = "named ($($named.Count) of $($all.Count) rules)"
  $meshLike = @($r.fw | Where-Object { @($_.remote) | Where-Object { $_ -eq 'Any' -or $_ -like '100.*' } })
  if ($meshLike.Count -eq 0) {
    $namedIds = @($named | ForEach-Object { $_.Name })
    $r.fw = @($r.fw) + @(& $rdp3389 @($all | Where-Object { $namedIds -notcontains $_.Name }))
    $r.fw_scan = "full ($($all.Count) rules)"
  }
} catch { $r.fw = $null; $r.fw_err = "$($_.Exception.Message)" }
try { $r.autologon = (Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon' -ErrorAction Stop).AutoAdminLogon } catch { $r.autologon = $null }
$powercfg = Join-Path $env:SystemRoot 'System32\\powercfg.exe'
try { $r.standby = (& $powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 2>&1) -join "\`n" } catch { $r.standby = $null }
try { $r.hib_a = (& $powercfg /a 2>&1) -join "\`n" } catch { $r.hib_a = $null }
try { $p = Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power' -ErrorAction Stop; $r.hib_enabled = $p.HibernateEnabled; $r.hiberboot = $p.HiberbootEnabled } catch { $r.hib_enabled = $null; $r.hiberboot = $null }
$r | ConvertTo-Json -Depth 6 -Compress
`;

function resolveWarpCli() {
  const names = process.platform === 'win32' ? ['warp-cli.exe', 'warp-cli'] : ['warp-cli'];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) { try { if (fs.statSync(path.join(dir, n)).isFile()) return path.join(dir, n); } catch {} }
  }
  const pf = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Cloudflare', 'Cloudflare WARP', 'warp-cli.exe');
  return fs.existsSync(pf) ? pf : null;
}

function firstLine(s) { return String(s || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || ''; }

// Scheduled tasks named *Bot* that coexist with BotCorp by design (another
// product's supervisor on the same box). Shipped default in botcorp.json
// `host.coexist_tasks` (empty) plus the machine-local <BOTCORP_HOME>/host.json
// `coexist_tasks`; entries are exact names or `*` globs.
function coexistTasks() {
  const file = path.join(BOTCORP_HOME, 'host.json');
  const list = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  const shipped = list(((readJson(path.join(ROOT, 'botcorp.json')) || {}).host || {}).coexist_tasks);
  const local = list((readJson(file) || {}).coexist_tasks);
  return { patterns: [...new Set([...shipped, ...local])], file };
}

function hostChecks(add) {
  const A = (level, name, detail) => add(level, `host: ${name}`, detail, 'host');
  const ps = runPwshCommand(HOST_PS, { timeoutMs: 150_000 });   // a full firewall scan alone can take ~15-40 s
  let h = null;
  try { h = JSON.parse(ps.out.trim().split(/\r?\n/).pop()); } catch {}
  const psWhy = ps.timedOut ? 'pwsh timed out after 150 s' : firstLine(ps.err || ps.out).slice(0, 120) || 'no output';
  const unread = (name, why) => A('WARN', name, `could not read (${why})`);
  const v = (k) => (h && h[k] !== undefined ? h[k] : null);

  // WARP service: must come up at boot so RDP over the mesh works at the login screen
  const svc = v('warp_service');
  if (svc) A(svc.status === 'Running' && svc.start === 'Automatic' ? 'PASS' : 'FAIL', 'WARP service', `CloudflareWARP Status=${svc.status} StartType=${svc.start} (want Running / Automatic)`);
  else unread('WARP service', h ? 'service CloudflareWARP not found' : psWhy);

  const warp = resolveWarpCli();
  const st = warp ? run(warp, ['status'], { timeoutMs: 10_000 }) : null;
  if (!warp) A('WARN', 'warp-cli status', 'warp-cli not found on PATH or under Program Files\\Cloudflare\\Cloudflare WARP');
  else if (st.timedOut) unread('warp-cli status', 'timed out after 10 s');
  else A(/\bConnected\b/.test(st.out + st.err) ? 'PASS' : 'FAIL', 'warp-cli status', firstLine(st.out + st.err).slice(0, 160) || `exit ${st.code}, no output`);

  const settings = warp ? run(warp, ['settings'], { timeoutMs: 10_000 }) : null;
  const setHit = settings && !settings.timedOut ? (settings.out + settings.err).split(/\r?\n/).find((l) => /auto[_ -]?connect/i.test(l)) : null;
  const regHit = (Array.isArray(v('warp_reg')) ? v('warp_reg') : []).filter((x) => /auto[_ -]?connect/i.test(x));
  if (setHit || regHit.length) A('PASS', 'WARP auto-connect', (setHit ? setHit.trim() : regHit.join('; ')).slice(0, 160));
  else if (!warp && !h) unread('WARP auto-connect', psWhy);
  else A('WARN', 'WARP auto-connect', 'no auto_connect in `warp-cli settings` and none under HKLM\\SOFTWARE\\Cloudflare\\CloudflareWARP or HKLM\\SOFTWARE\\Policies\\Cloudflare\\WARP (set it in the Zero Trust device profile)');

  const deny = v('rdp_deny');
  if (deny === null) unread('RDP enabled', h ? 'fDenyTSConnections absent' : psWhy);
  else A(Number(deny) === 0 ? 'PASS' : 'FAIL', 'RDP enabled', `fDenyTSConnections=${deny} (want 0)`);
  const nla = v('rdp_nla');
  if (nla === null) unread('RDP NLA', h ? 'UserAuthentication absent' : psWhy);
  else A(Number(nla) === 1 ? 'PASS' : 'WARN', 'RDP NLA', `RDP-Tcp UserAuthentication=${nla} (want 1)`);

  const fw = v('fw');
  if (!Array.isArray(fw)) unread('RDP firewall (mesh)', h ? `firewall cmdlets failed: ${String(v('fw_err') || '?').slice(0, 80)}` : psWhy);
  else {
    const hits = fw.filter((r) => (r.remote || []).some(coversMesh));
    A(hits.length ? 'PASS' : 'WARN', 'RDP firewall (mesh)', hits.length
      ? `${hits.map((r) => `${r.name} [${(r.remote || []).join('|')}]`).join(', ')}: LocalPort 3389, RemoteAddress covers 100.96.0.0/12`
      : `${fw.length} enabled inbound rule(s) with LocalPort 3389 (scan: ${v('fw_scan') || '?'}), none with RemoteAddress covering 100.96.0.0/12${fw.length ? ' (' + fw.map((r) => `${r.name}: ${(r.remote || []).join('|') || '?'}`).join('; ').slice(0, 200) + ')' : ''}`);
  }

  const auto = v('autologon');
  if (!h) unread('no auto-login', psWhy);
  else A(auto === null || String(auto) === '0' || auto === '' ? 'PASS' : 'FAIL', 'no auto-login', `Winlogon AutoAdminLogon=${auto === null ? 'absent' : auto} (want 0 or absent)`);

  const sb = v('standby');
  const m = sb && String(sb).match(/AC Power Setting Index:\s*0x([0-9a-f]+)/i);
  if (!m) unread('standby on AC', h ? 'powercfg output unparsed (localized?)' : psWhy);
  else { const secs = parseInt(m[1], 16); A(secs === 0 ? 'PASS' : 'FAIL', 'standby on AC', `STANDBYIDLE AC=${secs} s (want 0 = never)`); }

  const hibA = v('hib_a'), hibEn = v('hib_enabled'), hiberboot = v('hiberboot');
  const idx = hibA ? String(hibA).search(/not available/i) : -1;
  const hibOff = idx >= 0 && /hibernat/i.test(String(hibA).slice(idx));
  if (hibOff || Number(hibEn) === 0 && hibEn !== null) A('PASS', 'hibernate off', `powercfg /a: hibernation ${hibOff ? 'not available' : 'listed'}; HibernateEnabled=${hibEn ?? '?'}`);
  else if (hiberboot !== null && Number(hiberboot) === 0) A('PASS', 'hibernate off', `HiberbootEnabled=0 (fast startup off); HibernateEnabled=${hibEn ?? '?'}`);
  else if (!hibA && hibEn === null) unread('hibernate off', h ? 'powercfg /a and the Power registry key both unreadable' : psWhy);
  else A('WARN', 'hibernate off', `hibernation available (HibernateEnabled=${hibEn ?? '?'}, HiberbootEnabled=${hiberboot ?? '?'}; powercfg /h off)`);

  A('INFO', 'BIOS power-on after power loss', 'cannot be read from Windows: verify in firmware');
}

// ---- doctor: per-bot integration checks --------------------------------------------------
// A git-connected Workers Builds trigger on a Worker the bot also deploys by
// hand means one push deploys twice. Script tag first (the Builds API keys on
// it), name as a fallback. Token from the env only; the daemon injects it.
async function cfBuildTriggers(acct, worker, token) {
  const base = 'https://api.cloudflare.com/client/v4';
  const get = async (u) => {
    const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    let body = null; try { body = await r.json(); } catch {}
    return { status: r.status, body };
  };
  const scripts = await get(`${base}/accounts/${acct}/workers/scripts`);
  const list = Array.isArray(scripts.body && scripts.body.result) ? scripts.body.result : null;
  const hit = list ? list.find((s) => s && s.id === worker) : null;
  if (list && !hit) return { found: false };
  const tag = (hit && (hit.tag || hit.id)) || worker;
  const t = await get(`${base}/accounts/${acct}/builds/workers/${encodeURIComponent(tag)}/triggers`);
  if (t.status !== 200 || !t.body || t.body.success === false) return { error: `HTTP ${t.status}${t.body && t.body.errors && t.body.errors[0] ? ': ' + t.body.errors[0].message : ''}` };
  const triggers = Array.isArray(t.body.result) ? t.body.result : (t.body.result ? [t.body.result] : []);
  return { found: true, triggers: triggers.length };
}

async function botIntegrationChecks(bot, cfg, add) {
  const cf = cfg.integrations.cloudflare;
  if (cf.account_id && cf.workers.length) {
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!token) add('INFO', `${bot}: cloudflare builds`, `CLOUDFLARE_API_TOKEN not in the env; ${cf.workers.length} worker(s) not checked`);
    else {
      for (const w of cf.workers) {
        let r;
        try { r = await cfBuildTriggers(cf.account_id, String(w), token); } catch (e) { r = { error: e.name === 'TimeoutError' ? 'timed out after 10 s' : e.message }; }
        if (r.error) add('WARN', `${bot}: cloudflare builds ${w}`, `could not read (${scrub(r.error).slice(0, 120)})`);
        else if (!r.found) add('WARN', `${bot}: cloudflare builds ${w}`, 'no such Worker in the account');
        else add(r.triggers ? 'FAIL' : 'PASS', `${bot}: cloudflare builds ${w}`, r.triggers ? `git-connected Workers Builds trigger on ${w}: a push would double-deploy (${r.triggers} trigger(s))` : 'no Workers Builds trigger');
      }
    }
  } else if (cf.account_id || cf.workers.length) add('INFO', `${bot}: cloudflare builds`, 'integrations.cloudflare needs both account_id and workers');
  else add('INFO', `${bot}: cloudflare builds`, 'not configured (integrations.cloudflare)');

  const g = cfg.integrations.google;
  if (g.account) {
    const tokenFile = path.join(botHome(bot), 'token.json');
    if (!fs.existsSync(tokenFile)) add('INFO', `${bot}: google account`, `no token.json in bots/${bot} (nothing to compare with ${g.account})`);
    else {
      let r;
      try { r = await googleTokenEmail(tokenFile); } catch (e) { r = { error: e.name === 'TimeoutError' ? 'timed out after 10 s' : e.message }; }
      if (r.error) add('WARN', `${bot}: google account`, `about.user.emailAddress unreadable (${scrub(r.error).slice(0, 120)}); ${g.account} not verified`);
      else add(r.email.toLowerCase() === String(g.account).toLowerCase() ? 'PASS' : 'FAIL', `${bot}: google account`, `token.json is ${r.email} (bot.yaml says ${g.account})`);
    }
  }
}

// Drive `about.user.emailAddress` for the account behind a google-auth
// token.json (access token first, refresh once on 401). No python, no client
// library: the same two HTTPS calls whatever tools the bot ships.
async function googleTokenEmail(tokenFile) {
  const t = readJson(tokenFile);
  if (!t) return { error: 'token.json unparsable' };
  const about = async (access) => {
    const r = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { headers: { Authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(10_000) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, email: j && j.user && j.user.emailAddress };
  };
  let r = t.token ? await about(t.token) : { status: 401 };
  if (r.status === 401 && t.refresh_token && t.client_id && t.client_secret) {
    const body = new URLSearchParams({ client_id: t.client_id, client_secret: t.client_secret, refresh_token: t.refresh_token, grant_type: 'refresh_token' });
    const rr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body, signal: AbortSignal.timeout(10_000) });
    let j = null; try { j = await rr.json(); } catch {}
    if (j && j.access_token) r = await about(j.access_token);
    else return { error: `token refresh HTTP ${rr.status}` };
  }
  return r.email ? { email: String(r.email) } : { error: `HTTP ${r.status}` };
}

// A machine-wide CLAUDE_CODE_OAUTH_TOKEN (HKCU user env, or the daemon's own
// env) is some other bot's account. Every bot must launch on its own vault
// token; the launcher takes the vault first, so this asserts the vault entry
// exists and is not that same token (last 4 characters, never more).
function userEnvTokenLast4() {
  const pv = process.platform === 'win32' ? runPwshCommand("[Environment]::GetEnvironmentVariable('CLAUDE_CODE_OAUTH_TOKEN','User')", { timeoutMs: 30_000 }) : { out: '' };
  const v = (pv.out || '').trim() || process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
  return v ? v.slice(-4) : '';
}

function oauthInheritanceCheck(bot, vaultRows, envLast4, add) {
  const row = vaultRows.find((r) => r.key === 'oauth_token');
  const vaultLast4 = row && /^\*+(.{4})$/.test(row.masked) ? row.masked.slice(-4) : '';
  if (!envLast4) { add('PASS', `${bot}: oauth token`, `no machine-wide CLAUDE_CODE_OAUTH_TOKEN; ${row ? `vault ****${vaultLast4}` : 'no vault entry (session needs /login)'}`); return; }
  if (!row) { add('FAIL', `${bot}: oauth token`, `no vault oauth_token: the launcher would inherit the machine-wide token ****${envLast4} (another bot's account) - botcorp secrets set ${bot} oauth`); return; }
  if (vaultLast4 && vaultLast4 === envLast4) add('FAIL', `${bot}: oauth token`, `vault oauth_token ****${vaultLast4} IS the machine-wide CLAUDE_CODE_OAUTH_TOKEN (same account as whoever set it) - give this bot its own token`);
  else add('PASS', `${bot}: oauth token`, `vault ****${vaultLast4 || '????'} overrides the machine-wide ****${envLast4}`);
}

// HKCU Run entries once per doctor run (every bot's tray check reads the same key).
function trayRunEntries() {
  const r = runPwshCommand("(Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue).PSObject.Properties | Where-Object { $_.Name -like 'BotCorp-Tray-*' } | ForEach-Object { $_.Name }", { timeoutMs: 30_000 });
  return new Set(r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
}

// Does an account's token still log in? One 1-turn Haiku call under that
// account's config dir with the token in the child env only, cached 24 h by
// the vault fingerprint (never the token) in <rt>/state/account-checks.json.
const ACCOUNT_CHECK_TTL_MS = 24 * 3600 * 1000;
function accountTokenChecks(add) {
  const list = accountsListJson();
  if (!list.ok) { add('WARN', 'accounts', `accounts list failed: ${list.err.slice(0, 160)}`, 'accounts'); return; }
  if (!list.rows.length) { add('INFO', 'accounts', 'none (botcorp accounts add <id> | seed)', 'accounts'); return; }
  const cacheFile = path.join(STATE_DIR, 'account-checks.json');
  const cache = readJson(cacheFile) || {};
  let dirty = false;
  for (const a of list.rows) {
    if (!a.masked) { add('WARN', `account ${a.id}: token`, 'no token in the vault (botcorp accounts add)', 'accounts'); continue; }
    const c = a.fp && cache[a.fp];
    if (c && Date.now() - Date.parse(c.at || 0) < ACCOUNT_CHECK_TTL_MS) { add(c.ok ? 'PASS' : 'FAIL', `account ${a.id}: token`, `${c.detail} (cached ${humanAge(Date.now() - Date.parse(c.at))} ago)`, 'accounts'); continue; }
    const tok = accountsPs(['-Action', 'get', '-Id', a.id, '-IAmTheLauncher']);
    if (tok.code !== 0 || !tok.out) { add('FAIL', `account ${a.id}: token`, 'vault unreadable (re-enter with botcorp accounts add)', 'accounts'); continue; }
    const env = { CLAUDE_CONFIG_DIR: a.config_dir, CLAUDE_CODE_OAUTH_TOKEN: tok.out, CLAUDECODE: '', CLAUDE_CODE_CHILD_SESSION: '', CLAUDE_CODE_ENTRYPOINT: '', CLAUDE_CODE_SSE_PORT: '' };
    try { fs.mkdirSync(a.config_dir, { recursive: true }); } catch {}
    const r = runClaude(['-p', 'Reply with the single word ok.', '--model', 'claude-haiku-4-5-20251001', '--max-turns', '1', '--output-format', 'json'], { env, timeoutMs: 90_000, cwd: a.config_dir });
    let ok = false, detail = '';
    try { const j = JSON.parse(r.out.trim()); ok = r.code === 0 && j && !j.is_error; detail = ok ? `haiku replied (${a.masked})` : `is_error=${j && j.is_error} exit ${r.code}`; }
    catch { detail = r.timedOut ? 'timed out after 90 s' : `exit ${r.code}: ${scrub((r.err || r.out).trim()).split(/\r?\n/)[0].slice(0, 120)}`; }
    if (a.fp) { cache[a.fp] = { ok, at: new Date().toISOString(), detail }; dirty = true; }
    add(ok ? 'PASS' : 'FAIL', `account ${a.id}: token`, detail, 'accounts');
  }
  if (dirty) { try { writeJsonAtomic(cacheFile, cache); } catch {} }
}

async function cmdDoctor({ flags }) {
  const checks = [];
  const add = (level, name, detail = '', group = 'core') => checks.push({ level, name, detail, group });
  const accessFile = path.join(BOTCORP_HOME, 'access.json');
  const machineAccess = readJson(accessFile);

  if (!flags.host) {
    // tooling
    const minCc = (readJson(path.join(ROOT, 'botcorp.json')) || {}).minClaudeCode || '0.0.0';
    const cv = runClaude(['--version'], { timeoutMs: 30_000 });
    const ccVer = semver(cv.out + cv.err);
    if (!ccVer) add('FAIL', 'claude', `not runnable (${resolveClaude()})`);
    else add(semverGte(ccVer, semver(minCc)) ? 'PASS' : 'FAIL', 'claude', `${ccVer.join('.')} (min ${minCc}) at ${resolveClaude()}`);
    const nv = semver(process.versions.node);
    add(nv[0] >= 20 ? 'PASS' : 'FAIL', 'node', `${process.versions.node} (min 20)`);
    const py = resolvePython();
    const pyv = py && semver(py.version);
    add(pyv && (pyv[0] > 3 || (pyv[0] === 3 && pyv[1] >= 11)) ? 'PASS' : 'FAIL', 'python', py ? `${py.version} (min 3.11) at ${py.file} (via ${py.via})` : `not found: looked in ${PYTHON_LOOKED_IN}`);
    const pv = runPwshCommand('$PSVersionTable.PSVersion.ToString()', { timeoutMs: 30_000 });
    const psv = semver(pv.out);
    add(psv && psv[0] >= 7 ? 'PASS' : 'FAIL', 'pwsh', psv ? `${psv.join('.')} (min 7) at ${resolvePwsh()}` : `not runnable (${resolvePwsh()}): ${(pv.err || pv.out).trim().slice(0, 120)}`);
    const gitPath = resolveGit();
    const gv = gitPath ? run(gitPath, ['--version'], { timeoutMs: 15_000 }) : null;
    add(gv && gv.code === 0 ? 'PASS' : 'FAIL', 'git', gv && gv.code === 0 ? `${gv.out.trim()} at ${gitPath}` : 'not found on PATH or under Program Files\\Git');

    // harness
    const pj = readJson(path.join(ROOT, 'harness', '.claude-plugin', 'plugin.json'));
    add(pj && pj.version ? 'PASS' : 'FAIL', 'harness plugin.json', pj ? `v${pj.version}` : 'unreadable');
    const pvld = runClaude(['plugin', 'validate', 'harness', '--strict'], { timeoutMs: 90_000, cwd: ROOT });
    add(pvld.code === 0 ? 'PASS' : 'FAIL', 'claude plugin validate harness --strict', (pvld.out + pvld.err).trim().split(/\r?\n/).slice(-1)[0] || `exit ${pvld.code}`);

    // scheduled tasks: ours present (WARN if not); any other *Bot* task is a WARN
    // (another supervisor?) unless host.coexist_tasks allowlists it (then INFO)
    const tasks = runPwshCommand("Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like '*Bot*' } | ForEach-Object { $_.TaskName }", { timeoutMs: 60_000 });
    const names = tasks.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const t of ['BotCorp-Daemon', 'BotCorp-Launch']) add(names.includes(t) ? 'PASS' : 'WARN', `task ${t}`, names.includes(t) ? 'registered' : 'absent (botcorp install)');
    const coexist = coexistTasks();
    const foreign = names.filter((n) => !['BotCorp-Daemon', 'BotCorp-Launch'].includes(n));
    const allowed = foreign.filter((n) => matchesAnyGlob(n, coexist.patterns));
    const unexpected = foreign.filter((n) => !allowed.includes(n));
    if (allowed.length) add('INFO', 'coexisting *Bot* tasks', `${allowed.join(', ')} (allowlisted by host.coexist_tasks: ${coexist.patterns.join(', ')})`);
    add(unexpected.length ? 'WARN' : 'PASS', 'foreign *Bot* tasks', unexpected.length
      ? `${unexpected.join(', ')} (another supervisor for the same bot? if they coexist by design, allowlist the name or a *-glob in host.coexist_tasks: botcorp.json or ${coexist.file})`
      : 'none');

    // harness edited in place
    const rootIsGit = fs.existsSync(path.join(ROOT, '.git'));
    if (rootIsGit) {
      const st = run(gitExe(), ['-C', ROOT, 'status', '--porcelain'], { timeoutMs: 30_000 });
      add(st.out.trim() ? 'WARN' : 'PASS', 'harness edited in place', st.out.trim() ? `${st.out.trim().split(/\r?\n/).length} modified path(s) in ${ROOT}` : 'clean');
    } else add('WARN', 'harness edited in place', `${ROOT} is not a git checkout (cannot tell)`);

    // per bot (a bot folder is a plain folder: no per-bot git checks)
    const envLast4 = userEnvTokenLast4();
    const trayEntries = process.platform === 'win32' ? trayRunEntries() : new Set();
    for (const bot of listBots()) {
      let cfg = null;
      try { cfg = loadBotYaml(botYamlPath(bot)); const errs = validate(cfg); add(errs.length ? 'FAIL' : 'PASS', `${bot}: bot.yaml`, errs.length ? errs.join('; ') : 'valid', 'bots'); }
      catch (e) { add('FAIL', `${bot}: bot.yaml`, e.message, 'bots'); }
      const vault = secretsListJson(bot);
      const vd = vault.ok ? secretsDoctorJson(bot) : null;
      if (!vault.ok) add('FAIL', `${bot}: vault`, `secrets list failed: ${vault.err.slice(0, 160)}`, 'bots');
      else if (vault.rows.some((r) => r.masked === 'unreadable') || (vd && vd.probe && vd.probe.ok === false && !(vd.lock && vd.lock.locked))) add('FAIL', `${bot}: vault`, `vault unreadable (${vd && vd.probe ? vd.probe.detail : 'unreadable entry'}) - re-enter tokens (botcorp secrets set)`, 'bots');
      else {
        add(vault.rows.some((r) => r.key === 'oauth_token') ? 'PASS' : 'WARN', `${bot}: vault`, vault.rows.length ? `${vault.rows.map((r) => r.key).join(', ')}` : 'no entries (no oauth_token: the session will need /login)', 'bots');
        oauthInheritanceCheck(bot, vault.rows, envLast4, (l, n, d) => add(l, n, d, 'bots'));
      }
      if (vd && vd.acl) add(vd.acl.ok ? 'PASS' : 'WARN', `${bot}: vault acl`, vd.acl.ok ? vd.acl.detail : `${vd.acl.detail} (botcorp secrets acl ${bot})`, 'bots');
      else if (vault.ok) add('WARN', `${bot}: vault acl`, 'could not read (secrets doctor failed)', 'bots');
      // lock mode: what key.json says vs what bot.yaml asks for
      if (vd && vd.lock) {
        const want = cfg && cfg.vault && cfg.vault.lock ? String(cfg.vault.lock) : null;
        const l = vd.lock;
        if (l.locked) add('WARN', `${bot}: vault lock`, `${l.detail} - the daemon will not start or restart this bot until then`, 'bots');
        else if (want && want !== l.mode) add('WARN', `${bot}: vault lock`, `bot.yaml vault.lock: ${want} but the vault is ${l.mode} (${l.mode === 'operator' ? `botcorp secrets unlock ${bot} --permanent` : `botcorp secrets lock ${bot}`})`, 'bots');
        else add(l.version === 1 ? 'INFO' : 'PASS', `${bot}: vault lock`, `${l.mode} v${l.version}: ${l.detail}`, 'bots');
      }
      if (process.platform === 'win32') { const iso = vaultIsolationCheck(bot); add(iso.level, `${bot}: vault isolation`, iso.detail, 'bots'); }
      // scoping: what the launcher will inject vs what the vault holds
      if (cfg && vault.ok) {
        const declared = Array.isArray(cfg.secrets) ? cfg.secrets.map(String) : [];
        const present = vault.rows.map((r) => r.key);
        const missing = declared.filter((k) => !present.includes(k) && !(k === 'telegram_token' && !cfg.harness.modules.telegram));
        const undeclared = present.filter((k) => !declared.includes(k));
        add(missing.length ? 'WARN' : 'PASS', `${bot}: secrets scope`, `injects ${declared.join(', ') || '(none)'}${missing.length ? `; declared but not in the vault: ${missing.join(', ')} (botcorp secrets set ${bot} <key>)` : ''}${undeclared.length ? `; in the vault but not declared, never decrypted: ${undeclared.join(', ')}` : ''}`, 'bots');
      }
      // a --bg launch with bypass refuses until the disclaimer is accepted (user
      // settings of the CONFIG HOME) and the workspace is trusted (.claude.json
      // there); both are what `botcorp sync` writes.
      if (cfg) {
        const us = readJson(path.join(configDir(bot), 'settings.json'));
        if (cfg.permissions === 'bypass') add(us && us.skipDangerousModePermissionPrompt === true ? 'PASS' : 'FAIL', `${bot}: bypass disclaimer accepted`, us && us.skipDangerousModePermissionPrompt === true ? `.claude-${bot}/settings.json skipDangerousModePermissionPrompt` : `\`claude --bg --dangerously-skip-permissions\` refuses until it is: botcorp sync ${bot}`, 'bots');
        const cj = readJson(path.join(configDir(bot), '.claude.json'));
        const trusted = !!(cj && cj.projects && cj.projects[botHome(bot).replace(/\\/g, '/')] && cj.projects[botHome(bot).replace(/\\/g, '/')].hasTrustDialogAccepted === true);
        add(trusted ? 'PASS' : 'FAIL', `${bot}: workspace trusted`, trusted ? `.claude-${bot}/.claude.json trusts bots/${bot}` : `a --bg launch refuses an untrusted workspace: botcorp sync ${bot}`, 'bots');
      }
      // the generated settings.json must exist (WARN if not); the config home's
      // settings.json is optional. Neither may ever carry enabledPlugins.
      for (const [f, absentLevel] of [[path.join(botHome(bot), '.claude', 'settings.json'), 'WARN'], [path.join(configDir(bot), 'settings.json'), 'PASS']]) {
        const j = readJson(f);
        const rel = path.relative(ROOT, f).replace(/\\/g, '/');
        if (!j) { add(absentLevel, `${bot}: enabledPlugins`, `${rel} absent${absentLevel === 'WARN' ? ' (botcorp sync)' : ''}`, 'bots'); continue; }
        // `claude plugin disable` itself writes `"telegram@...": false` there: only a true entry enables
        const ep = j.enabledPlugins;
        const on = ep == null ? [] : isObj(ep) ? Object.entries(ep).filter(([, v]) => v !== false).map(([k]) => k) : [String(ep)];
        add(on.length ? 'FAIL' : 'PASS', `${bot}: enabledPlugins`, on.length ? `${rel} enables ${on.join(', ')} (a plain \`claude\` there would steal the poller)` : `${rel} clean`, 'bots');
      }
      if (rootIsGit) {
        const r = run(gitExe(), ['-C', ROOT, 'check-ignore', '-q', `bots/${bot}/.vault`], { timeoutMs: 15_000 });
        add(r.code === 0 ? 'PASS' : 'FAIL', `${bot}: BotCorp ignores bots/${bot}/.vault`, r.code === 0 ? 'yes' : 'NO', 'bots');
      }
      if (!cfg) continue;
      if (cfg.harness.tray) add(trayEntries.has(`BotCorp-Tray-${bot}`) ? 'PASS' : 'WARN', `${bot}: tray`, trayEntries.has(`BotCorp-Tray-${bot}`) ? 'HKCU Run entry registered' : `harness.tray is on but no HKCU Run entry (botcorp tray ${bot} on)`, 'bots');
      else add('INFO', `${bot}: tray`, 'off (harness.tray: false)', 'bots');
      if (cfg.harness.modules.telegram) {
        const st = pairingState(bot);
        const open = st.policy === 'pairing' && !st.allowFrom.length;
        add(open ? 'WARN' : 'PASS', `${bot}: pairing`, `policy=${st.policy} allowlisted=${st.allowFrom.length} pending=${st.pending.length}${open ? ` (nobody can talk to the bot without a pairing code: botcorp pair ${bot} <id>)` : ''}${st.present ? '' : ' (access.json absent until sync/start)'}`, 'bots');
        const installed = telegramPluginInstalled(bot);
        add(installed ? 'PASS' : 'FAIL', `${bot}: telegram plugin installed`, installed ? `telegram@claude-plugins-official in .claude-${bot}/plugins` : `not in .claude-${bot}/plugins, so --channels starts nothing: botcorp sync ${bot}`, 'bots');
        // measured, like `status`: the plugin's bot.pid alive under this bot's claude
        const s = botStatus(bot);
        const poller = s.state && s.state.poller;
        if (!s.running) add('INFO', `${bot}: telegram channel running`, 'bot not running', 'bots');
        else if (poller === 'OWNED') add('PASS', `${bot}: telegram channel running`, `bot.pid ${s.poller_pid} under claude ${s.state.claude_pid ?? (s.pty && s.pty.ptyPid)}`, 'bots');
        else if (poller === 'FOREIGN') add('WARN', `${bot}: telegram channel running`, 'launched WITHOUT --channels: another live process held the owner-lock (launches.log says which)', 'bots');
        else if (poller === 'UNKNOWN') add('WARN', `${bot}: telegram channel running`, 'bot.pid is alive but the process tree could not be read', 'bots');
        else {
          const sid = botState(bot).session_id || null;
          const why = telegramMcpLastError(bot, sid);
          const said = !why ? ` - no plugin MCP log for session ${sid || '?'} (the plugin never started: /mcp in \`claude attach\` shows it)` : why.error ? ` - the plugin said: "${why.error}"` : '';
          add('FAIL', `${bot}: telegram channel running`, `poller=${poller}: no live bot.pid under the bot's claude${said}. Fix: botcorp stop ${bot}; botcorp start ${bot} --debug (launches.log shows the daemon and poller lines, .claude-${bot}/debug/ the session's own log)${installed ? '' : `; the plugin is missing first: botcorp sync ${bot}`}`, 'bots');
        }
      }
      // the backup module makes the folder a repo; then the vault and the config home must be ignored THERE
      if (cfg.backup.git_remote && fs.existsSync(path.join(botHome(bot), '.git'))) {
        for (const p of ['.vault', `.claude-${bot}`]) {
          const r = run(gitExe(), ['-C', botHome(bot), 'check-ignore', '-q', p], { timeoutMs: 15_000 });
          add(r.code === 0 ? 'PASS' : 'FAIL', `${bot}: backup repo ignores ${p}`, r.code === 0 ? 'yes' : `NO - a push would send it to ${cfg.backup.git_remote}`, 'bots');
        }
      }
      if (cfg.integrations.access.team) {
        if (!machineAccess) add('WARN', `${bot}: integrations.access`, `team=${cfg.integrations.access.team} in bot.yaml but the cockpit is not exposed (machine-wide: botcorp cockpit expose)`, 'bots');
        else if (machineAccess.team !== cfg.integrations.access.team) add('WARN', `${bot}: integrations.access`, `bot.yaml team=${cfg.integrations.access.team} differs from ${accessFile} team=${machineAccess.team}`, 'bots');
        else add('PASS', `${bot}: integrations.access`, `team=${cfg.integrations.access.team} matches the machine`, 'bots');
      }
      await botIntegrationChecks(bot, cfg, (l, n, d) => add(l, n, d, 'bots'));
    }

    // accounts (chat logins): does each token still log in? --no-accounts skips the live call
    if (!flags['no-accounts']) accountTokenChecks(add);

    // cockpit
    const health = await httpOk(`http://127.0.0.1:${COCKPIT_PORT}/healthz`);
    add(health === 200 ? 'PASS' : 'WARN', 'cockpit /healthz', health === 200 ? `127.0.0.1:${COCKPIT_PORT} up` : `127.0.0.1:${COCKPIT_PORT} down (npm run cockpit)`, 'cockpit');
    add('PASS', 'cockpit exposure', machineAccess ? `exposed via Access team=${machineAccess.team} (${accessFile})` : `loopback-only (no ${accessFile}; botcorp cockpit expose to change)`, 'cockpit');
    if (!machineAccess) {
      const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
      const hits = [];
      for (const ip of lan) { const s = await httpOk(`http://${ip}:${COCKPIT_PORT}/healthz`); if (s !== null) hits.push(`${ip}:${COCKPIT_PORT} -> ${s}`); }
      add(hits.length ? 'FAIL' : 'PASS', 'cockpit off-box exposure', hits.length ? `reachable off-box without Access: ${hits.join(', ')}` : `no listener on ${lan.length ? lan.join(', ') : 'any LAN address'}`, 'cockpit');
    }
  }

  // host (Windows): WARP at boot, RDP over the mesh, no auto-login, never sleep
  if (process.platform === 'win32') hostChecks(add);
  else add('INFO', 'host: checks', `only implemented for Windows (this is ${process.platform})`, 'host');

  if (flags.json) outJson(checks);
  else {
    let group = '';
    for (const c of checks) {
      if (c.group !== group) { group = c.group; out(`[${group}]`); }
      out(`${c.level.padEnd(4)} ${c.name}${c.detail ? ': ' + c.detail : ''}`);
    }
  }
  const fails = checks.filter((c) => c.level === 'FAIL').length;
  if (!flags.json) out(`doctor: ${checks.length} checks, ${fails} FAIL, ${checks.filter((c) => c.level === 'WARN').length} WARN`);
  return fails ? 1 : 0;
}

// ---- help --------------------------------------------------------------------------------
const HELP = `botcorp - operator CLI (docs/cli.md)

  new [--name <slug>] [--persona "..."] [--telegram] [--telegram-owner <id>] [--modules a,b] [--no-modules c]
      [--yes] [--oauth-stdin] [--no-launch] [--no-plugin-install]      (a terminal without --yes shows the catalogue checklist)
  export <bot> [--out <zip>] [--list] [--include-state] | import <zip> [--as <name>]
  backup <bot> [--dry-run]                                              (needs backup.git_remote in bot.yaml)
  adopt <path> --as <name> [--dry-run] [--config-dir <old CLAUDE_CONFIG_DIR>]   (copies; no repo, no token, no .env)
  accounts add <id> [--label <text>] [--plan <text>] | list [--json] | remove <id> | seed   (chat logins; token on stdin or hidden prompt)
  chat [--account <id>] [--cwd <folder>|--generic] [--dry-run]     (plain claude for an account in its own WT tab; a picker without flags)
  attach <bot> [--elevate] | tray <bot> on [--attach-at-login]|off|status   (pull a bg bot up in a WT tab; per-bot tray icon at login)
  sync <bot> [--dry-run]
  secrets set <bot> <key> | list <bot> [--json] | delete <bot> <key> | acl <bot> | audit [bot] [--tail N] [--json]
      | migrate <bot> | lock <bot> | unlock <bot> [--permanent]           (per-bot key; operator lock: passphrase on stdin, LOCKED after every reboot until unlock)
      | export-bundle <bot> --out <dir> [--files a,~/b] | import-bundle <bot> <bundle.enc> [--manifest <json>] [--dry-run] [--allow-home] [--force]
      (any key; value on stdin or hidden prompt; oauth|telegram|hub alias oauth_token|telegram_token|hub_token,
      other keys reach automations[].secrets as UPPERCASE env; audit reads state/secret-access.jsonl,
      newest --tail lines (default 50, max 5000), optional bot filter, no value ever recorded;
      acl re-applies the vault ACL; export-bundle/import-bundle move a bot's vault between machines,
      passphrase always on stdin, never argv)
  pair <bot> <senderId> | pair <bot> --list [--json] | pair <bot> --deny <senderId>
  config get <bot> [<dotted.path>] [--json] | config set <bot> <dotted.path> <value>
  approve <bot> <id|--all> | approve <bot> --list [--json] | reject <bot> <id>
  start <bot> [--fresh] [--debug] | stop <bot> | restart <bot> [--fresh] [--debug]   (--debug: Claude Code debug log in <config>/debug/)
  status [<bot>] [--json]
  automations <bot> [list [--json] | pause <name> | resume <name> | run <name>]
  update [--json] | update --apply <tag> | update --skip <tag> | update --check
  install [--s4u] [--unregister] [--dry-run]                            (password: piped stdin "$pw | botcorp install", or a hidden TTY prompt; never argv)
  cockpit expose --team <t> --aud <a> --yes | cockpit unexpose            (machine-wide)
  suggest <bot> --topic <t> [--lesson <file>] [--dry-run]
  doctor [--json] [--host]
  help

exit codes: 0 ok, 1 error, 2 usage, 3 duplicate Telegram token
env: BOTCORP_HOME (runtime root, default ~/.botcorp), COCKPIT_PORT (default 4477), CLOUDFLARE_API_TOKEN (doctor, integrations.cloudflare)`;

const COMMANDS = {
  new: cmdNew, export: cmdExport, import: cmdImport, backup: cmdBackup, adopt: cmdAdopt,
  accounts: cmdAccounts, chat: cmdChat, attach: cmdAttach, tray: cmdTray,
  sync: cmdSync,
  secrets: cmdSecrets, pair: cmdPair, config: cmdConfig, approve: cmdApprove, reject: cmdReject,
  start: cmdStart, stop: cmdStop, restart: cmdRestart, status: cmdStatus, automations: cmdAutomations,
  update: cmdUpdate, install: cmdInstall, cockpit: cmdCockpit, suggest: cmdSuggest, doctor: cmdDoctor,
  help: () => { out(HELP); return 0; },
};

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const cmd = parsed.pos[0] || 'help';
  if (parsed.flags.help) { out(HELP); return 0; }
  const fn = COMMANDS[cmd];
  if (!fn) usage(`unknown command '${cmd}'\n${HELP}`);
  return await fn(parsed);
}

// exitCode + drain, not process.exit(): a piped stdout is asynchronous on
// Windows and a hard exit truncates the last lines the cockpit would read.
// The unref'd timer only fires if something (a keep-alive socket) lingers.
function finish(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 3000).unref();
}
main().then((code) => finish(Number.isInteger(code) ? code : 0)).catch((e) => {
  const code = e instanceof CliError ? e.code : 1;
  process.stderr.write(`botcorp: ${scrub(e && e.message ? e.message : String(e))}\n`);
  if (!(e instanceof CliError) && process.env.BOTCORP_DEBUG) process.stderr.write(String(e.stack) + '\n');
  finish(code);
});
