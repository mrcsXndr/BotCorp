// botyaml.mjs - the ONE bot.yaml parser. PowerShell has no YAML reader, so the
// daemon and the launcher shell out here and consume JSON; the CLI and the
// cockpit import the same functions. One parser, one set of defaults.
//
//   node daemon/botyaml.mjs <bots/<name>/bot.yaml>         -> effective config as JSON
//   node daemon/botyaml.mjs <bot.yaml> --get harness.modules.telegram
//
// Defaults are applied here (deep-merged under the file's values), so every
// consumer sees a complete object and never has to guess a missing key.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

// harness.hooks_disable takes the hook's file name without `.sh` (play-sound,
// session-debrief, ...): what each hook passes to _guard.sh. Read from disk so
// the list can never drift from the hooks that exist.
const HOOKS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'harness', 'hooks');
export function hookNames() {
  try {
    return fs.readdirSync(HOOKS_DIR).filter((f) => f.endsWith('.sh') && !f.startsWith('_') && f !== 'py.sh').map((f) => f.slice(0, -3)).sort();
  } catch { return []; }
}

export const DEFAULTS = {
  name: null,
  persona: 'A sharp, dry, loyal assistant: leads with action and never over-explains.',
  model: 'claude-opus-5-5',
  effort: 'high',
  permissions: 'bypass',            // bypass | default
  harness: {
    channel: 'stable',              // stable | pinned
    pin: null,                      // vX.Y.Z -> per-bot worktree (canary only)
    service: 'daemon',              // daemon (the daemon supervises: cold-start, liveness, heal) | manual (cockpit/CLI starts only)
    session: 'bg',                  // bg (claude --bg background session, attach to view; docs/host-service.md) | pty (inside daemon/pty-host.mjs)
    git_pull: false,                // bounded `git pull` of the BOT repo at launch
    telegram_token_file: false,     // write <config>/channels/telegram/.env (fallback if env inheritance fails)
    debug: false,                   // every launch gets --debug-file <config>/debug/<stamp>.txt (the plugin's stderr included); `botcorp start --debug` for one launch
    bun_path: '',                   // bun.exe for the Telegram plugin when it is neither on PATH nor in %USERPROFILE%\.bun\bin ('' = look there)
    tray: true,                     // per-bot tray icon at login (botcorp tray <bot> on; doctor checks the HKCU Run entry)
    hooks_disable: [],
    modules: {
      telegram: false, board: false, cost_meter: true, usage_resume: true,
      alert_triage: false, hub: false, janitor: true, remote_control: false,
      lessons: true, debrief: false, auto_commit: true, memory_sync: false,
      sound: false, telemetry: true,
    },
    skills: 'all',
    agents: 'all',
  },
  integrations: {
    telegram: { allow_from: [], dm_policy: 'pairing', chat_id: null },
    hub: { url: null, interval_s: 300 },
    board: { owner: null, number: null, type: 'user' },
    access: { team: null, aud: null, frame_ancestors: null },
    cloudflare: { account_id: null, workers: [] },   // doctor: refuse git-connected Workers Builds triggers
    google: { account: null },                       // doctor: which account the bot's token.json should belong to
  },
  automations: [],
  // Optional module, OFF while git_remote is null: `botcorp backup <bot>` commits
  // `paths` inside bots/<name>/ and pushes them (the folder is not a repo otherwise).
  backup: { git_remote: null, paths: ['memory'] },
  suggest: { weekly: false, max_prs_per_week: 2, digest_bot: null },
};

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

