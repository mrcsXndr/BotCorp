// tools.mjs - the capability registry (bot.yaml `tools:`): find every
// executable a bot carries, match it against the registry, and propose entries
// for the ones no entry covers. Pure reads except retireFiles (which moves
// files into the runtime). botcorp.mjs owns the verbs (`botcorp tools`), the
// queue and the doctor rows; this file owns what counts as a tool.
//
// An executable is a .py .mjs .js .cjs .sh .ps1 file under tools/ or scripts/,
// minus `_`-prefixed private modules, test_* files, __pycache__/node_modules
// and the shims `botcorp sync` generates. Referenced-by-text is not the same as
// invoked, so an orphan is only ever proposed for retiring, never retired.

import fs from 'node:fs';
import path from 'node:path';
import { isShim } from '../daemon/sync.mjs';
import { GUARD_HOOKS } from '../daemon/botyaml.mjs';

export const TOOL_EXTS = ['.py', '.mjs', '.js', '.cjs', '.sh', '.ps1'];
export const TOOL_ROOTS = ['tools', 'scripts'];
// Bot files the harness itself loads by a fixed path, so no bot text names them.
// One explicit list: the harness text names many bot paths generically.
export const HARNESS_LOADED = [{ path: 'tools/tg_commands_local.py', loader: 'harness/tools/v2/tg_commands.py', kind: 'lib' }];
const SKIP_DIRS = new Set(['__pycache__', 'node_modules', '.git']);
const DOC_EXTS = new Set(['.md', '.json', '.yaml', '.yml', '.txt', ...TOOL_EXTS]);
const MAX_TEXT = 2 * 1024 * 1024;

const fwd = (p) => p.split(path.sep).join('/');
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function walk(dir, keep, outList = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return outList; }
  for (const e of ents) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && e.name !== 'worktrees') walk(abs, keep, outList); }
    else if (e.isFile() && keep(e.name)) outList.push(abs);
  }
  return outList;
}

function readText(abs) {
  try { return fs.statSync(abs).size > MAX_TEXT ? '' : fs.readFileSync(abs, 'utf-8').replace(/\\/g, '/'); } catch { return ''; }
}

// Every code file under tools/ and scripts/ (bot-relative, forward slashes);
// `entry` = an executable (not private, not a test, not a shim).
function codeFiles(botHome) {
  const rows = [];
  for (const root of TOOL_ROOTS) {
    for (const abs of walk(path.join(botHome, root), (n) => TOOL_EXTS.includes(path.extname(n).toLowerCase()))) {
      const name = path.basename(abs);
      const shim = !!isShim(abs);
      rows.push({ rel: fwd(path.relative(botHome, abs)), abs, shim, entry: !shim && !name.startsWith('_') && !name.startsWith('test_') });
    }
  }
  return rows.sort((a, b) => a.rel.localeCompare(b.rel));
}

export function listExecutables(botHome) {
  return codeFiles(botHome).filter((f) => f.entry).map((f) => f.rel);
}

export function isGlob(p) { return /[*?]/.test(String(p)); }

