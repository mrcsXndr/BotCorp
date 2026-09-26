// sync.mjs - bot.yaml -> the files the harness owns inside a bot folder.
//
//   node daemon/sync.mjs <bot> [--dry-run] [--botcorp <root>]
//
// Idempotent: run at create, after every harness update apply, and whenever
// bot.yaml changes. Writes:
//   bots/<name>/.claude/settings.json                 GENERATED (header says so): env,
//                                                     permissions, model, effortLevel,
//                                                     statusLine, autoMemoryDirectory,
//                                                     disabledSkills, autoContinueAtUsageLimit.
//                                                     NO hooks (the plugin has them),
//                                                     NO enabledPlugins ever.
//   bots/<name>/.claude-<name>/settings.json          MERGED user settings: skipDangerousModePermissionPrompt
//                                                     when bot.yaml permissions: bypass (a --bg launch
//                                                     refuses until the disclaimer is accepted; only
//                                                     USER settings are honoured for it);
//                                                     autoCompactWindow from harness.context_window.
//   bots/<name>/.claude-<name>/.claude.json          MERGED: projects[<bot home>].hasTrustDialogAccepted
//                                                     (a --bg launch refuses an untrusted workspace).
//   bots/<name>/.claude-<name>/channels/telegram/access.json
//                                                     dmPolicy + allowFrom from bot.yaml,
//                                                     MERGED: never drops a pending entry
//                                                     or an id the operator approved by hand.
//   bots/<name>/.claude-<name>/channels/telegram/approved/<id>
//                                                     empty marker for every id the merge
//                                                     ADDS to allowFrom (the plugin polls
//                                                     that dir, sends "Paired!", deletes
//                                                     it; ids already in the file get no
//                                                     second marker, so a re-sync never
//                                                     re-greets anyone).
//   bots/<name>/.claude-<name>/botcorp/telegram.json  GENERATED: default_chat_id from bot.yaml
//                                                     integrations.telegram.chat_id, read by
//                                                     tools/tg/* at send time (no restart).
//   bots/<name>/tools/<dir>/<tool>.{py,sh,ps1}        forwarding SHIM per harness tools/<dir>/ tool
//                                                     (toolShimText): the rules, skills and CLAUDE.md
//                                                     say `python tools/tg/tg_send.py`, `bash
//                                                     tools/browser/ab.sh`, ... relative to the bot
//                                                     folder, but the tools ship in the harness.
//                                                     Written only where the file is absent or is
//                                                     already a shim; a bot's own copy is never
//                                                     touched, and a shim whose harness tool is
//                                                     gone is removed.
//   bots/<name>/CLAUDE.md, .gitignore, .claude/settings.local.json,
//   .claude/tg-enable.settings.json, memory/{TDL.md,MEMORY.md,personality.md}
//                                                     only if ABSENT (bot-owned after that).
// It NEVER writes settings.local.json once it exists, .claude/{rules,agents,skills},
// tools/ (other than the shims above), memory/ contents: those are the bot's,
// and a core update must not be able to clobber them.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBotYaml, validate, resolveContextWindow } from './botyaml.mjs';
import { botHome as botHomeOf } from '../core/paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const GENERATED_HEADER = 'botcorp sync - edit bot.yaml or settings.local.json instead; this file is regenerated';

function fwd(p) { return p.replace(/\\/g, '/'); }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

function writeIfChanged(file, text, dry) {
  let cur = null;
  try { cur = fs.readFileSync(file, 'utf-8'); } catch {}
  if (cur === text) return 'unchanged';
  if (dry) return 'would-write';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return cur === null ? 'created' : 'updated';
}

function copyIfAbsent(src, dest, dry, transform) {
  if (fs.existsSync(dest)) return 'kept';
  if (!fs.existsSync(src)) return 'no-template';
  if (dry) return 'would-create';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let body = fs.readFileSync(src, 'utf-8');
  if (transform) body = transform(body);
  fs.writeFileSync(dest, body);
  return 'created';
}

