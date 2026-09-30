// core/subagents.mjs over a fixture session laid out like Claude Code 2.1.285
// writes it: which agents run, which finished, and what each is doing.
// Run: node --test core/tests/subagents.test.mjs

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listAgents, agentFile, resetCursors } from '../subagents.mjs';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;

function write(file, lines, mtimeAgo) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const t = (NOW - mtimeAgo) / 1000;
  fs.utimesSync(file, t, t);
}
const assistant = (msAgo, content, stop = 'tool_use', model = 'claude-sonnet-5-5') => ({ type: 'assistant', timestamp: iso(msAgo), message: { model, stop_reason: stop, content } });
const prompt = (msAgo) => ({ type: 'user', timestamp: iso(msAgo), message: { content: 'do the thing' } });
const note = (msAgo, taskId, toolUseId) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(msAgo),
  content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n</task-notification>` });

let T, SUB, MAIN, HOOK;
function agent(id, meta, lines, mtimeAgo, dir = SUB) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `agent-${id}.meta.json`), JSON.stringify({ spawnDepth: 1, requestShape: 'background', ...meta }));
  write(path.join(dir, `agent-${id}.jsonl`), lines, mtimeAgo);
}

beforeEach(() => {
  resetCursors();
  T = fs.mkdtempSync(path.join(os.tmpdir(), 'subagents-test-'));
  MAIN = path.join(T, 'sess-1.jsonl');
  SUB = path.join(T, 'sess-1', 'subagents');
  HOOK = path.join(T, 'subagents.jsonl');
  // a: background, notified -> done; b: background, no notification -> running
  agent('a1', { agentType: 'coder', description: 'Finish A', toolUseId: 'toolu_A' }, [prompt(30 * MIN), assistant(20 * MIN, [{ type: 'text', text: 'all done' }], 'end_turn')], 20 * MIN);
  agent('b2', { agentType: 'coder', description: 'Still B', toolUseId: 'toolu_B' },
    [prompt(10 * MIN), assistant(MIN, [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }])], MIN);
  // c: foreground, its tool_result in the main transcript -> done
  agent('c3', { agentType: 'Explore', description: 'Sync C', toolUseId: 'toolu_C', requestShape: 'foreground' }, [prompt(9 * MIN), assistant(8 * MIN, [{ type: 'text', text: 'found it' }], 'end_turn')], 8 * MIN);
  // d: no completion, quiet 30 min on an end_turn -> done?
  agent('d4', { agentType: 'coder', description: 'Quiet D', toolUseId: 'toolu_D' }, [prompt(40 * MIN), assistant(30 * MIN, [{ type: 'text', text: 'Report:\nnothing left' }], 'end_turn')], 30 * MIN);
  // e: closed by the SubagentStop hook line only
  agent('e5', { agentType: 'coder', description: 'Hook E', toolUseId: 'toolu_E' }, [prompt(5 * MIN), assistant(4 * MIN, [{ type: 'text', text: 'ok' }], 'end_turn')], 4 * MIN);
  // f: notified, then resumed (wrote again after the notification) -> running
  agent('f6', { agentType: 'coder', description: 'Resumed F', toolUseId: 'toolu_F' }, [prompt(20 * MIN), assistant(2 * MIN, [{ type: 'tool_use', name: 'Read', input: { file_path: 'C:/x/y.md' } }])], 2 * MIN);
  // g: older than the 6 h window -> not listed
  agent('g7', { agentType: 'coder', description: 'Old G', toolUseId: 'toolu_G' }, [prompt(8 * 60 * MIN)], 7 * 60 * MIN);
  // a workflow: w1 has its result line, w2 only started
  const WF = path.join(SUB, 'workflows', 'wf_abc-123');
  agent('w1a', { agentType: 'workflow-subagent', description: 'review:one', requestShape: 'foreground', model: 'sonnet' }, [prompt(10 * MIN), assistant(6 * MIN, [{ type: 'text', text: 'r1' }], 'end_turn')], 6 * MIN, WF);
  agent('w2b', { agentType: 'workflow-subagent', description: 'review:two', requestShape: 'foreground', model: 'sonnet' }, [prompt(10 * MIN), assistant(MIN, [{ type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } }])], MIN, WF);
  write(path.join(WF, 'journal.jsonl'), [{ type: 'launched' }, { type: 'started', agentId: 'w1a', label: 'review:one' }, { type: 'started', agentId: 'w2b', label: 'review:two' }, { type: 'result', agentId: 'w1a', result: 'x' }], MIN);
  fs.mkdirSync(path.join(T, 'sess-1', 'workflows', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(T, 'sess-1', 'workflows', 'scripts', 'code-review-wf_abc-123.js'), '');
  write(MAIN, [
    prompt(60 * MIN),
    note(19 * MIN, 'a1', 'toolu_A'),
    note(10 * MIN, 'f6', 'toolu_F'),
    { type: 'user', timestamp: iso(7 * MIN), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_C', content: 'found it' }] } },
    // a background agent's own launch result is no completion
    { type: 'user', timestamp: iso(10 * MIN), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_B', content: 'Async agent launched' }] } },
  ], MIN);
  write(HOOK, [{ ts: iso(3 * MIN).replace(/\.\d{3}Z$/, 'Z'), event: 'stop', agent_id: 'e5' }], 3 * MIN);
});

const byId = (r) => Object.fromEntries(r.agents.map((a) => [a.id, a]));

test('running, finished, done? and resumed agents', () => {
  const a = byId(listAgents({ transcript: MAIN, hookLog: HOOK, alive: true, now: NOW }));
  assert.equal(a.a1.state, 'done');
  assert.equal(a.a1.status, 'completed');
  assert.equal(a.b2.state, 'running');
  assert.equal(a.c3.state, 'done');
  assert.equal(a.d4.state, 'done?');
  assert.equal(a.e5.state, 'done');
  assert.equal(a.f6.state, 'running');
  assert.ok(!('g7' in a));
});

test('an agent row: name, type, model, progress, start', () => {
  const b = byId(listAgents({ transcript: MAIN, hookLog: HOOK, alive: true, now: NOW })).b2;
  assert.equal(b.name, 'Still B');
  assert.equal(b.type, 'coder');
  assert.equal(b.model, 'claude-sonnet-5-5');
  assert.equal(b.progress, 'Bash npm test');
  assert.equal(b.startedAt, iso(10 * MIN));
  assert.equal(b.background, true);
});

test('a workflow groups its agents; a result line finishes one', () => {
  const r = listAgents({ transcript: MAIN, hookLog: HOOK, alive: true, now: NOW });
  const a = byId(r);
  assert.equal(a.w1a.state, 'done');
  assert.equal(a.w2b.state, 'running');
  assert.equal(a.w2b.progress, 'Grep TODO');
  assert.deepEqual(r.workflows.map((w) => ({ ...w, agents: [...w.agents].sort() })), [{ id: 'wf_abc-123', name: 'code-review', status: 'running', running: true, agents: ['w1a', 'w2b'] }]);
});

test('the bot not running: nothing unfinished reads as running', () => {
  const a = byId(listAgents({ transcript: MAIN, hookLog: HOOK, alive: false, now: NOW }));
  assert.equal(a.b2.state, 'ended');
  assert.equal(a.a1.state, 'done');
});

test('an appended notification is picked up incrementally', () => {
  assert.equal(byId(listAgents({ transcript: MAIN, alive: true, now: NOW })).b2.state, 'running');
  fs.appendFileSync(MAIN, JSON.stringify(note(0, 'b2', 'toolu_B')) + '\n');
  assert.equal(byId(listAgents({ transcript: MAIN, alive: true, now: NOW })).b2.state, 'done');
});

test('no transcript, no agents; agentFile finds workflow agents and refuses odd ids', () => {
  assert.deepEqual(listAgents({ transcript: null }).agents, []);
  assert.equal(agentFile(MAIN, 'w2b'), path.join(SUB, 'workflows', 'wf_abc-123', 'agent-w2b.jsonl'));
  assert.equal(agentFile(MAIN, 'b2'), path.join(SUB, 'agent-b2.jsonl'));
  assert.equal(agentFile(MAIN, '../x'), null);
  assert.equal(agentFile(MAIN, 'zzzzzz'), null);
});