// `*` and `?` stay inside one path segment, `**` crosses them.
export function globRe(glob) {
  let re = '';
  const g = String(glob).replace(/\\/g, '/');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += '.*'; i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

export function covers(entry, rel) {
  if (!isObj(entry) || typeof entry.path !== 'string') return false;
  const p = entry.path.replace(/\\/g, '/').replace(/^\.\//, '');
  return isGlob(p) ? globRe(p).test(rel) : p.toLowerCase() === rel.toLowerCase();
}

// The strings that mean "this file" in another file's text: the bot-relative
// path, and for tools/<dir>/<f> the tools-relative one (hooks call `v2/x.py`).
function pathNeedles(rel) {
  const n = [rel];
  const parts = rel.split('/');
  if (parts[0] === 'tools' && parts.length > 2) n.push(parts.slice(1).join('/'));
  return n;
}

function importedBy(rel, text) {
  const base = path.posix.basename(rel);
  if (text.includes(base)) return true;
  if (path.posix.extname(rel) === '.py') {
    const stem = base.slice(0, -3).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^\\s*(?:from\\s+(?:[\\w.]*\\.)?${stem}\\s+import\\b|import\\s+(?:[\\w.]*\\.)?${stem}\\b|from\\s+[\\w.]+\\s+import\\s+[^\\n]*\\b${stem}\\b)`, 'm').test(text);
  }
  return false;
}

function docSources(botHome) {
  const files = [path.join(botHome, 'CLAUDE.md')];
  walk(path.join(botHome, '.claude'), (n) => DOC_EXTS.has(path.extname(n).toLowerCase()), files);
  walk(path.join(botHome, 'scripts'), (n) => DOC_EXTS.has(path.extname(n).toLowerCase()), files);
  return [...new Set(files)].map((abs) => ({ rel: fwd(path.relative(botHome, abs)), text: readText(abs) })).filter((d) => d.text);
}

// The env names a declared vault key reaches a process as.
const SESSION_NAMES = { oauth_token: 'CLAUDE_CODE_OAUTH_TOKEN', telegram_token: 'TELEGRAM_BOT_TOKEN' };
const envNames = (k) => [k.toUpperCase(), SESSION_NAMES[k]].filter(Boolean);
// TOKEN(?!S): *_TOKENS is a count (MAX_CONTEXT_TOKENS), not a token.
const SECRET_NAME_RE = /(TOKEN(?!S)|SECRET|PASSWORD|PASSWD|BEARER|CREDENTIAL|API_KEY|ACCESS_KEY|_KEY$)/;
const ENV_READ_RES = [
  /os\.environ\[\s*['"]([A-Za-z_]\w*)['"]\s*\]/g,
  /os\.environ\.get\(\s*['"]([A-Za-z_]\w*)['"]/g,
  /os\.getenv\(\s*['"]([A-Za-z_]\w*)['"]/g,
  /process\.env\.([A-Za-z_]\w*)/g,
  /process\.env\[\s*['"`]([A-Za-z_]\w*)['"`]\s*\]/g,
  /\$env:([A-Za-z_]\w*)/gi,
];

// The secret env names a file's text reads, sorted: a declared key's env name
// anywhere in the text, or an env read whose literal name looks like a secret.
export function secretReads(text, declared = []) {
  const found = new Set();
  for (const k of declared.map(String)) for (const n of envNames(k)) if (text.includes(n)) found.add(n);
  for (const re of ENV_READ_RES) for (const m of text.matchAll(re)) if (SECRET_NAME_RE.test(m[1])) found.add(m[1]);
  return [...found].sort();
}

// Split a file's reads into the declared keys they come from and the rest.
function readKeys(reads, declared) {
  const secrets = declared.filter((k) => envNames(k).some((n) => reads.includes(n)));
  const covered = new Set(secrets.flatMap(envNames));
  return { secrets, undeclared: reads.filter((n) => !covered.has(n)) };
}

function slug(s) {
  return String(s).toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'tool';
}

// Scan a bot folder against its effective config. -> {
//   registry: off|warn|enforce, executables: [rel],
//   registered: [{name, path, kind, purpose, secrets, matches}], missing: [name], unused: [name],
//   unregistered: [rel], automation_unregistered: [{automation, path}],
//   underclassified: [{path, entry, reads}] (a secret reader no integration entry covers),
//   proposal: { tools: [entries], orphans: [rel | {path, reads}] } }
export function scanTools(botHome, cfg) {
  const all = codeFiles(botHome);
  const exes = all.filter((f) => f.entry);
  const tools = Array.isArray(cfg.tools) ? cfg.tools.filter(isObj) : [];
  const docs = docSources(botHome);
  const importers = all.filter((f) => !f.shim && !path.basename(f.rel).startsWith('test_')).map((f) => ({ rel: f.rel, text: readText(f.abs) }));
  const autos = (Array.isArray(cfg.automations) ? cfg.automations : []).filter((a) => isObj(a) && typeof a.command === 'string' && a.kind !== 'prompt');
  const declared = (Array.isArray(cfg.secrets) ? cfg.secrets : []).map(String);

  const refs = new Map();
  for (const f of exes) {
    const needles = pathNeedles(f.rel);
    const hit = (t) => needles.some((n) => t.includes(n));
    const auto = autos.find((a) => hit(a.command.replace(/\\/g, '/')));
    const doc = docs.find((d) => d.rel !== f.rel && hit(d.text));
    const imp = importers.find((o) => o.rel !== f.rel && (hit(o.text) || importedBy(f.rel, o.text)));
    const harness = HARNESS_LOADED.find((h) => h.path === f.rel);
    refs.set(f.rel, { auto, doc, imp, harness: harness ? harness.loader : null });
  }
  const referenced = (rel) => { const r = refs.get(rel); return !!(r && (r.auto || r.doc || r.imp || r.harness)); };
  const textOf = new Map(importers.map((o) => [o.rel, o.text]));
  const reads = new Map(exes.map((f) => [f.rel, secretReads(textOf.get(f.rel) || '', declared)]));
  const readerDirs = new Set(exes.filter((f) => reads.get(f.rel).length).map((f) => path.posix.dirname(f.rel)));
  // "also reads FOO_TOKEN, not declared" for a proposal's purpose.
  const alsoReads = (undeclared) => (undeclared.length ? `; also reads ${undeclared.join(', ')}, not declared` : '');

  const registered = tools.map((t) => ({ name: t.name, path: t.path, kind: t.kind, purpose: t.purpose ? String(t.purpose) : null, secrets: Array.isArray(t.secrets) ? t.secrets.map(String) : [], matches: exes.filter((f) => covers(t, f.rel)).length }));
  // Any code file counts, as for an exact path: a glob over test_* or _private files is not "missing".
  const missing = tools.filter((t) => (isGlob(t.path) ? !all.some((f) => covers(t, f.rel)) : !fs.existsSync(path.join(botHome, String(t.path || ''))))).map((t) => t.name);
  const unused = tools.filter((t) => !isGlob(t.path) && t.kind !== 'lib' && exes.some((f) => covers(t, f.rel)) && !exes.some((f) => covers(t, f.rel) && referenced(f.rel))).map((t) => t.name);
  const unregistered = exes.filter((f) => !tools.some((t) => covers(t, f.rel))).map((f) => f.rel);
  // A registered secret reader no integration entry covers.
  const underclassified = exes.filter((f) => reads.get(f.rel).length).flatMap((f) => {
    const cov = tools.filter((t) => covers(t, f.rel));
    return cov.length && !cov.some((t) => t.kind === 'integration') ? [{ path: f.rel, entry: String(cov[0].name), reads: reads.get(f.rel) }] : [];
  });
  const automationUnregistered = [];
  for (const a of autos) {
    for (const f of exes) {
      if (pathNeedles(f.rel).some((n) => a.command.replace(/\\/g, '/').includes(n)) && unregistered.includes(f.rel)) automationUnregistered.push({ automation: a.name, path: f.rel });
    }
  }

  // The proposal, for the unregistered executables only.
  const exact = [], cliByDir = new Map(), libByDir = new Map(), orphans = [];
  for (const rel of unregistered) {
    const { auto, doc, imp, harness } = refs.get(rel);
    const r = reads.get(rel);
    const { secrets: readSecrets, undeclared } = readKeys(r, declared);
    // A secret reader is always an exact integration entry, whatever references it.
    const integration = (purpose, extra = []) => {
      const secrets = [...new Set([...extra, ...readSecrets])];
      exact.push({ name: slug(path.posix.basename(rel)), path: rel, kind: 'integration', purpose: purpose + alsoReads(undeclared), ...(secrets.length ? { secrets } : {}) });
    };
    if (harness) {
      if (r.length) integration(`loaded by ${harness}`);
      else exact.push({ name: slug(path.posix.basename(rel)), path: rel, kind: HARNESS_LOADED.find((h) => h.path === rel).kind, purpose: `loaded by ${harness}` });
    } else if (auto) {
      const secrets = Array.isArray(auto.secrets) ? auto.secrets.map(String) : [];
      if (secrets.length || r.length) integration(`run by automation ${auto.name}`, secrets);
      else exact.push({ name: slug(path.posix.basename(rel)), path: rel, kind: 'monitor', purpose: `run by automation ${auto.name}` });
    } else if (doc) {
      if (r.length) integration(`referenced from ${doc.rel}`);
      else { const d = path.posix.dirname(rel); cliByDir.set(d, [...(cliByDir.get(d) || []), { rel, from: doc.rel }]); }
    } else if (imp) {
      if (r.length) integration(`imported by ${imp.rel}`);
      else { const d = path.posix.dirname(rel); libByDir.set(d, [...(libByDir.get(d) || []), rel]); }
    } else orphans.push(r.length ? { path: rel, reads: r } : rel);
  }
  const groupPath = (dir, rels) => {
    const exts = [...new Set(rels.map((r) => path.posix.extname(r)))];
    return `${dir}/*${exts.length === 1 ? exts[0] : ''}`;
  };
  const dirSlug = (d) => slug(d.replace(/^tools(\/|$)/, '') || 'tools');
  // No glob over a folder holding a secret reader: it would register the reader below integration.
  for (const [dir, items] of cliByDir) {
    if (items.length === 1 || readerDirs.has(dir)) for (const it of items) exact.push({ name: slug(path.posix.basename(it.rel)), path: it.rel, kind: 'cli', purpose: `referenced from ${it.from}` });
    else exact.push({ name: `cli-${dirSlug(dir)}`, path: groupPath(dir, items.map((i) => i.rel)), kind: 'cli', purpose: `${items.length} scripts referenced from CLAUDE.md / .claude / scripts` });
  }
  for (const [dir, all] of libByDir) {
    // a cli glob over the same directory already covers these
    const rels = all.filter((r) => !exact.some((e) => isGlob(e.path) && covers(e, r)));
    if (!rels.length) continue;
    if (rels.length > 1 && readerDirs.has(dir)) for (const r of rels) exact.push({ name: slug(path.posix.basename(r)), path: r, kind: 'lib', purpose: 'module imported by other tools' });
    else exact.push({ name: `lib-${dirSlug(dir)}`, path: rels.length === 1 ? rels[0] : groupPath(dir, rels), kind: 'lib', purpose: `${rels.length} module${rels.length === 1 ? '' : 's'} imported by other tools` });
  }
  // Names stay unique against the registry and each other (a clash gets its directory).
  const taken = new Set(tools.map((t) => String(t.name)));
  for (const e of exact) {
    if (taken.has(e.name)) e.name = slug(`${path.posix.dirname(e.path).replace(/^tools\/?/, '')}-${e.name}`);
    let n = e.name, i = 2;
    while (taken.has(n)) n = `${e.name}-${i++}`;
    e.name = n;
    taken.add(n);
  }

  return {
    registry: cfg.tools === null || cfg.tools === undefined ? 'off' : (cfg.harness && cfg.harness.tools_registry) || 'warn',
    executables: exes.map((f) => f.rel),
    registered, missing, unused, unregistered, underclassified,
    automation_unregistered: automationUnregistered,
    proposal: { tools: exact, orphans },
  };
}

// The clean-day record (<rt>/state/<bot>.registry-days.json): one row per
// local date, {scans, worst: {<DAY_KEYS>: count}}, worst-of-day, 30 days kept.
// A day is clean with at least one scan and every worst count at 0.
export const DAY_KEYS = ['unregistered', 'missing', 'automation_unregistered', 'underclassified'];
export const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function nextRegistryDays(days, scan, now = new Date()) {
  const k = localDate(now);
  const prev = isObj(days[k]) ? days[k] : {};
  const worst = {};
  for (const n of DAY_KEYS) worst[n] = Math.max(Number(isObj(prev.worst) && prev.worst[n]) || 0, (scan[n] || []).length);
  const all = { ...days, [k]: { scans: (Number(prev.scans) || 0) + 1, worst } };
  return Object.fromEntries(Object.keys(all).sort().slice(-30).map((d) => [d, all[d]]));
}

// Consecutive clean days ending today (or yesterday while today has no scan
// yet); a day with no row breaks the streak.
export function cleanStreak(days, now = new Date()) {
  const clean = (r) => isObj(r) && Number(r.scans) >= 1 && isObj(r.worst) && DAY_KEYS.every((n) => Number(r.worst[n]) === 0);
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!days[localDate(d)]) d.setDate(d.getDate() - 1);
  let n = 0;
  while (clean(days[localDate(d)])) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

const BARE_PY_RE =/^\s*(python3?|py)(\.exe)?(\s|$)/i;
const few = (list) => `${list.slice(0, 5).join(', ')}${list.length > 5 ? ` (+${list.length - 5} more)` : ''}`;

// The doctor rows for one bot: [{level, name, detail}], `<bot>` in detail for
// the caller to fill. scan = scanTools(...) or null when the registry is off
// (`tools:` absent): then only the two rows that do not need it. streak =
// cleanStreak(...) of the clean-day record, or null to leave out the enforce row.
export function registryRows(cfg, scan, streak = null) {
  const rows = [];
  if (scan && scan.registry !== 'off') {
    const gap = scan.registry === 'enforce' ? 'FAIL' : 'WARN';   // harness.tools_registry
    const u = scan.unregistered;
    rows.push(u.length
      ? { level: gap, name: 'tools-unregistered', detail: `${u.length} executable(s) no tools: entry covers: ${few(u)}. Fix: botcorp tools <bot> scan --proposal <file>, then register --file or retire` }
      : { level: 'PASS', name: 'tools-unregistered', detail: `every executable is registered (${scan.executables.length})` });
    rows.push(scan.missing.length
      ? { level: 'FAIL', name: 'tools-missing', detail: `tools: entries matching no file: ${few(scan.missing)}. Fix: botcorp config remove <bot> tools <name>` }
      : { level: 'PASS', name: 'tools-missing', detail: `all ${scan.registered.length} entries match a file` });
    const au = scan.automation_unregistered;
    rows.push(au.length
      ? { level: gap, name: 'automation-unregistered', detail: `automation commands naming an unregistered script: ${few(au.map((a) => `${a.automation} -> ${a.path}`))}` }
      : { level: 'PASS', name: 'automation-unregistered', detail: 'every script an automation runs is registered' });
    const uc = scan.underclassified || [];
    rows.push(uc.length
      ? { level: gap, name: 'tools-underclassified', detail: `secret readers registered below integration: ${few(uc.map((x) => `${x.path} (${x.entry}) reads ${x.reads.join(', ')}`))}. Fix: register each as an exact kind: integration entry with its secrets` }
      : { level: 'PASS', name: 'tools-underclassified', detail: 'no registered secret reader sits below integration' });
    if (scan.registry === 'warn' && streak !== null) {
      rows.push({ level: 'INFO', name: 'tools-enforce-ready', detail: streak >= 7
        ? `clean ${streak}/7 consecutive days: ready for botcorp config set <bot> harness.tools_registry enforce`
        : `clean ${streak}/7 consecutive days before enforce (botcorp tools <bot> gate)` });
    }
    if (scan.unused.length) rows.push({ level: 'INFO', name: 'tools-unused', detail: `registered but referenced by nothing (no automation, rule or import): ${few(scan.unused)}` });
  }
  const bare = (Array.isArray(cfg.automations) ? cfg.automations : [])
    .filter((a) => isObj(a) && a.enabled !== false && a.kind !== 'prompt' && typeof a.command === 'string' && BARE_PY_RE.test(a.command))
    .map((a) => a.name);
  if (bare.length) rows.push({ level: 'WARN', name: 'automation-bare-python', detail: `enabled job(s) start with a bare python (no Python on the job PATH before v0.6.0; the Store stub exits 49): ${few(bare)}. Fix: command: \${PY} ...` });
  if (cfg.harness && cfg.harness.modules && cfg.harness.modules.board) {
    const declared = Array.isArray(cfg.secrets) && cfg.secrets.map(String).includes('gh_token');
    rows.push(declared
      ? { level: 'PASS', name: 'board-token', detail: 'board poll gets GH_PROJECTS_TOKEN from the vault (gh_token)' }
      : { level: 'INFO', name: 'board-token', detail: 'board poll uses the host gh login (declare gh_token in secrets: to give it its own token)' });
  }
  return rows;
}

// ---- the inventory: everything a bot can use, by where it comes from ---------------
// The cockpit's Tools tab. Three sources, each with its licence:
//   harness  BotCorp harness (open source, MIT): modules, skills, agents, commands,
//            hooks, rules, and the harness tools every bot gets as shims
//   bot      this bot's own (private): its registry entries (bot.yaml tools:) and its
//            own .claude/{skills,agents,commands}
//   third    third-party: Claude Code plugins and MCP servers from the bot's settings,
//            .mcp.json and config home, each with its provider
// An item's `toggle` says how the engine switches it (null = it cannot):
//   {path, on, off}      a bot.yaml value (harness.modules.<m>, tools.<name>.enabled)
//   {list, item}         membership of a bot.yaml list turns it OFF (harness.disable,
//                        harness.hooks_disable)
// `locked` names why a switch is refused (vault-guard, operator-guard).
export const LICENSE = { harness: 'open source (BotCorp, MIT)', bot: 'proprietary / private', third: 'third-party' };
export const MODULE_TEXT = {
  telegram: 'The official Telegram plugin: the bot reads and answers its Telegram chat.',
  board: 'GitHub Projects board tools and the board poll (integrations.board).',
  cost_meter: 'One sessions.csv row per session: tokens and notional cost.',
  usage_resume: 'Relaunches the session after a usage-limit window if it died.',
  alert_triage: 'A headless fix-or-card pass over memory/metrics/alerts.log.',
  hub: 'Pushes status to a hub (integrations.hub).',
  janitor: 'Disk, transcript and stray-process hygiene on the daemon tick ("report" only scans).',
  lessons: 'Injects the harness lessons index at session start.',
  debrief: 'A headless session debrief on Stop (real spend).',
  auto_commit: 'Commits the bot folder on Stop; pushes with backup.git_remote.',
  memory_sync: 'Pushes memory/ to the bot\'s own remote on Stop.',
  sound: 'Plays a sound on Stop.',
  telemetry: 'OpenTelemetry export to the local sink (usage and subagent observability).',
  review_board: 'One private review Artifact the bot keeps adding to, linked in the cockpit header.',
  timeline_summary: 'An hourly daemon job that LLM-distils a timeline a hook left structural (real spend).',
  auto_roll: 'The daemon rolls a fresh session at a declared breakpoint once the context passes harness.roll_tokens.',
  session_summarize: 'A disk snapshot per turn in memory/sessions/<stamp>.md (the session-summarize Stop hook).',
  context_warn: 'One line in the prompt when the context passes 90% of harness.roll_tokens: finish the step, hand off, declare a breakpoint.',
};
const LOCKED_HOOKS = { 'vault-guard': 'keeps every session out of the vaults', 'operator-guard': 'keeps operator-only verbs away from bots' };
// Plugin marketplaces with a known owner; any other marketplace is named as it is.
const MARKETPLACES = { 'claude-plugins-official': 'Anthropic (official plugin directory)' };

const clip = (s, n = 180) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
function readSafe(file) { try { return fs.readFileSync(file, 'utf-8'); } catch { return ''; } }
function jsonSafe(file) { try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; } }
function listDir(dir, pred) { try { return fs.readdirSync(dir, { withFileTypes: true }).filter(pred).map((d) => d.name).sort(); } catch { return []; } }

// `key: value` from a leading `---` block (a folded `>` / `|` value takes the indented lines under it)
export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  const out = {};
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][-+]?$/.test(v)) { const more = []; while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) more.push(lines[++i].trim()); v = more.join(' '); }
    out[kv[1]] = v.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
