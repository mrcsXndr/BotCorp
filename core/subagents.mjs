// subagents.mjs - the subagents and workflows a bot's live session runs, read
// from Claude Code's own files (the cockpit sidebar and agent screen).
//
// BEST-EFFORT, like cockpit/chat.mjs: these formats are internal to Claude Code.
// Every failure reads as "no agents", never as a wrong state. Observed on 2.1.285:
//   <session>/subagents/agent-<id>.meta.json   {agentType, description, toolUseId?,
//                                               spawnDepth, requestShape: background |
//                                               foreground, parentAgentId?, model?}
//   <session>/subagents/agent-<id>.jsonl       that agent's transcript, written per message
//   <session>/subagents/workflows/wf_<id>/     a workflow's agents (metas without a
//                                               toolUseId) and journal.jsonl: `started` /
//                                               `result` lines per agentId, written as it runs
//   <session>/workflows/wf_<id>.json           the workflow record {workflowName, status}
//                                               (seen written when it ended)
// An agent is finished when a completion for it is at least as new as its last
// write (a resumed agent writes again, so an older one no longer counts):
//   - a <task-notification> naming its id or tool-use id, in the main transcript or
//     its parent agent's (queued the moment it stops, as a queue-operation line);
//   - a foreground agent: the tool_result of its tool-use id;
//   - a workflow agent: a `result` line in the workflow journal;
//   - the harness SubagentStop hook line (state/<bot>/subagents.jsonl).
// Unfinished: `running`; `done?` when its transcript has been quiet 15 min and
// ends on an assistant end_turn; `ended` when the bot is not running.
// Files are read incrementally: a byte cursor per file lives in this process.

import fs from 'node:fs';
import path from 'node:path';

export const WINDOW_MS = 6 * 3600_000;
export const QUIET_MS = 15 * 60_000;
const SLACK_MS = 2000;
export const AGENT_ID_RE = /^[a-z0-9]{2,40}$/;

// ---- incremental line scanning ----------------------------------------------------
// file -> { pos, ino-ish size guard, state } ; scan(file, onLine) feeds only new complete lines
const cursors = new Map();
function scan(file, init, onLine) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  let c = cursors.get(file);
  if (!c || st.size < c.pos) { c = { pos: 0, state: init() }; cursors.set(file, c); }
  if (st.size === c.pos) return c.state;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const CHUNK = 4 << 20;
    const buf = Buffer.alloc(CHUNK);
    let carry = Buffer.alloc(0);
    let at = c.pos;
    while (at < st.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, st.size - at), at);
      if (n <= 0) break;
      at += n;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      const last = data.lastIndexOf(10);
      if (last < 0) { carry = Buffer.from(data); continue; }
      for (const line of data.subarray(0, last).toString('utf-8').split('\n')) if (line) onLine(line, c.state);
      carry = Buffer.from(data.subarray(last + 1));
    }
    c.pos = at - carry.length;
  } catch { /* keep what was read */ } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  return c.state;
}
export function resetCursors() { cursors.clear(); heads.clear(); tails.clear(); }

const tsOf = (obj) => { const t = Date.parse(obj && (obj.timestamp || obj.ts) || ''); return Number.isFinite(t) ? t : null; };
const tag = (s, name) => { const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(s); return m ? m[1].trim() : ''; };

// Completions in one transcript: task-notification ids (task id and tool-use id)
// and tool_result ids, each -> { at, status }.
function completionsOf(file) {
  return scan(file, () => ({ notified: new Map(), results: new Map() }), (line, s) => {
    const hasNote = line.includes('<task-notification>');
    const hasResult = line.includes('"tool_result"');
    if (!hasNote && !hasResult) return;
    let obj; try { obj = JSON.parse(line); } catch { return; }
    const at = tsOf(obj) ?? Date.now();
    if (hasNote) {
      const c = obj.message?.content;
      const text = typeof obj.content === 'string' ? obj.content : typeof c === 'string' ? c : JSON.stringify(c ?? '');
      for (const m of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
        const status = tag(m[1], 'status').toLowerCase() || 'completed';
        for (const id of [tag(m[1], 'task-id'), tag(m[1], 'tool-use-id')]) {
          if (id && !(s.notified.get(id)?.at >= at)) s.notified.set(id, { at, status });
        }
      }
    }
    if (hasResult && obj.type === 'user' && Array.isArray(obj.message?.content)) {
      for (const p of obj.message.content) if (p?.type === 'tool_result' && p.tool_use_id) s.results.set(p.tool_use_id, { at, status: p.is_error ? 'failed' : 'completed' });
    }
  }) || { notified: new Map(), results: new Map() };
}