// The generated settings. Key order is fixed so two syncs of the same bot.yaml
// are byte-identical (the idempotence check diffs the file).
export function buildSettings(cfg, { botcorpRoot, botHome, nodeExe }) {
  const statusline = fwd(path.join(botcorpRoot, 'harness', 'tools', 'infra', 'statusline.js'));
  const settings = {
    _generated_by: GENERATED_HEADER,
    env: {
      PYTHONIOENCODING: 'utf-8',
      CLAUDE_CODE_ARTIFACT_AUTO_OPEN: '0',
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
      BOT_NAME: cfg.name,
      BOT_HOME: fwd(botHome),
    },
    // No Claude Code UI noise in a bot session: a bot's config home does not
    // inherit the operator's ~/.claude/settings.json, so it is set here. NOT
    // CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC - that also disables auto-update.
    feedbackSurveyRate: 0,
    feedbackDrafts: 'off',
    spinnerTipsEnabled: false,
    promptSuggestionEnabled: false,
    showTurnDuration: false,
    permissions: cfg.permissions === 'bypass'
      ? { allow: ['Edit(*)', 'Write(*)', 'Bash(*)', 'Read(*)', 'Glob(*)', 'Grep(*)', 'WebFetch(*)', 'WebSearch(*)', 'Agent(*)', 'Skill(*)'],
          deny: ['AskUserQuestion', 'ExitPlanMode'], defaultMode: 'bypassPermissions' }
      : { deny: ['AskUserQuestion', 'ExitPlanMode'], defaultMode: 'default' },
    model: cfg.model,
    effortLevel: cfg.effort,
    statusLine: { type: 'command', command: `"${fwd(nodeExe)}" "${statusline}"` },
    autoMemoryDirectory: fwd(path.join(botHome, 'memory', 'auto')),
    autoContinueAtUsageLimit: true,
    // A background session (harness.session: bg) must run IN the bot folder:
    // an isolated worktree would detach it from memory/ and the config home.
    worktree: { bgIsolation: 'none' },
  };
  if (Array.isArray(cfg.harness.skills)) {
    // hidden = every harness skill not in the list, in the plugin namespace
    const skillsDir = path.join(botcorpRoot, 'harness', 'skills');
    let all = [];
    try { all = fs.readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch {}
    const keep = new Set(cfg.harness.skills.map(String));
    settings.disabledSkills = all.filter(s => !keep.has(s)).sort().map(s => `botcorp:${s}`);
  }
  return settings;
}

// The config home's USER settings (bots/<name>/.claude-<name>/settings.json)
// are MERGED, never regenerated: the operator may keep keys there. A `--bg`
// launch with --dangerously-skip-permissions refuses until the bypass
// disclaimer was accepted once interactively - impossible for a fresh config
// home the daemon starts unattended - and Claude Code honours
// skipDangerousModePermissionPrompt from USER settings only (not the
// project .claude/settings.json). Written only when bot.yaml already opts
// the bot into bypass; an existing key is left alone otherwise.
// autoCompactWindow = harness.context_window resolved to tokens, for a session
// the launcher did not start (the launcher also sets the env var, which Claude
// Code ranks above this setting); 'auto' leaves the key as it is.
export function mergeConfigHomeSettings(existing, cfg) {
  const cur = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};
  if (cfg.permissions === 'bypass') cur.skipDangerousModePermissionPrompt = true;
  const cw = resolveContextWindow(cfg);
  if (cw.tokens) cur.autoCompactWindow = cw.tokens;
  return cur;
}

// The config home's .claude.json: a `--bg` launch also refuses an untrusted
// workspace ("run `claude` in <dir> once and accept the trust prompt"). The
// bot's own folder is trusted by definition - BotCorp made it - so the
// project record gets hasTrustDialogAccepted, keyed the way Claude Code keys
// it (absolute path, forward slashes); everything else in the file is kept.
export function mergeConfigHomeClaudeJson(existing, botHome) {
  const cur = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};
  const projects = cur.projects && typeof cur.projects === 'object' ? { ...cur.projects } : {};
  const key = fwd(path.resolve(botHome));
  projects[key] = { ...(projects[key] && typeof projects[key] === 'object' ? projects[key] : {}), hasTrustDialogAccepted: true };
  cur.projects = projects;
  return cur;
}

// access.json merge: bot.yaml is the source for policy + allow_from, but the
// file can carry ids the operator approved at the machine and pending pairing
// codes the plugin wrote; a sync must never drop those.
export function mergeAccess(existing, cfg) {
  const cur = existing && typeof existing === 'object' ? existing : {};
  const yamlIds = (cfg.integrations.telegram.allow_from || []).map(String);
  const fileIds = Array.isArray(cur.allowFrom) ? cur.allowFrom.map(String) : [];
  const allowFrom = [...new Set([...fileIds, ...yamlIds])];
  const policy = cfg.integrations.telegram.dm_policy;
  return {
    ...cur,
    dmPolicy: policy === 'allowlist' ? 'allowlist' : policy === 'disabled' ? 'disabled' : 'pairing',
    allowFrom,
    groups: cur.groups && typeof cur.groups === 'object' ? cur.groups : {},
    pending: cur.pending && typeof cur.pending === 'object' ? cur.pending : {},
  };
}

