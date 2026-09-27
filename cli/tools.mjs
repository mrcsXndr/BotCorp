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
