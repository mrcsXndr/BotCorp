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
  const fix = `Fix: npm ci in ${root}`;
  let deps;
  try { deps = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')).dependencies || {}); }
  catch (e) { return { level: 'FAIL', missing: [], detail: `cannot read ${path.join(root, 'package.json')} (${e.code || e.message})` }; }
  const nm = path.join(root, 'node_modules');
  let entries = null;
  try { entries = fs.readdirSync(nm).filter((n) => !n.startsWith('.')); } catch {}
  const req = createRequire(path.join(root, 'package.json'));
  const missing = deps.filter((d) => { try { req.resolve(d); return false; } catch { return true; } });
  const what = entries === null ? `${nm} is missing` : !entries.length ? `${nm} is empty` : missing.length ? `${nm} is incomplete` : null;
  if (!what) return { level: 'PASS', missing, detail: `${deps.length} runtime dependencies resolve from ${nm}` };
  const cant = missing.length ? ` (cannot resolve: ${missing.join(', ')})` : '';
  const effect = missing.some((d) => CLI_DEPS.includes(d)) ? '; bot.yaml cannot be parsed, so the daemon skips every bot' : '';
  return { level: 'FAIL', missing, detail: `${what}${cant}${effect}. ${fix}` };
}