// state/<bot>/subagents.jsonl stop lines: agent_id -> at
function hookStops(file) {
  return scan(file, () => new Map(), (line, s) => {
    if (!line.includes('"stop"')) return;
    let o; try { o = JSON.parse(line); } catch { return; }
    const at = tsOf(o);
    if (o.event === 'stop' && o.agent_id && at) s.set(String(o.agent_id), Math.max(at, s.get(String(o.agent_id)) || 0));
  }) || new Map();
}

// ---- one agent's transcript: model and start (head), progress and end (tail) --------
const heads = new Map();   // file -> { model, startedAt }
function headOf(file) {
  if (heads.has(file)) return heads.get(file);
  const r = { model: null, startedAt: null };
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(256 << 10);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const lines = buf.toString('utf-8', 0, n).split('\n').slice(0, -1);
      for (const line of lines) {
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (r.startedAt === null) r.startedAt = tsOf(o);
        if (o.type === 'assistant' && typeof o.message?.model === 'string' && !o.message.model.startsWith('<')) { r.model = o.message.model; break; }
      }
    } finally { fs.closeSync(fd); }
  } catch {}
  if (r.model) heads.set(file, r);
  return r;
}

const clip = (s, n = 80) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
function gist(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of ['description', 'command', 'file_path', 'pattern', 'path', 'url', 'query', 'prompt']) if (typeof input[k] === 'string' && input[k].trim()) return clip(input[k]);
  return '';
}
// The last assistant entry: what it is doing now, and whether it ended its turn.
// Re-read only when the file grew.
const tails = new Map();   // file -> { size, r }
export function tailOf(file, size) {
  const hit = tails.get(file);
  if (hit && hit.size === size) return hit.r;
  const r = { progress: '', endTurn: false };
  tails.set(file, { size, r });
  try {
    const len = Math.min(size, 128 << 10);
    const fd = fs.openSync(file, 'r');
    let text;
    try { const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, size - len); text = buf.toString('utf-8'); } finally { fs.closeSync(fd); }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let o; try { o = JSON.parse(lines[i]); } catch { continue; }
      if (o.type !== 'assistant' || !Array.isArray(o.message?.content)) continue;
      const parts = o.message.content;
      const tool = [...parts].reverse().find((p) => p?.type === 'tool_use');
      if (tool) r.progress = clip(`${tool.name}${gist(tool.input) ? ` ${gist(tool.input)}` : ''}`);
      else {
        const t = parts.filter((p) => p?.type === 'text').map((p) => p.text || '').join('\n').trim();
        r.progress = clip(t.split('\n').filter((l) => l.trim()).pop() || '');
      }
      r.endTurn = o.message.stop_reason === 'end_turn' && !tool;
      break;
    }
  } catch {}
  return r;
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; } }
function metasIn(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^agent-[a-z0-9]+\.meta\.json$/.test(n)); } catch {}
  return names.map((n) => ({ id: n.slice(6, -10), meta: readJson(path.join(dir, n)), file: path.join(dir, n.replace(/\.meta\.json$/, '.jsonl')) })).filter((x) => x.meta && typeof x.meta === 'object');
}

// Workflow journal: agentId -> result seen (at = the journal's mtime when it appeared)
function workflowJournal(file) {
  return scan(file, () => ({ started: new Map(), done: new Map() }), (line, s) => {
    let o; try { o = JSON.parse(line); } catch { return; }
    if (!o.agentId) return;
    if (o.type === 'started') s.started.set(o.agentId, { label: o.label || '', phase: o.phase || '' });
    if (o.type === 'result') s.done.set(o.agentId, Date.now());
  }) || { started: new Map(), done: new Map() };
}

// -> { session, agents: [...], workflows: [...] }
//   transcript: the bot's live transcript (cockpit/chat.mjs currentTranscript)
//   hookLog:    <rt>/state/<bot>/subagents.jsonl
//   alive:      is the bot's session running
/**
 * @param {{ transcript: string | null, hookLog?: string | null, alive?: boolean, now?: number }} opts
 * @returns {{ session: string | null, agents: any[], workflows: any[] }}
 */
