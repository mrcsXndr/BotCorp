#!/usr/bin/env node
// otel-sink.mjs — loopback-only OTLP/HTTP-JSON receiver for Claude Code
// telemetry. Part of the daemon's long-lived process set (one sink for the
// whole machine, alongside the per-bot pty-hosts).
//
// launch.ps1 points every telemetry-enabled bot's CC process at this sink
// (OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:<port>, protocol http/json;
// prompts/tool details are never exported — CC only sends them when the
// OTEL_LOG_* content gates are set, which nothing here sets). Events route
// by the `bot.name` resource attribute into one SQLite DB per bot, because
// the harness checkout (and this sink) is shared machine-wide but each bot's
// telemetry is its own private state.
//
//   node daemon/otel-sink.mjs [--port 4318] [--dry-run]
//
// --dry-run parses and prints every record instead of writing to disk (no
// otel.json, no telemetry.db) — used to eyeball a payload shape without
// touching state.
//
// Endpoints: POST /v1/logs, /v1/metrics (stored), /v1/traces (accepted,
// ignored — CC does not need trace ingestion for cost/subagent accounting),
// GET /healthz. Body cap 4 MB -> 413. On start writes
// <BOTCORP_HOME>/state/otel.json {pid, port, startedAt}; removed on exit.
//
// No dependency beyond node core + node:sqlite (built into Node >= 22.5 /
// stable-ish in 25; ships an ExperimentalWarning on import — harmless).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ARGV = process.argv.slice(2);
const DRY_RUN = ARGV.includes('--dry-run');
const PORT_ARG_IDX = ARGV.indexOf('--port');
const REQUESTED_PORT = PORT_ARG_IDX !== -1 && ARGV[PORT_ARG_IDX + 1] ? Number(ARGV[PORT_ARG_IDX + 1]) || 4318 : 4318;

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const RETENTION_EVENTS_DAYS = 30;
const RETENTION_ROLLUP_DAYS = 400;
const MAX_DB_BYTES = 200 * 1024 * 1024;
const RETENTION_INTERVAL_MS = 10 * 60 * 1000;

// Event names that carry per-request cost/token data and feed rollup_hourly.
const API_REQUEST_NAMES = new Set(['api_request', 'claude_code.api_request']);

// Never persist prompt/response/tool-argument content even if a future CC
// version starts sending it — this is a belt-and-braces drop on top of the
// OTEL_LOG_* gates never being set.
const DROP_KEY_SUBSTR = ['prompt', 'content', 'input.', 'tool_input', 'arguments'];

// Typed columns accept any of these attribute spellings (Claude Code's OTel
// attribute names are not pinned by docs — see docs/observability.md).
const FIELD_ALIASES = {
  session_id: ['session.id', 'session_id'],
  agent_id: ['agent_id', 'agent.id'],
  parent_agent_id: ['parent_agent_id', 'parent.agent_id'],
  query_source: ['query_source'],
  agent_name: ['agent.name', 'agent_name'],
  model: ['model'],
  input_tok: ['input_tokens', 'input_tok'],
  output_tok: ['output_tokens'],
  cache_read_tok: ['cache_read_tokens', 'cache_read_input_tokens'],
  cache_creation_tok: ['cache_creation_tokens', 'cache_creation_input_tokens'],
  cost_usd: ['cost_usd', 'cost'],
  duration_ms: ['duration_ms'],
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  ts REAL,
  name TEXT,
  session_id TEXT,
  agent_id TEXT,
  parent_agent_id TEXT,
  query_source TEXT,
  agent_name TEXT,
  model TEXT,
  input_tok INTEGER,
  output_tok INTEGER,
  cache_read_tok INTEGER,
  cache_creation_tok INTEGER,
  cost_usd REAL,
  duration_ms REAL,
  attrs_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, name);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY,
  ts REAL,
  name TEXT,
  value REAL,
  attrs_json TEXT
);