// ---- tools/ shims -------------------------------------------------------------
// The harness rules, skills, agents, the bot template's CLAUDE.md and the
// hooks' nudges say `python tools/tg/tg_send.py ...`, `bash
// tools/browser/ab.sh ...`, run from the bot folder; the tools live at
// <BotCorp>/harness/tools/<dir>/. A shim per tool runs the harness copy
// (argv, stdin, exit code pass through), so there is one copy of the code and
// a harness update needs no re-sync. It finds the harness relative to itself
// (bots/<bot>/tools/<dir> -> <BotCorp>), then at the checkout sync baked in (a
// bot folder reached through a junction resolves elsewhere); never a
// plugin-cache version path. Every harness tools/<dir>/ is covered, so a new
// tool or folder needs nothing here. `_`-prefixed files are private modules
// the tools import from their own folder, not entry points.
export const SHIM_MARKER = '# botcorp-shim: generated by botcorp sync';
export const SHIM_EXTS = ['.py', '.sh', '.ps1'];

const sq = (s) => `'${s.replace(/'/g, "'\\''")}'`;           // bash single-quoted
const psq = (s) => `'${s.replace(/'/g, "''")}'`;             // PowerShell single-quoted

export function toolShimText(rel, botcorpRoot) {
  const botcorp = fwd(path.resolve(botcorpRoot));
  const own = 'Delete the marker line to make the file this bot\'s own; sync then never touches it.';
  if (rel.endsWith('.sh')) {
    return [
      '#!/usr/bin/env bash',
      SHIM_MARKER,
      `# Runs the harness copy of this tool. ${own}`,
      `REL=${sq(rel)}`,
      `BOTCORP=${sq(botcorp)}`,
      'here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"',
      'for t in "$here/../../../../harness/$REL" "$BOTCORP/harness/$REL"; do',
      '  if [ -f "$t" ] && ! [ "$t" -ef "${BASH_SOURCE[0]}" ]; then exec bash "$t" "$@"; fi',
      'done',
      'echo "botcorp shim: harness tool not found ($here/../../../../harness/$REL, $BOTCORP/harness/$REL): run botcorp sync <bot>" >&2',
      'exit 1',
      '',
    ].join('\n');
  }
  if (rel.endsWith('.ps1')) {
    return [
      SHIM_MARKER,
      `# Runs the harness copy of this tool. ${own}`,
      `$rel = ${psq(rel)}`,
      `$botcorp = ${psq(botcorp)}`,
      "$tried = @((Join-Path $PSScriptRoot \"../../../../harness/$rel\"), (Join-Path $botcorp \"harness/$rel\"))",
      'foreach ($t in $tried) {',
      '    if ((Test-Path -LiteralPath $t -PathType Leaf) -and ((Resolve-Path -LiteralPath $t).Path -ne $PSCommandPath)) { & $t @args; exit $LASTEXITCODE }',
      '}',
      "[Console]::Error.WriteLine(\"botcorp shim: harness tool not found ($($tried -join ', ')): run botcorp sync <bot>\")",
      'exit 1',
      '',
    ].join('\n');
  }
  return [
    SHIM_MARKER,
    `# Runs the harness copy of this tool. ${own}`,
    '# Run as a script it is the harness tool; imported by a bot\'s own script it',
    '# IS the harness module (a bare runpy on import would run the tool\'s CLI).',
    'import importlib.util',
    'import runpy',
    'import sys',
    'from pathlib import Path',
    '',
    `REL = ${JSON.stringify(rel)}`,
    `BOTCORP = ${JSON.stringify(botcorp)}`,
    '',
    'here = Path(__file__).resolve()',
    'tried = ([here.parents[4] / "harness" / REL] if len(here.parents) > 4 else []) + [Path(BOTCORP) / "harness" / REL]',
    'target = next((p for p in tried if p.is_file() and p.resolve() != here), None)',
    'if target is None:',
    '    sys.exit("botcorp shim: harness tool not found (tried " + ", ".join(str(p) for p in tried) + "): run botcorp sync <bot>")',
    'if __name__ == "__main__":',
    '    sys.argv[0] = str(target)',
    '    sys.path[0] = str(target.parent)',
    '    runpy.run_path(str(target), run_name="__main__")',
    'else:',
    '    _spec = importlib.util.spec_from_file_location(__name__, target)',
    '    _mod = importlib.util.module_from_spec(_spec)',
    '    sys.modules[__name__] = _mod',
    '    _spec.loader.exec_module(_mod)',
    '',
  ].join('\n');
}