export function deepMerge(base, over) {
  if (!isObj(base)) return over === undefined ? base : over;
  const out = { ...base };
  if (!isObj(over)) return out;
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObj(base[k]) && isObj(v) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function loadBotYaml(file) {
  const raw = fs.readFileSync(file, 'utf-8');
  const parsed = yaml.load(raw) || {};
  if (!isObj(parsed)) throw new Error(`${file}: top level must be a mapping`);
  const cfg = deepMerge(DEFAULTS, parsed);
  if (!cfg.name) cfg.name = path.basename(path.dirname(path.resolve(file)));
  return cfg;
}

// Hard validation: the things a wrong value would break at launch time.
export function validate(cfg) {
  const errs = [];
  if (!NAME_RE.test(String(cfg.name || ''))) errs.push(`name: must match ${NAME_RE} (got ${JSON.stringify(cfg.name)})`);
  if (!['bypass', 'default'].includes(cfg.permissions)) errs.push(`permissions: bypass | default (got ${cfg.permissions})`);
  // Claude only (locked 2026-09-24): there is no driver seam, so a `cli:` key is a mistake, not a choice.
  if ('cli' in cfg) errs.push(`cli: not a bot.yaml key (Claude Code is the only CLI; got ${JSON.stringify(cfg.cli)})`);
  // Any other unknown top-level key is a typo that would otherwise be silently ignored.
  const known = new Set(Object.keys(DEFAULTS));
  const unknown = Object.keys(cfg).filter((k) => !known.has(k) && k !== 'cli' && !k.startsWith('_'));
  if (unknown.length) errs.push(`unknown top-level key(s) ${unknown.join(', ')} (valid: ${[...known].join(', ')})`);
  if (!['stable', 'pinned'].includes(cfg.harness.channel)) errs.push(`harness.channel: stable | pinned`);
  if (!['daemon', 'manual'].includes(cfg.harness.service)) errs.push(`harness.service: daemon | manual (got ${cfg.harness.service})`);
  if (!['bg', 'pty'].includes(cfg.harness.session)) errs.push(`harness.session: bg | pty (got ${cfg.harness.session})`);
  if (typeof cfg.harness.debug !== 'boolean') errs.push(`harness.debug: true | false (got ${JSON.stringify(cfg.harness.debug)})`);
  if (typeof cfg.harness.bun_path !== 'string') errs.push(`harness.bun_path: a path to bun.exe, or '' (got ${JSON.stringify(cfg.harness.bun_path)})`);
  if (!Array.isArray(cfg.harness.hooks_disable)) errs.push('harness.hooks_disable: must be a list');
  else {
    const known = hookNames();
    const bad = cfg.harness.hooks_disable.map(String).filter((h) => !known.includes(h));
    if (known.length && bad.length) errs.push(`harness.hooks_disable: unknown hook(s) ${bad.join(', ')} (valid: ${known.join(', ')})`);
  }
  if (!isObj(cfg.harness.modules)) errs.push('harness.modules: must be a mapping');
  if (!['pairing', 'allowlist', 'disabled'].includes(cfg.integrations.telegram.dm_policy)) errs.push('integrations.telegram.dm_policy: pairing | allowlist | disabled');
  if (!Array.isArray(cfg.integrations.telegram.allow_from)) errs.push('integrations.telegram.allow_from: must be a list of ids');
  if (!Array.isArray(cfg.integrations.cloudflare.workers)) errs.push('integrations.cloudflare.workers: must be a list of Worker names');
  const remote = cfg.backup.git_remote;
  if (remote !== null && !(typeof remote === 'string' && /^(https:\/\/|ssh:\/\/|git@)/.test(remote))) errs.push('backup.git_remote: null or an https:// / ssh:// / git@ URL');
  if (!Array.isArray(cfg.backup.paths) || !cfg.backup.paths.length || !cfg.backup.paths.every((p) => typeof p === 'string' && p && !p.startsWith('/') && !p.includes('..'))) errs.push('backup.paths: non-empty list of relative paths');
  if (!Array.isArray(cfg.automations)) errs.push('automations: must be a list');
  for (const [i, a] of (Array.isArray(cfg.automations) ? cfg.automations : []).entries()) {
    if (!a || typeof a !== 'object') { errs.push(`automations[${i}]: must be a mapping`); continue; }
    if (!a.name || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(a.name)) errs.push(`automations[${i}].name: slug required`);
    if (!a.command) errs.push(`automations[${i}].command: required`);
    const t = a.trigger || {};
    if (!t.cron && !t.interval_min && !t.event) errs.push(`automations[${i}].trigger: cron | interval_min | event required`);
  }
  return errs;
}

// Comma list of enabled module names -> BOT_MODULES for the launcher. `backup`
// is a module too, switched by backup.git_remote rather than a boolean, so an
// automation gated `module: backup` sees it here.
export function enabledModules(cfg) {
  const mods = Object.entries(cfg.harness.modules).filter(([, v]) => v === true).map(([k]) => k);
  if (cfg.backup && cfg.backup.git_remote) mods.push('backup');
  return mods;
}

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('botyaml.mjs')) {
  const file = process.argv[2];
  if (!file) { console.error('usage: botyaml.mjs <bot.yaml> [--get a.b.c] [--validate]'); process.exit(2); }
  let cfg;
  try { cfg = loadBotYaml(file); } catch (e) { console.error(`botyaml: ${e.message}`); process.exit(2); }
  const errs = validate(cfg);
  if (process.argv.includes('--validate')) {
    for (const e of errs) console.error(`bot.yaml: ${e}`);
    console.log(errs.length ? 'INVALID' : 'OK');
    process.exit(errs.length ? 1 : 0);
  }
  const gi = process.argv.indexOf('--get');
  if (gi !== -1) {
    const v = getPath(cfg, process.argv[gi + 1] || '');
    console.log(typeof v === 'string' ? v : JSON.stringify(v ?? null));
    process.exit(0);
  }
  cfg._modules = enabledModules(cfg);
  cfg._errors = errs;
  console.log(JSON.stringify(cfg));
}