CREATE TABLE IF NOT EXISTS rollup_hourly (
  hour TEXT,
  session_id TEXT,
  agent_type TEXT,
  model TEXT,
  n_requests INTEGER,
  in_tok INTEGER,
  out_tok INTEGER,
  cache_tok INTEGER,
  usd REAL,
  PRIMARY KEY (hour, session_id, agent_type, model)
);
`;

function runtimeRoot() {
  return process.env.BOTCORP_HOME || path.join(os.homedir(), '.botcorp');
}

function statePath() {
  return path.join(runtimeRoot(), 'state', 'otel.json');
}

function writeStateFile(port) {
  try {
    const dir = path.join(runtimeRoot(), 'state');
    fs.mkdirSync(dir, { recursive: true });
    const tmp = statePath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }));
    fs.renameSync(tmp, statePath());
  } catch (e) {
    process.stderr.write(`[otel-sink] could not write state file: ${e.message}\n`);
  }
}

function removeStateFile() {
  try { fs.unlinkSync(statePath()); } catch {}
}

// ---- per-bot sqlite ---------------------------------------------------------

const dbCache = new Map(); // botName -> { db, path, stmts }

function openDb(botName) {
  const dir = path.join(runtimeRoot(), 'state', botName);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'telemetry.db');
  const db = new DatabaseSync(dbPath);
  try { db.exec('PRAGMA journal_mode=WAL'); } catch {}
  try { db.exec('PRAGMA auto_vacuum=INCREMENTAL'); } catch {}
  db.exec(SCHEMA_SQL);
  const stmts = {
    insertEvent: db.prepare(`INSERT INTO events
      (ts, name, session_id, agent_id, parent_agent_id, query_source, agent_name, model,
       input_tok, output_tok, cache_read_tok, cache_creation_tok, cost_usd, duration_ms, attrs_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    insertMetric: db.prepare('INSERT INTO metrics (ts, name, value, attrs_json) VALUES (?,?,?,?)'),
    selectRollup: db.prepare('SELECT n_requests, in_tok, out_tok, cache_tok, usd FROM rollup_hourly WHERE hour=? AND session_id=? AND agent_type=? AND model=?'),
    updateRollup: db.prepare('UPDATE rollup_hourly SET n_requests=?, in_tok=?, out_tok=?, cache_tok=?, usd=? WHERE hour=? AND session_id=? AND agent_type=? AND model=?'),
    insertRollup: db.prepare('INSERT INTO rollup_hourly (hour, session_id, agent_type, model, n_requests, in_tok, out_tok, cache_tok, usd) VALUES (?,?,?,?,?,?,?,?,?)'),
    deleteOldEvents: db.prepare('DELETE FROM events WHERE ts < ?'),
    deleteOldRollup: db.prepare('DELETE FROM rollup_hourly WHERE hour < ?'),
    deleteOldestEvents: db.prepare('DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY id ASC LIMIT 10000)'),
  };
  return { db, path: dbPath, stmts };
}

function getDb(botName) {
  const name = botName || '_unknown';
  if (dbCache.has(name)) return dbCache.get(name);
  const entry = openDb(name);
  dbCache.set(name, entry);
  return entry;
}

function scanExistingBots() {
  try {
    const dir = path.join(runtimeRoot(), 'state');
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      try {
        if (fs.existsSync(path.join(dir, name, 'telemetry.db'))) getDb(name);
      } catch {}
    }
  } catch {}
}

function runRetention(botName, entry) {
  try {
    const cutoffTs = Date.now() / 1000 - RETENTION_EVENTS_DAYS * 86400;
    const dropped = entry.stmts.deleteOldEvents.run(cutoffTs);
    const cutoffHour = new Date(Date.now() - RETENTION_ROLLUP_DAYS * 86400 * 1000).toISOString().slice(0, 13);
    entry.stmts.deleteOldRollup.run(cutoffHour);
    if (dropped.changes) {
      process.stderr.write(`[otel-sink] ${botName}: retention dropped ${dropped.changes} events older than ${RETENTION_EVENTS_DAYS}d\n`);
    }
    let size = fs.existsSync(entry.path) ? fs.statSync(entry.path).size : 0;
    let trimmed = 0;
    while (size > MAX_DB_BYTES) {
      const r = entry.stmts.deleteOldestEvents.run();
      if (!r.changes) break;
      trimmed += r.changes;
      try { entry.db.exec('PRAGMA incremental_vacuum'); } catch {}
      size = fs.statSync(entry.path).size;
    }
    if (trimmed) {
      process.stderr.write(`[otel-sink] ${botName}: size cap hit, dropped ${trimmed} oldest events (now ${(size / 1e6).toFixed(1)}MB)\n`);
    }
  } catch (e) {
    process.stderr.write(`[otel-sink] ${botName}: retention error: ${e.message}\n`);
  }
}

function runRetentionAll() {
  for (const [name, entry] of dbCache) runRetention(name, entry);
}