function isShim(file) {
  let lines;
  try { lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/, 2); } catch { return null; }
  return lines[0] === SHIM_MARKER || (lines[0].startsWith('#!') && lines[1] === SHIM_MARKER);
}

function subdirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && !/^[_.]/.test(d.name)).map(d => d.name); } catch { return []; }
}

// One row per harness tool and per leftover shim: kind = 'own' (the bot's
// file), 'shim' (a shim, current or not: sync rewrites it), 'missing', or
// 'stale' (a shim whose harness tool is gone). Shared by sync and doctor.
export function toolShimState(botHome, botcorpRoot) {
  const rows = [];
  const srcRoot = path.join(botcorpRoot, 'harness', 'tools');
  const destRoot = path.join(botHome, 'tools');
  const shimmable = (n) => SHIM_EXTS.includes(path.extname(n)) && !n.startsWith('_');
  for (const dir of [...new Set([...subdirs(srcRoot), ...subdirs(destRoot)])].sort()) {
    let names = [];
    try { names = fs.readdirSync(path.join(srcRoot, dir), { withFileTypes: true }).filter(d => d.isFile() && shimmable(d.name)).map(d => d.name).sort(); } catch {}
    const destDir = path.join(destRoot, dir);
    for (const n of names) {
      const s = isShim(path.join(destDir, n));
      rows.push({ rel: `tools/${dir}/${n}`, kind: s === null ? 'missing' : s ? 'shim' : 'own' });
    }
    let present = [];
    try { present = fs.readdirSync(destDir).filter(n => shimmable(n) && !names.includes(n)); } catch {}
    for (const n of present.sort()) if (isShim(path.join(destDir, n))) rows.push({ rel: `tools/${dir}/${n}`, kind: 'stale' });
  }
  return rows;
}

// Changed shims are reported one per line; the unchanged ones as one count.
function syncToolShims(botHome, botcorpRoot, dry, report) {
  let unchanged = 0;
  for (const row of toolShimState(botHome, botcorpRoot)) {
    const dest = path.join(botHome, ...row.rel.split('/'));
    if (row.kind === 'own') { report[row.rel] = 'kept (bot-owned)'; continue; }
    if (row.kind === 'stale') {
      if (!dry) fs.rmSync(dest, { force: true });
      report[row.rel] = dry ? 'would-remove' : 'removed (harness tool gone)';
      continue;
    }
    const r = writeIfChanged(dest, toolShimText(row.rel, botcorpRoot), dry);
    if (r === 'unchanged') unchanged++;
    else {
      report[row.rel] = r;
      if (!dry && row.rel.endsWith('.sh')) { try { fs.chmodSync(dest, 0o755); } catch {} }
    }
  }
  if (unchanged) report[`tools/ shims (${unchanged})`] = 'unchanged';
}