// What a hook is for: the first comment line under a shell script's shebang, or
// the first paragraph of a Python script's docstring.
function scriptPurpose(text) {
  const doc = /^(?:#.*\r?\n)*\s*"""([\s\S]*?)"""/.exec(String(text || ''));
  if (doc) return clip(doc[1].trim().split(/\r?\n\s*\r?\n/)[0].replace(/^[\w.-]+\.py\s*[-—:]\s*/, ''), 160);
  const c = String(text || '').split(/\r?\n/).filter((l) => /^#(?!!)/.test(l)).map((l) => l.replace(/^#\s?/, '')).filter((l) => l.trim());
  return clip((c[0] || '').replace(/^[\w.-]+\.sh\s*[-—:]\s*/, ''), 160);
}
// The first `# ` heading of a markdown file.
function mdTitle(text) { const m = /^#\s+(.+)$/m.exec(String(text || '')); return m ? m[1].trim() : ''; }

// An MCP server's provider, from what it runs: the package an npx/uvx/bunx starts, the
// host of a URL, else the command.
export function mcpProvider(def) {
  if (!isObj(def)) return 'unknown';
  if (typeof def.url === 'string') { try { return new URL(def.url).host; } catch { return def.url; } }
  const cmd = String(def.command || '');
  const args = Array.isArray(def.args) ? def.args.map(String) : [];
  if (/(^|[\\/])(npx|uvx|bunx|pnpm|dlx)(\.cmd|\.exe)?$/i.test(cmd)) { const pkg = args.find((a) => !a.startsWith('-')); if (pkg) return pkg.replace(/@[^@/]+$/, ''); }
  // win32 splits on both separators, so a Windows command path reads the same on any host.
  return path.win32.basename(cmd) || 'unknown';
}

// `descriptions`: the operator's "All bots" text per harness item id
// (<BOTCORP_HOME>/global/descriptions.json, `botcorp knowledge describe`),
// shown over the shipped text; such an item carries `described: true`.
export function toolInventory({ botHome, cfg, botcorpRoot, scan = null, descriptions = {} }) {
  const H = path.join(botcorpRoot, 'harness');
  const home = botHome;
  const bot = cfg.name;
  const configHome = path.join(home, `.claude-${bot}`);
  const disabled = new Set((Array.isArray(cfg.harness.disable) ? cfg.harness.disable : []).map(String));
  const hooksOff = new Set((Array.isArray(cfg.harness.hooks_disable) ? cfg.harness.hooks_disable : []).map(String));
  const skillList = Array.isArray(cfg.harness.skills) ? new Set(cfg.harness.skills.map(String)) : null;
  const claudeMd = readSafe(path.join(home, 'CLAUDE.md')).replace(/\\/g, '/');
  const item = (source, kind, o) => ({ source, kind, license: LICENSE[source], toggle: null, locked: null, note: '', ...o });

  // ---- BotCorp harness
  const modules = Object.entries(cfg.harness.modules || {}).map(([m, v]) => item('harness', 'module', {
    id: `module:${m}`, name: m, description: MODULE_TEXT[m] || '', on: v === true || v === 'report',
    note: v === 'report' ? 'report only' : '', toggle: { path: `harness.modules.${m}`, on: true, off: false },
  }));
  const skills = listDir(path.join(H, 'skills'), (d) => d.isDirectory()).map((s) => {
    const fm = frontmatter(readSafe(path.join(H, 'skills', s, 'SKILL.md')));
    const listed = !skillList || skillList.has(s);
    return item('harness', 'skill', { id: `skill:${s}`, name: s, description: clip(fm.description), on: listed && !disabled.has(`skill:${s}`),
      toggle: listed ? { list: 'harness.disable', item: `skill:${s}` } : null, note: listed ? '' : 'left out of harness.skills' });
  });
  const agents = listDir(path.join(H, 'agents'), (d) => d.isFile() && d.name.endsWith('.md')).map((f) => {
    const a = f.slice(0, -3);
    const fm = frontmatter(readSafe(path.join(H, 'agents', f)));
    return item('harness', 'agent', { id: `agent:${a}`, name: a, description: clip(fm.description), model: fm.model || null, on: !disabled.has(`agent:${a}`),
      toggle: { list: 'harness.disable', item: `agent:${a}` } });
  });
  const commands = listDir(path.join(H, 'commands'), (d) => d.isFile() && d.name.endsWith('.md')).map((f) => item('harness', 'command', {
    id: `command:${f.slice(0, -3)}`, name: `/${f.slice(0, -3)}`, description: clip(frontmatter(readSafe(path.join(H, 'commands', f))).description), on: true,
  }));
  // The hooks are hooks.json's run.mjs names plus the tool guards: exactly the names
  // harness.hooks_disable takes. Each one's purpose comes from the script it runs.
  const hookScripts = new Map(GUARD_HOOKS.map((g) => [g, path.join(H, 'hooks', `${g}.sh`)]));
  const hooksJson = jsonSafe(path.join(H, 'hooks', 'hooks.json'));
  for (const groups of Object.values((hooksJson && hooksJson.hooks) || {})) for (const g of groups || []) for (const hk of (g && g.hooks) || []) {
    const a = Array.isArray(hk.args) ? hk.args.map(String) : [];
    if (!a[0] || !a[0].endsWith('/run.mjs') || !a[1] || hookScripts.has(a[1])) continue;
    hookScripts.set(a[1], a[3] === 'py.sh' && a[6] ? path.join(H, 'tools', a[6]) : path.join(H, 'hooks', a[3] || ''));
  }
  const hooks = [...hookScripts.keys()].sort().map((h) => {
    return item('harness', 'hook', { id: `hook:${h}`, name: h, description: scriptPurpose(readSafe(hookScripts.get(h))), on: !hooksOff.has(h),
      toggle: LOCKED_HOOKS[h] ? null : { list: 'harness.hooks_disable', item: h }, locked: LOCKED_HOOKS[h] ? `always on: it ${LOCKED_HOOKS[h]}` : null });
  });
  const rules = listDir(path.join(H, 'rules'), (d) => d.isFile() && d.name.endsWith('.md')).map((f) => {
    const on = claudeMd.includes(`harness/rules/${f}`);
    return item('harness', 'rule', { id: `rule:${f.slice(0, -3)}`, name: f.slice(0, -3), description: clip(mdTitle(readSafe(path.join(H, 'rules', f)))), on,
      note: on ? 'imported by CLAUDE.md' : 'not imported by CLAUDE.md' });
  });
  const shimmed = listDir(path.join(H, 'tools'), (d) => d.isDirectory() && !/^[_.]/.test(d.name)).map((dir) => {
    const files = listDir(path.join(H, 'tools', dir), (d) => d.isFile() && SHIM_EXTS_INV.includes(path.extname(d.name)) && !d.name.startsWith('_'));
    return item('harness', 'tool', { id: `tools:${dir}`, name: `tools/${dir}`, description: clip(`${files.length} tool${files.length === 1 ? '' : 's'}: ${files.join(', ')}`, 220), on: true, note: 'a shim in the bot folder runs the harness copy' });
  });

  // ---- this bot's own
  const missing = new Set(scan ? scan.missing : []);
  const registry = (Array.isArray(cfg.tools) ? cfg.tools : []).filter(isObj).map((t) => item('bot', 'tool', {
    id: `tool:${t.name}`, name: String(t.name), description: clip(t.purpose), path: String(t.path || ''), toolKind: String(t.kind || ''),
    secrets: Array.isArray(t.secrets) ? t.secrets.map(String) : [], on: t.enabled !== false, missing: missing.has(String(t.name)),
    toggle: { path: `tools.${t.name}.enabled`, on: true, off: false },
  }));
  const own = (sub, kind) => {
    const dir = path.join(home, '.claude', sub);
    const names = kind === 'skill' ? listDir(dir, (d) => d.isDirectory()) : listDir(dir, (d) => d.isFile() && d.name.endsWith('.md'));
    return names.map((n) => {
      const file = kind === 'skill' ? path.join(dir, n, 'SKILL.md') : path.join(dir, n);
      const id = kind === 'skill' ? n : n.slice(0, -3);
      return item('bot', kind, { id: `own-${kind}:${id}`, name: kind === 'command' ? `/${id}` : id, description: clip(frontmatter(readSafe(file)).description), on: true, note: `.claude/${sub}/` });
    });
  };

  // ---- third-party: plugins and MCP servers
  const plugins = new Map();   // key -> {enabled, where}
  const addPlugins = (file, where, when = null) => {
    const j = jsonSafe(file);
    for (const [k, v] of Object.entries(isObj(j && j.enabledPlugins) ? j.enabledPlugins : {})) {
      const cur = plugins.get(k) || { enabled: false, where: [] };
      // the Telegram enablement file is passed only while the module is on
      const on = v === true && (when === null || when);
      plugins.set(k, { enabled: cur.enabled || on, where: [...cur.where, where] });
    }
  };
  addPlugins(path.join(home, '.claude', 'settings.local.json'), '.claude/settings.local.json');
  addPlugins(path.join(home, '.claude', 'settings.json'), '.claude/settings.json');
  addPlugins(path.join(configHome, 'settings.json'), `.claude-${bot}/settings.json`);
  addPlugins(path.join(home, '.claude', 'tg-enable.settings.json'), 'passed at launch while harness.modules.telegram is on', !!(cfg.harness.modules && cfg.harness.modules.telegram));
  const installed = jsonSafe(path.join(configHome, 'plugins', 'installed_plugins.json'));
  for (const k of Object.keys(isObj(installed && installed.plugins) ? installed.plugins : {})) if (!plugins.has(k)) plugins.set(k, { enabled: false, where: ['installed, not enabled'] });
  const pluginItems = [...plugins].sort(([a], [b]) => a.localeCompare(b)).map(([k, p]) => {
    const [name, market = ''] = k.split('@');
    const ver = installed && isObj(installed.plugins) && Array.isArray(installed.plugins[k]) && installed.plugins[k][0] ? installed.plugins[k][0].version : null;
    return item('third', 'plugin', { id: `plugin:${k}`, name, provider: MARKETPLACES[market] || market || 'unknown', description: ver ? `version ${ver}` : '', on: p.enabled, note: [...new Set(p.where)].join(' · ') });
  });
  const mcp = new Map();
  const addMcp = (servers, where) => { for (const [k, def] of Object.entries(isObj(servers) ? servers : {})) if (!mcp.has(k)) mcp.set(k, { def, where }); };
  addMcp((jsonSafe(path.join(home, '.mcp.json')) || {}).mcpServers, '.mcp.json');
  const cj = jsonSafe(path.join(configHome, '.claude.json')) || {};
  addMcp(cj.mcpServers, `.claude-${bot}/.claude.json`);
  const proj = isObj(cj.projects) ? Object.entries(cj.projects).find(([p]) => path.resolve(p).toLowerCase() === path.resolve(home).toLowerCase()) : null;
  if (proj) addMcp(proj[1].mcpServers, `.claude-${bot}/.claude.json (this folder)`);
  const mcpItems = [...mcp].sort(([a], [b]) => a.localeCompare(b)).map(([k, { def, where }]) => item('third', 'mcp', {
    id: `mcp:${k}`, name: k, provider: mcpProvider(def), description: isObj(def) && def.type ? `${def.type} server` : '', on: !(isObj(def) && def.disabled === true), note: where,
  }));

  const section = (kind, label, items, extra = {}) => ({ kind, label, items, ...extra });
  const described = (items) => items.map((i) => (typeof descriptions[i.id] === 'string' && descriptions[i.id].trim() ? { ...i, description: clip(descriptions[i.id], 200), described: true } : i));
  return {
    bot,
    groups: [
      // every bot gets these: the harness BotCorp ships (the cockpit's "All bots")
      { source: 'harness', label: 'All bots', license: LICENSE.harness, sections: [
        section('module', 'Modules', described(modules)), section('skill', 'Skills', described(skills)), section('agent', 'Agents', described(agents)),
        section('hook', 'Hooks', described(hooks)), section('rule', 'Rules', described(rules)), section('command', 'Commands', described(commands)), section('tool', 'Tools', described(shimmed)),
      ] },
      { source: 'bot', label: 'This bot\'s own', license: LICENSE.bot, sections: [
        section('tool', 'Registered tools', registry, { registry: scan ? scan.registry : (cfg.tools == null ? 'off' : 'warn'), unregistered: scan ? scan.unregistered.length : null }),
        section('skill', 'Skills', own('skills', 'skill')), section('agent', 'Agents', own('agents', 'agent')), section('command', 'Commands', own('commands', 'command')),
      ] },
      { source: 'third', label: 'Third-party', license: LICENSE.third, sections: [section('plugin', 'Plugins', pluginItems), section('mcp', 'MCP servers', mcpItems)] },
    ],
  };
}
const SHIM_EXTS_INV = ['.py', '.sh', '.ps1'];

// Move files out of the bot folder into <rt>/retired/<bot>/<stamp>/<rel> and
// append one line to <rt>/retired/<bot>/retired.jsonl. -> the record.
export function retireFiles({ botHome, bot, runtime, rels, name = null, by = null, now = new Date() }) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const base = path.join(runtime, 'retired', bot);
  const dest = path.join(base, stamp);
  const home = path.resolve(botHome);
  for (const rel of rels) {
    const src = path.resolve(home, rel);
    if (!src.startsWith(home + path.sep)) throw new Error(`retire: ${rel} is outside the bot folder`);
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try { fs.renameSync(src, to); } catch { fs.copyFileSync(src, to); fs.rmSync(src); }
  }
  const record = { ts: now.toISOString(), bot, name, files: rels, dest: fwd(dest), by };
  fs.mkdirSync(base, { recursive: true });
  fs.appendFileSync(path.join(base, 'retired.jsonl'), JSON.stringify(record) + '\n');
  return record;
}
