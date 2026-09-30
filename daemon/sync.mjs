// sync.mjs - bot.yaml -> the files the harness owns inside a bot folder.
//
//   node daemon/sync.mjs <bot> [--dry-run] [--botcorp <root>]
//
// Idempotent: run at create, after every harness update apply, and whenever
// bot.yaml changes. Writes:
//   bots/<name>/.claude/settings.json                 GENERATED (header says so): env,
//                                                     permissions, model, effortLevel, ultracode (when set),
//                                                     statusLine, autoMemoryDirectory,
//                                                     disabledSkills, autoContinueAtUsageLimit,
//                                                     claudeMdExcludes (the operator's ~/.claude/CLAUDE.md).
//                                                     harness.disable: skill:<x> joins disabledSkills,
//                                                     agent:<x> and a tools: entry with enabled: false
//                                                     become permissions.deny rules.
//                                                     NO hooks (the plugin has them),
//                                                     NO enabledPlugins ever.
//   bots/<name>/.claude-<name>/settings.json          MERGED user settings: skipDangerousModePermissionPrompt
//                                                     when bot.yaml permissions: bypass (a --bg launch
//                                                     refuses until the disclaimer is accepted; only
//                                                     USER settings are honoured for it);
//                                                     autoCompactWindow from harness.context_window,
//                                                     and the same window in env (see below).
//   bots/<name>/.claude-<name>/.claude.json          MERGED: projects[<bot home>].hasTrustDialogAccepted
//                                                     (a --bg launch refuses an untrusted workspace)
//                                                     and hasClaudeMdExternalIncludesApproved (the
//                                                     harness rule imports load only when approved).
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
//   bots/<name>/.claude-<name>/botcorp/telegram.json  GENERATED: default_chat_id and quiet from
//                                                     bot.yaml integrations.telegram.chat_id /
//                                                     .quiet, read by tools/tg/* at send time
//                                                     (no restart).
//   bots/<name>/.claude-<name>/rules/botcorp-global-<slug>.md
//                                                     GENERATED copy of each "All bots" knowledge doc
//                                                     (<BOTCORP_HOME>/global/knowledge/<slug>.md, written
//                                                     by `botcorp knowledge set --global`); Claude Code
//                                                     loads the config home's rules/ as user rules. A
//                                                     copy whose doc is gone is removed.
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
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBotYaml, validate, resolveContextWindow, resolveModel } from './botyaml.mjs';
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
      // A bot runs the Claude Code version BotCorp pinned and tested on the
      // canary (daemon/cc.ps1), so its session never downloads one itself. This
      // reverses the earlier choice to keep auto-update on: riding the global
      // update is how untested versions went live. Never DISABLE_UPDATES - that
      // also blocks `claude update` for every other Claude Code user of the box.
      DISABLE_AUTOUPDATER: '1',
      BOT_NAME: cfg.name,
      BOT_HOME: fwd(botHome),
    },
    // No Claude Code UI noise in a bot session: a bot's config home does not
    // inherit the operator's ~/.claude/settings.json, so it is set here. NOT
    // CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC - that turns off more than the
    // UI noise (auto-update is handled by DISABLE_AUTOUPDATER above).
    feedbackSurveyRate: 0,
    feedbackDrafts: 'off',
    spinnerTipsEnabled: false,
    promptSuggestionEnabled: false,
    showTurnDuration: false,
    permissions: cfg.permissions === 'bypass'
      ? { allow: ['Edit(*)', 'Write(*)', 'Bash(*)', 'Read(*)', 'Glob(*)', 'Grep(*)', 'WebFetch(*)', 'WebSearch(*)', 'Agent(*)', 'Skill(*)'],
          deny: ['AskUserQuestion', 'ExitPlanMode'], defaultMode: 'bypassPermissions' }
      : { deny: ['AskUserQuestion', 'ExitPlanMode'], defaultMode: 'default' },
    // a tier (harness/models.json) -> its id, and its effort unless bot.yaml sets one (none for tiny: the key is left out)
    model: resolveModel(cfg.model).id,
    effortLevel: cfg.effort ?? resolveModel(cfg.model).effort ?? undefined,
    // bot.yaml ultracode: true only; the key is left out otherwise (Claude Code's default is off)
    ultracode: cfg.ultracode === true ? true : undefined,
    statusLine: { type: 'command', command: `"${fwd(nodeExe)}" "${statusline}"` },
    autoMemoryDirectory: fwd(path.join(botHome, 'memory', 'auto')),
    autoContinueAtUsageLimit: true,
    // A background session (harness.session: bg) must run IN the bot folder:
    // an isolated worktree would detach it from memory/ and the config home.
    worktree: { bgIsolation: 'none' },
    // Claude Code walks up from the bot folder and loads <home>/.claude/CLAUDE.md
    // as PROJECT memory: the operator's own user instructions, which a bot with
    // its own config home must not get.
    claudeMdExcludes: [fwd(path.join(os.homedir(), '.claude', 'CLAUDE.md'))],
  };
  // harness.disable: skill:<x> is hidden like a skill left out of harness.skills;
  // agent:<x> gets a deny rule, so the session cannot start that subagent.
  const off = (kind) => (Array.isArray(cfg.harness.disable) ? cfg.harness.disable.map(String) : []).filter((x) => x.startsWith(`${kind}:`)).map((x) => x.slice(kind.length + 1));
  if (Array.isArray(cfg.harness.skills) || off('skill').length) {
    // hidden = every harness skill not in the list, in the plugin namespace
    const skillsDir = path.join(botcorpRoot, 'harness', 'skills');
    let all = [];
    try { all = fs.readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch {}
    const keep = new Set(Array.isArray(cfg.harness.skills) ? cfg.harness.skills.map(String) : all);
    for (const s of off('skill')) keep.delete(s);
    settings.disabledSkills = all.filter(s => !keep.has(s)).sort().map(s => `botcorp:${s}`);
  }
  // harness.agents is an allowlist like harness.skills ('all' = every one): a
  // harness agent left out of it, or named in harness.disable, gets a deny rule.
  const agentsOff = new Set(off('agent'));
  if (Array.isArray(cfg.harness.agents)) {
    const keep = new Set(cfg.harness.agents.map(String));
    let all = [];
    try { all = fs.readdirSync(path.join(botcorpRoot, 'harness', 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)); } catch {}
    for (const a of all) if (!keep.has(a)) agentsOff.add(a);
  }
  // A registry entry with enabled: false: the session may not run it (a Claude
  // Code deny rule on any Bash command naming its path; a policy, not a sandbox).
  const deny = [
    ...[...agentsOff].sort().map((a) => `Agent(botcorp:${a})`),
    ...(Array.isArray(cfg.tools) ? cfg.tools : []).filter((t) => t && t.enabled === false && typeof t.path === 'string').map((t) => `Bash(*${t.path.replace(/\\/g, '/').replace(/^\.\//, '')}*)`).sort(),
  ];
  if (deny.length) settings.permissions.deny = [...settings.permissions.deny, ...deny];
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
// the launcher did not start; 'auto' leaves the key as it is.
// The same window also goes in this file's `env`, because a machine-wide
// CLAUDE_CODE_AUTO_COMPACT_WINDOW outranks autoCompactWindow and the launch
// env did not reach the background worker (it carried the User-scope values).
// Claude Code writes a settings `env` entry into its own process env over the
// inherited value, so this wins inside the worker. The PCT override is set to
// 100, which Claude Code ignores (it can only lower the threshold), because a
// settings file cannot unset the inherited one. 'auto' removes both entries.
export function mergeConfigHomeSettings(existing, cfg) {
  const cur = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};
  if (cfg.permissions === 'bypass') cur.skipDangerousModePermissionPrompt = true;
  const cw = resolveContextWindow(cfg);
  if (cw.tokens) cur.autoCompactWindow = cw.tokens;
  const env = cur.env && typeof cur.env === 'object' && !Array.isArray(cur.env) ? { ...cur.env } : {};
  if (cw.tokens) {
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(cw.tokens);
    env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '100';
  } else {
    delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    delete env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
  }
  if (Object.keys(env).length) cur.env = env; else delete cur.env;
  return cur;
}