// ---- OTLP JSON parsing -------------------------------------------------------

function attrsToObject(attrList) {
  const obj = {};
  for (const a of attrList || []) {
    if (!a || !a.key) continue;
    const v = a.value || {};
    let val;
    if ('stringValue' in v) val = v.stringValue;
    else if ('intValue' in v) val = Number(v.intValue);
    else if ('doubleValue' in v) val = v.doubleValue;
    else if ('boolValue' in v) val = v.boolValue;
    if (val !== undefined) obj[a.key] = val;
  }
  return obj;
}

function dropSensitive(bag) {
  const out = {};
  for (const [k, v] of Object.entries(bag)) {
    const lk = k.toLowerCase();
    if (DROP_KEY_SUBSTR.some((s) => lk.includes(s))) continue;
    out[k] = v;
  }
  return out;
}

function nanoToSeconds(nano) {
  if (nano === undefined || nano === null || nano === '') return Date.now() / 1000;
  try { return Number(BigInt(nano)) / 1e9; } catch {}
  const n = Number(nano);
  return Number.isFinite(n) ? n / 1e9 : Date.now() / 1000;
}

function pickStr(bag, keys) {
  for (const k of keys) { if (bag[k] !== undefined && bag[k] !== null && bag[k] !== '') return String(bag[k]); }
  return null;
}

function pickNum(bag, keys) {
  for (const k of keys) {
    if (bag[k] !== undefined && bag[k] !== null) {
      const n = Number(bag[k]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function resourceBotName(resource) {
  const attrs = attrsToObject(resource && resource.attributes);
  return attrs['bot.name'] || '_unknown';
}

function buildEventRow(ts, name, bag) {
  return {
    ts,
    name,
    session_id: pickStr(bag, FIELD_ALIASES.session_id),
    agent_id: pickStr(bag, FIELD_ALIASES.agent_id),
    parent_agent_id: pickStr(bag, FIELD_ALIASES.parent_agent_id),
    query_source: pickStr(bag, FIELD_ALIASES.query_source),
    agent_name: pickStr(bag, FIELD_ALIASES.agent_name),
    model: pickStr(bag, FIELD_ALIASES.model),
    input_tok: pickNum(bag, FIELD_ALIASES.input_tok),
    output_tok: pickNum(bag, FIELD_ALIASES.output_tok),
    cache_read_tok: pickNum(bag, FIELD_ALIASES.cache_read_tok),
    cache_creation_tok: pickNum(bag, FIELD_ALIASES.cache_creation_tok),
    cost_usd: pickNum(bag, FIELD_ALIASES.cost_usd),
    duration_ms: pickNum(bag, FIELD_ALIASES.duration_ms),
    attrs_json: JSON.stringify(bag),
  };
}

function updateRollup(entry, row) {
  if (!row.session_id || !API_REQUEST_NAMES.has(row.name)) return;
  const hour = new Date(row.ts * 1000).toISOString().slice(0, 13);
  const agentType = row.query_source || 'main';
  const model = row.model || '';
  const inTok = row.input_tok || 0;
  const outTok = row.output_tok || 0;
  const cacheTok = (row.cache_read_tok || 0) + (row.cache_creation_tok || 0);
  const usd = row.cost_usd || 0;
  const existing = entry.stmts.selectRollup.get(hour, row.session_id, agentType, model);
  if (existing) {
    entry.stmts.updateRollup.run(
      existing.n_requests + 1, existing.in_tok + inTok, existing.out_tok + outTok,
      existing.cache_tok + cacheTok, existing.usd + usd,
      hour, row.session_id, agentType, model,
    );
  } else {
    entry.stmts.insertRollup.run(hour, row.session_id, agentType, model, 1, inTok, outTok, cacheTok, usd);
  }
}

function insertEvent(botName, row) {
  const entry = getDb(botName);
  entry.stmts.insertEvent.run(
    row.ts, row.name, row.session_id, row.agent_id, row.parent_agent_id, row.query_source,
    row.agent_name, row.model, row.input_tok, row.output_tok, row.cache_read_tok,
    row.cache_creation_tok, row.cost_usd, row.duration_ms, row.attrs_json,
  );
  updateRollup(entry, row);
}

function insertMetric(botName, ts, name, value, attrsJson) {
  const entry = getDb(botName);
  entry.stmts.insertMetric.run(ts, name, value, attrsJson);
}

function handleLogs(payload) {
  for (const rl of payload.resourceLogs || []) {
    const botName = resourceBotName(rl.resource);
    const resourceAttrs = attrsToObject(rl.resource && rl.resource.attributes);
    for (const sl of rl.scopeLogs || []) {
      for (const rec of sl.logRecords || []) {
        const recAttrs = attrsToObject(rec.attributes);
        const bag = dropSensitive({ ...resourceAttrs, ...recAttrs });
        const name = rec.eventName || (rec.body && rec.body.stringValue) || 'unknown';
        const ts = nanoToSeconds(rec.timeUnixNano);
        const row = buildEventRow(ts, name, bag);
        if (DRY_RUN) { console.log(JSON.stringify({ bot: botName, table: 'events', row })); continue; }
        insertEvent(botName, row);
      }
    }
  }
}

function handleMetrics(payload) {
  for (const rm of payload.resourceMetrics || []) {
    const botName = resourceBotName(rm.resource);
    for (const sm of rm.scopeMetrics || []) {
      for (const metric of sm.metrics || []) {
        const name = metric.name || 'unknown';
        const dps = (metric.sum && metric.sum.dataPoints) || (metric.gauge && metric.gauge.dataPoints) || [];
        for (const dp of dps) {
          const attrs = dropSensitive(attrsToObject(dp.attributes));
          const ts = nanoToSeconds(dp.timeUnixNano);
          const value = dp.asInt !== undefined ? Number(dp.asInt) : (dp.asDouble !== undefined ? dp.asDouble : null);
          if (DRY_RUN) { console.log(JSON.stringify({ bot: botName, table: 'metrics', row: { ts, name, value, attrs } })); continue; }
          insertMetric(botName, ts, name, value, JSON.stringify(attrs));
        }
      }
    }
  }
}

// ---- HTTP server --------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len && len > MAX_BODY_BYTES) { reject({ status: 413 }); return; }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject({ status: 413 }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (e) => reject({ status: 400, err: e }));
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && u.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, bots: Array.from(dbCache.keys()) }));
      return;
    }
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }

    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      res.writeHead(e.status || 400);
      res.end();
      return;
    }

    if (u.pathname === '/v1/traces') {
      // Accepted and ignored — no trace ingestion needed for cost/subagent accounting.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    if (u.pathname !== '/v1/logs' && u.pathname !== '/v1/metrics') {
      res.writeHead(404);
      res.end();
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body || '{}');
    } catch (e) {
      res.writeHead(400);
      res.end();
      return;
    }

    if (u.pathname === '/v1/logs') handleLogs(payload);
    else handleMetrics(payload);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  } catch (e) {
    process.stderr.write(`[otel-sink] request error: ${e.stack || e.message}\n`);
    try { res.writeHead(500); res.end(); } catch {}
  }
});

