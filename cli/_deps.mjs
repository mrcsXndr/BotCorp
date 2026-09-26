// _deps.mjs - doctor `node_modules`: can this checkout load its runtime
// dependencies? Node builtins only, because botcorp.mjs runs it BEFORE it
// imports anything that needs node_modules (the bot.yaml parser needs js-yaml),
// so a wiped node_modules gets the fix line instead of an ERR_MODULE_NOT_FOUND
// stack. The daemon reads every bot.yaml through that same parser, so this is
// also why it logs "bot.yaml unreadable" for every bot.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// What cli/botcorp.mjs itself imports at load (through _lib.mjs and botyaml.mjs).
export const CLI_DEPS = ['js-yaml'];

// root = the checkout (the folder with package.json). Every `dependencies` entry
// must resolve the way the runtime resolves it (require.resolve from the root).
export function depsVerdict(root) {
  let fix = `Fix: npm ci in ${root}`;
  let deps;
  try { deps = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')).dependencies || {}); }
  catch (e) { return { level: 'FAIL', missing: [], detail: `cannot read ${path.join(root, 'package.json')} (${e.code || e.message})` }; }
  const nm = path.join(root, 'node_modules');
  let entries = null;
  try { entries = fs.readdirSync(nm).filter((n) => !n.startsWith('.')); } catch {}
  // a junction/symlink whose target is gone: remove only the link, then install
  let link = null;
  if (entries === null) { try { if (fs.lstatSync(nm).isSymbolicLink()) link = fs.readlinkSync(nm); } catch {} }
  if (link) fix = `Fix: cmd /c rmdir "${nm}" (removes only the link), then npm ci in ${root}`;
  const req = createRequire(path.join(root, 'package.json'));
  const missing = deps.filter((d) => { try { req.resolve(d); return false; } catch { return true; } });
  const what = link ? `${nm} is a link to ${link}, which is missing` : entries === null ? `${nm} is missing` : !entries.length ? `${nm} is empty` : missing.length ? `${nm} is incomplete` : null;
  if (!what) return { level: 'PASS', missing, detail: `${deps.length} runtime dependencies resolve from ${nm}` };
  const cant = missing.length ? ` (cannot resolve: ${missing.join(', ')})` : '';
  const effect = missing.some((d) => CLI_DEPS.includes(d)) ? '; bot.yaml cannot be parsed, so the daemon skips every bot' : '';
  return { level: 'FAIL', missing, detail: `${what}${cant}${effect}. ${fix}` };
}

// porcelain = `git worktree list --porcelain` of the checkout; its first entry is
// the main (live) worktree. A worktree whose node_modules is a junction/symlink
// into the live node_modules shares it, and a `git worktree remove` through that
// link once emptied the live checkout's node_modules.
export function worktreeLinksVerdict(porcelain) {
  const trees = String(porcelain || '').split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => path.resolve(l.slice(9)));
  if (!trees.length) return { level: 'INFO', detail: 'not a git checkout (no worktrees listed)' };
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const liveNm = norm(path.join(trees[0], 'node_modules'));
  const bad = [];
  for (const wt of trees.slice(1)) {
    const nm = path.join(wt, 'node_modules');
    let target;
    try { if (!fs.lstatSync(nm).isSymbolicLink()) continue; target = path.resolve(wt, fs.readlinkSync(nm)); } catch { continue; }
    const t = norm(target);
    if (t === liveNm || t.startsWith(liveNm + path.sep)) bad.push(`${nm} -> ${target}`);
  }
  if (!bad.length) return { level: 'PASS', detail: `${trees.length - 1} other worktree(s), none links into ${path.join(trees[0], 'node_modules')}` };
  return { level: 'FAIL', detail: `${bad.join('; ')} links into the live node_modules (a worktree remove through it empties the live checkout). Fix: cmd /c rmdir "<worktree>\\node_modules" (removes only the link), then npm ci in that worktree` };
}