export function sync(botName, { botcorpRoot, dryRun = false, nodeExe = process.execPath } = {}) {
  const root = botcorpRoot || path.resolve(__dirname, '..');
  const botHome = botHomeOf(botName, root);
  const yamlPath = path.join(botHome, 'bot.yaml');
  if (!fs.existsSync(yamlPath)) throw new Error(`no bot.yaml at ${yamlPath}`);
  const cfg = loadBotYaml(yamlPath);
  const errs = validate(cfg);
  if (errs.length) throw new Error(`bot.yaml invalid:\n  ${errs.join('\n  ')}`);
  if (cfg.name !== botName) throw new Error(`bot.yaml name "${cfg.name}" != folder "${botName}"`);

  const configDir = path.join(botHome, `.claude-${botName}`);
  const templates = path.join(root, 'templates', 'bot');
  const report = {};

  // 1. generated settings.json
  const settings = buildSettings(cfg, { botcorpRoot: root, botHome, nodeExe });
  report['.claude/settings.json'] = writeIfChanged(path.join(botHome, '.claude', 'settings.json'), JSON.stringify(settings, null, 2) + '\n', dryRun);

  // 1b. config-home user settings + workspace trust (merge)
  const userSettingsPath = path.join(configDir, 'settings.json');
  report['.claude-<name>/settings.json'] = writeIfChanged(userSettingsPath, JSON.stringify(mergeConfigHomeSettings(readJson(userSettingsPath), cfg), null, 2) + '\n', dryRun);
  const claudeJsonPath = path.join(configDir, '.claude.json');
  report['.claude-<name>/.claude.json'] = writeIfChanged(claudeJsonPath, JSON.stringify(mergeConfigHomeClaudeJson(readJson(claudeJsonPath), botHome), null, 2) + '\n', dryRun);

  // 2. access.json (merge)
  if (cfg.harness.modules.telegram) {
    const accessPath = path.join(configDir, 'channels', 'telegram', 'access.json');
    const existing = readJson(accessPath);
    const had = new Set(Array.isArray(existing && existing.allowFrom) ? existing.allowFrom.map(String) : []);
    const merged = mergeAccess(existing, cfg);
    report['.claude-<name>/channels/telegram/access.json'] = writeIfChanged(accessPath, JSON.stringify(merged, null, 2) + '\n', dryRun);
    const approvedDir = path.join(configDir, 'channels', 'telegram', 'approved');
    for (const id of merged.allowFrom.filter((x) => !had.has(String(x)))) {
      const marker = path.join(approvedDir, String(id));
      if (fs.existsSync(marker)) { report[`.claude-<name>/channels/telegram/approved/${id}`] = 'unchanged'; continue; }
      if (!dryRun) { fs.mkdirSync(approvedDir, { recursive: true }); fs.writeFileSync(marker, ''); }
      report[`.claude-<name>/channels/telegram/approved/${id}`] = dryRun ? 'would-create' : 'created';
    }
  } else {
    report['.claude-<name>/channels/telegram/access.json'] = 'skipped (telegram module off)';
  }

  // 2b. the default chat for tools/tg/* (tg_send.py resolve_chat_id reads it at send time)
  const chatId = cfg.integrations.telegram.chat_id;
  report['.claude-<name>/botcorp/telegram.json'] = writeIfChanged(path.join(configDir, 'botcorp', 'telegram.json'),
    JSON.stringify({ _generated_by: GENERATED_HEADER, default_chat_id: chatId == null || chatId === '' ? null : String(chatId) }, null, 2) + '\n', dryRun);

  // 2c. tools/tg shims (the bot's own copies are kept)
  syncToolShims(botHome, root, dryRun, report);

  // 3. bot-owned files, only if absent
  report['CLAUDE.md'] = copyIfAbsent(path.join(templates, 'CLAUDE.md'), path.join(botHome, 'CLAUDE.md'), dryRun,
    body => body.replace(/\{\{persona\}\}/g, cfg.persona).replace(/\{\{(bot_)?name\}\}/g, cfg.name));
  report['.gitignore'] = copyIfAbsent(path.join(templates, '.gitignore'), path.join(botHome, '.gitignore'), dryRun);
  report['.claude/settings.local.json'] = copyIfAbsent(path.join(templates, '.claude', 'settings.local.json'), path.join(botHome, '.claude', 'settings.local.json'), dryRun);
  report['.claude/tg-enable.settings.json'] = copyIfAbsent(path.join(templates, '.claude', 'tg-enable.settings.json'), path.join(botHome, '.claude', 'tg-enable.settings.json'), dryRun);
  for (const f of ['TDL.md', 'MEMORY.md', 'personality.md']) {
    report[`memory/${f}`] = copyIfAbsent(path.join(templates, 'memory', f), path.join(botHome, 'memory', f), dryRun);
  }
  for (const d of ['memory/sessions', 'memory/metrics', 'memory/auto', '.claude']) {
    if (!dryRun) fs.mkdirSync(path.join(botHome, d), { recursive: true });
  }
  if (!dryRun) fs.mkdirSync(configDir, { recursive: true });
  return { bot: botName, home: botHome, configDir, report };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('daemon/sync.mjs')) {
  const args = process.argv.slice(2);
  const bot = args.find(a => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const ri = args.indexOf('--botcorp');
  const botcorpRoot = ri !== -1 ? args[ri + 1] : undefined;
  if (!bot) { console.error('usage: sync.mjs <bot> [--dry-run] [--botcorp <root>]'); process.exit(2); }
  try {
    const r = sync(bot, { botcorpRoot, dryRun });
    for (const [k, v] of Object.entries(r.report)) console.log(`${v.padEnd(14)} ${k}`);
    console.log(`sync: ${bot} ${dryRun ? '(dry-run) ' : ''}ok`);
  } catch (e) {
    console.error(`sync: ${e.message}`);
    process.exit(1);
  }
}