let retentionTimer = null;

function onListening(actualPort) {
  process.stderr.write(`[otel-sink] listening on 127.0.0.1:${actualPort}${DRY_RUN ? ' (dry-run)' : ''}\n`);
  if (!DRY_RUN) {
    writeStateFile(actualPort);
    scanExistingBots();
    runRetentionAll();
    retentionTimer = setInterval(runRetentionAll, RETENTION_INTERVAL_MS);
    retentionTimer.unref();
  }
}

function start(port, isRetry) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && !isRetry) {
      process.stderr.write(`[otel-sink] port ${port} busy, falling back to an ephemeral port\n`);
      start(0, true);
    } else {
      process.stderr.write(`[otel-sink] listen error: ${e.message}\n`);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => onListening(server.address().port));
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (retentionTimer) clearInterval(retentionTimer);
  if (!DRY_RUN) removeStateFile();
  try { for (const [, entry] of dbCache) entry.db.close(); } catch {}
  try {
    server.close(() => process.exit(0));
  } catch { process.exit(0); }
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Windows has no real SIGTERM delivery to an unattached process; a graceful
// `taskkill /PID <pid>` (no /F) instead sends a console-close request that
// libuv surfaces as 'SIGHUP' — handle it the same way so a normal stop still
// cleans up otel.json. A hard `taskkill /F` bypasses all of this (OS-level
// TerminateProcess, same as SIGKILL) — the 'exit' listener below cannot run
// in that case on any platform; that's a Windows/Node process-model
// constraint, not something a handler can work around.
process.on('SIGHUP', shutdown);
process.on('exit', () => { if (!DRY_RUN) removeStateFile(); });

start(REQUESTED_PORT, false);
