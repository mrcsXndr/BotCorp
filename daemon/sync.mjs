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
//   bots/<name>/CLAUDE.md, .gitignore, .claude/settings.local.json,
//   .claude/tg-enable.settings.json, memory/{TDL.md,MEMORY.md,personality.md}
//                                                     only if ABSENT (bot-owned after that).
// It NEVER writes settings.local.json once it exists, .claude/{rules,agents,skills},
// tools/, memory/ contents: those are the bot's, and a core update must not
// be able to clobber them.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBotYaml, validate } from './botyaml.mjs';

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

export function sync(botName, { botcorpRoot, dryRun = false, nodeExe = process.execPath } = {}) {
  const root = botcorpRoot || path.resolve(__dirname, '..');
  const botHome = path.join(root, 'bots', botName);
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
