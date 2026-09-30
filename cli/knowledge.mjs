// knowledge.mjs - the docs a bot loads at session start, as files to list,
// read and write (`botcorp knowledge`; the cockpit's Knowledge tab).
//
//   "All bots" (global)  <BOTCORP_HOME>/global/knowledge/<slug>.md; sync copies each
//                        one to every bot's <config home>/rules/botcorp-global-<slug>.md,
//                        which Claude Code loads as user-level rules. Operator only.
//   one bot              its CLAUDE.md (id CLAUDE) and .claude/rules/<id>.md, the
//                        files Claude Code loads for the bot folder. The bot's own.
//
// Every write can carry the sha256 the writer read (`ifMatch`): a doc changed
// since is refused, so the cockpit and the bot never overwrite each other.
// Content is text of at most MAX_BYTES; a write never follows a path out of
// its folder (ids are plain names).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { globalKnowledgeDir, KNOWLEDGE_SLUG_RE } from '../daemon/sync.mjs';

export const MAX_BYTES = 64 * 1024;
export const BOT_DOC_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const MAIN_DOC = 'CLAUDE';
export { KNOWLEDGE_SLUG_RE };

export const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
// The token estimate the cockpit shows: characters / 4.
export const tokensOf = (text) => Math.ceil(String(text).length / 4);

export class KnowledgeError extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}

// The file an id names, or a KnowledgeError. `create`: a new doc's id must be a slug.
export function docFile({ scope, botHome = null }, id, { create = false } = {}) {
  if (scope === 'global') {
    if (!KNOWLEDGE_SLUG_RE.test(String(id || ''))) throw new KnowledgeError(`knowledge: a doc id is ${KNOWLEDGE_SLUG_RE} (got ${JSON.stringify(id)})`, 2);
    return path.join(globalKnowledgeDir(), `${id}.md`);
  }
  if (id === MAIN_DOC) return path.join(botHome, 'CLAUDE.md');
  const re = create ? KNOWLEDGE_SLUG_RE : BOT_DOC_RE;
  if (!re.test(String(id || ''))) throw new KnowledgeError(`knowledge: a doc id is ${MAIN_DOC} or ${re} (got ${JSON.stringify(id)})`, 2);
  return path.join(botHome, '.claude', 'rules', `${id}.md`);
}

function row(id, file) {
  const text = fs.readFileSync(file, 'utf-8');
  const st = fs.statSync(file);
  return { id, file: file.replace(/\\/g, '/'), bytes: Buffer.byteLength(text), tokens: tokensOf(text), sha256: sha256(text), updated_at: st.mtime.toISOString() };
}

// -> [{id, file, bytes, tokens, sha256, updated_at}], CLAUDE first for a bot.
export function listDocs({ scope, botHome = null }) {
  const out = [];
  if (scope === 'bot' && fs.existsSync(path.join(botHome, 'CLAUDE.md'))) out.push(row(MAIN_DOC, path.join(botHome, 'CLAUDE.md')));
  const dir = scope === 'global' ? globalKnowledgeDir() : path.join(botHome, '.claude', 'rules');
  const re = scope === 'global' ? KNOWLEDGE_SLUG_RE : BOT_DOC_RE;
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith('.md')).map((d) => d.name.slice(0, -3)).sort(); } catch {}
  for (const id of names) if (re.test(id) && !(scope === 'bot' && id === MAIN_DOC)) out.push(row(id, path.join(dir, `${id}.md`)));
  return out;
}

export function getDoc(where, id) {
  const file = docFile(where, id);
  if (!fs.existsSync(file)) throw new KnowledgeError(`knowledge: no doc '${id}'`, 1);
  return { ...row(id, file), content: fs.readFileSync(file, 'utf-8') };
}

function checkMatch(file, ifMatch) {
  if (!ifMatch) return;
  const cur = fs.existsSync(file) ? sha256(fs.readFileSync(file, 'utf-8')) : 'absent';
  if (cur !== ifMatch) throw new KnowledgeError(`knowledge: the doc changed since it was read (sha256 ${cur.slice(0, 12)}, expected ${String(ifMatch).slice(0, 12)}); read it again`, 4);
}

// -> {id, created, sha256, bytes}
export function setDoc(where, id, content, { ifMatch = null } = {}) {
  const text = String(content ?? '');
  if (Buffer.byteLength(text) > MAX_BYTES) throw new KnowledgeError(`knowledge: at most ${MAX_BYTES / 1024} KB (got ${Buffer.byteLength(text)} bytes)`, 2);
  if (text.includes('\0')) throw new KnowledgeError('knowledge: text only (the content has a NUL byte)', 2);
  let file = docFile(where, id);
  const created = !fs.existsSync(file);
  if (created) file = docFile(where, id, { create: true });
  checkMatch(file, ifMatch);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); } finally { fs.rmSync(tmp, { force: true }); }
  return { id, created, sha256: sha256(text), bytes: Buffer.byteLength(text) };
}

export function rmDoc(where, id, { ifMatch = null } = {}) {
  if (where.scope === 'bot' && id === MAIN_DOC) throw new KnowledgeError('knowledge: CLAUDE.md is the bot\'s main file; edit it, do not remove it', 2);
  const file = docFile(where, id);
  if (!fs.existsSync(file)) throw new KnowledgeError(`knowledge: no doc '${id}'`, 1);
  checkMatch(file, ifMatch);
  fs.rmSync(file);
  return { id, removed: true };
}

// ---- "All bots" descriptions: <BOTCORP_HOME>/global/descriptions.json ----------
// {"skill:x": "text"} over the shipped text of a harness item in the Tools tab
// (cli/tools.mjs toolInventory). No repo file is edited. '' removes an entry.
export const ITEM_ID_RE = /^(module|skill|agent|hook|rule|command|tools):[a-z0-9][a-z0-9_-]{0,63}$/;
export function descriptionsFile() { return path.join(path.dirname(globalKnowledgeDir()), 'descriptions.json'); }
export function readDescriptions() {
  try { const j = JSON.parse(fs.readFileSync(descriptionsFile(), 'utf-8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { return {}; }
}
export function describeItem(id, text, max) {
  if (!ITEM_ID_RE.test(String(id || ''))) throw new KnowledgeError(`knowledge describe: an item id like skill:<name> or module:<name> (got ${JSON.stringify(id)})`, 2);
  const t = String(text ?? '').trim();
  if (t.length > max || /[\r\n]/.test(t)) throw new KnowledgeError(`knowledge describe: one line, at most ${max} characters`, 2);
  const cur = readDescriptions();
  if (t) cur[id] = t; else delete cur[id];
  const file = descriptionsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(cur, null, 2) + '\n'); fs.renameSync(tmp, file); } finally { fs.rmSync(tmp, { force: true }); }
  return { id, description: t || null };
}