// The config home's .claude.json: a `--bg` launch also refuses an untrusted
// workspace ("run `claude` in <dir> once and accept the trust prompt"). The
// bot's own folder is trusted by definition - BotCorp made it - so the
// project record gets hasTrustDialogAccepted, keyed the way Claude Code keys
// it (absolute path, forward slashes); everything else in the file is kept.
// It also gets the external-include approval: CLAUDE.md imports the harness
// rules from outside the bot folder (@../../harness/rules/*.md), and Claude
// Code loads such an import only once that is approved - a background session
// never shows the prompt, so without the flag every import is silently skipped.
export function mergeConfigHomeClaudeJson(existing, botHome) {
  const cur = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};
  const projects = cur.projects && typeof cur.projects === 'object' ? { ...cur.projects } : {};
  const key = fwd(path.resolve(botHome));
  projects[key] = { ...(projects[key] && typeof projects[key] === 'object' ? projects[key] : {}), hasTrustDialogAccepted: true,
    hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true };
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

export function isShim(file) {
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

// ---- "All bots" knowledge -------------------------------------------------------
export const GLOBAL_RULE_PREFIX = 'botcorp-global-';
export const KNOWLEDGE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
export function globalKnowledgeDir(env = process.env) {
  return path.join(env.BOTCORP_HOME || path.join(os.homedir(), '.botcorp'), 'global', 'knowledge');
}

// The note goes after a leading `---` block, so a doc's frontmatter stays first.
export function globalRuleText(slug, body) {
  const note = `<!-- botcorp sync: a copy of the "All bots" doc ${slug}; edit it with \`botcorp knowledge set --global ${slug}\` or the cockpit. This file is regenerated. -->\n`;
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(body);
  return fm ? fm[0] + note + body.slice(fm[0].length) : note + body;
}

function syncGlobalKnowledge(configDir, dry, report) {
  const src = globalKnowledgeDir();
  const dest = path.join(configDir, 'rules');
  let slugs = [];
  try { slugs = fs.readdirSync(src, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith('.md')).map((d) => d.name.slice(0, -3)).filter((s) => KNOWLEDGE_SLUG_RE.test(s)).sort(); } catch {}
  for (const s of slugs) {
    let body;
    try { body = fs.readFileSync(path.join(src, `${s}.md`), 'utf-8'); } catch { continue; }
    report[`.claude-<name>/rules/${GLOBAL_RULE_PREFIX}${s}.md`] = writeIfChanged(path.join(dest, `${GLOBAL_RULE_PREFIX}${s}.md`), globalRuleText(s, body), dry);
  }
  let present = [];
  try { present = fs.readdirSync(dest).filter((n) => n.startsWith(GLOBAL_RULE_PREFIX) && n.endsWith('.md')); } catch {}
  for (const n of present.sort()) {
    if (slugs.includes(n.slice(GLOBAL_RULE_PREFIX.length, -3))) continue;
    if (!dry) fs.rmSync(path.join(dest, n), { force: true });
    report[`.claude-<name>/rules/${n}`] = dry ? 'would-remove' : 'removed (the doc is gone)';
  }
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
  // Claude Code's own state (account, every project record) lives in this file:
  // one it cannot parse is left alone rather than replaced by just our keys.
  const claudeJson = readJson(claudeJsonPath);
  report['.claude-<name>/.claude.json'] = claudeJson === null && fs.existsSync(claudeJsonPath)
    ? 'skipped (not valid JSON; left as it is)'
    : writeIfChanged(claudeJsonPath, JSON.stringify(mergeConfigHomeClaudeJson(claudeJson, botHome), null, 2) + '\n', dryRun);

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

  // 2b. the default chat and the quiet hours for tools/tg/* (tg_send.py reads them at send time)
  const chatId = cfg.integrations.telegram.chat_id;
  const quiet = typeof cfg.integrations.telegram.quiet === 'string' ? cfg.integrations.telegram.quiet.trim() : null;
  report['.claude-<name>/botcorp/telegram.json'] = writeIfChanged(path.join(configDir, 'botcorp', 'telegram.json'),
    JSON.stringify({ _generated_by: GENERATED_HEADER, default_chat_id: chatId == null || chatId === '' ? null : String(chatId), quiet }, null, 2) + '\n', dryRun);

  // 2c. tools/tg shims (the bot's own copies are kept)
  syncToolShims(botHome, root, dryRun, report);

  // 2d. "All bots" knowledge -> the config home's user rules
  syncGlobalKnowledge(configDir, dryRun, report);

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