export function listAgents({ transcript, hookLog = null, alive = true, now = Date.now() }) {
  const out = { session: null, agents: [], workflows: [] };
  if (!transcript) return out;
  const sessionDir = transcript.replace(/\.jsonl$/i, '');
  out.session = path.basename(sessionDir);
  const subDir = path.join(sessionDir, 'subagents');
  const main = completionsOf(transcript);
  const stops = hookLog ? hookStops(hookLog) : new Map();

  const found = metasIn(subDir).map((x) => ({ ...x, wf: null }));
  let wfDirs = [];
  try { wfDirs = fs.readdirSync(path.join(subDir, 'workflows')).filter((n) => /^wf_[A-Za-z0-9_-]+$/.test(n)); } catch {}
  const wfJournals = new Map();
  for (const w of wfDirs) {
    const dir = path.join(subDir, 'workflows', w);
    wfJournals.set(w, workflowJournal(path.join(dir, 'journal.jsonl')));
    for (const x of metasIn(dir)) found.push({ ...x, wf: w });
  }

  const byId = new Map();
  for (const x of found) {
    let st;
    try { st = fs.statSync(x.file); } catch { continue; }
    if (now - st.mtimeMs > WINDOW_MS) continue;
    const m = x.meta;
    const lastAt = st.mtimeMs;
    // the transcripts a completion for this agent may land in: the main one, and its parent agent's
    const parentFile = m.parentAgentId ? path.join(subDir, `agent-${m.parentAgentId}.jsonl`) : null;
    const sources = [main, ...(parentFile && fs.existsSync(parentFile) ? [completionsOf(parentFile)] : [])];
    let done = null;
    const consider = (c) => { if (c && c.at >= lastAt - SLACK_MS && (!done || c.at > done.at)) done = c; };
    for (const s of sources) {
      consider(s.notified.get(x.id));
      if (m.toolUseId) consider(s.notified.get(m.toolUseId));
      if (m.toolUseId && m.requestShape === 'foreground') consider(s.results.get(m.toolUseId));
    }
    const stopAt = stops.get(x.id);
    if (stopAt) consider({ at: stopAt, status: 'completed' });
    if (x.wf && wfJournals.get(x.wf)?.done.has(x.id)) consider({ at: lastAt, status: 'completed' });
    const head = headOf(x.file);
    const tail = tailOf(x.file, st.size);
    const state = done ? 'done' : !alive ? 'ended' : (now - lastAt > QUIET_MS && tail.endTurn) ? 'done?' : 'running';
    const row = {
      id: x.id, name: clip(m.description || m.name || m.agentType || x.id, 120), type: String(m.agentType || 'agent'),
      model: head.model || (typeof m.model === 'string' ? m.model : null), state, status: done ? done.status : null,
      startedAt: head.startedAt ? new Date(head.startedAt).toISOString() : null, lastAt: new Date(lastAt).toISOString(),
      progress: tail.progress, background: m.requestShape !== 'foreground', depth: Number(m.spawnDepth) || 0,
      parentId: m.parentAgentId || null, workflow: x.wf,
    };
    byId.set(x.id, row);
  }
  out.agents = [...byId.values()].sort((a, b) => String(b.startedAt || b.lastAt).localeCompare(String(a.startedAt || a.lastAt)));

  for (const w of wfDirs) {
    const agents = out.agents.filter((a) => a.workflow === w);
    if (!agents.length) continue;
    const rec = readJson(path.join(sessionDir, 'workflows', `${w}.json`)) || {};
    let name = typeof rec.workflowName === 'string' ? rec.workflowName : '';
    if (!name) {
      try { const s = fs.readdirSync(path.join(sessionDir, 'workflows', 'scripts')).find((n) => n.endsWith(`-${w}.js`)); if (s) name = s.slice(0, -(w.length + 4)); } catch {}
    }
    const status = typeof rec.status === 'string' ? rec.status : null;
    const running = !['completed', 'failed', 'cancelled', 'killed'].includes(status) && agents.some((a) => a.state === 'running');
    out.workflows.push({ id: w, name: name || w, status: status || (running ? 'running' : null), running, agents: agents.map((a) => a.id) });
  }
  return out;
}

// The transcript file of one agent of the session, or null.
export function agentFile(transcript, id) {
  if (!transcript || !AGENT_ID_RE.test(String(id || ''))) return null;
  const subDir = path.join(transcript.replace(/\.jsonl$/i, ''), 'subagents');
  const direct = path.join(subDir, `agent-${id}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  let wfs = [];
  try { wfs = fs.readdirSync(path.join(subDir, 'workflows')).filter((n) => /^wf_[A-Za-z0-9_-]+$/.test(n)); } catch {}
  for (const w of wfs) { const f = path.join(subDir, 'workflows', w, `agent-${id}.jsonl`); if (fs.existsSync(f)) return f; }
  return null;
}
