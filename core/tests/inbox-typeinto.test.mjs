// The inbox drainer's socket to the pty-host always settles (code review
// 2026-09-30, L4): a host that accepts the TCP connection and never answers
// the upgrade, or closes after it, used to leave typeInto's promise pending
// forever, which wedged the drainer and held its lock. Run: node --test core/tests/

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';

process.env.BOTCORP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-typeinto-test-'));
const { typeInto } = await import('../inbox.mjs');

const servers = [];
after(() => { for (const s of servers) { try { s.close(); } catch {} } });
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`did not settle within ${ms} ms`)), ms))]);

test('a host that accepts the connection and never answers the upgrade: an error, not a hang', async () => {
  const sockets = [];
  const srv = net.createServer((s) => { sockets.push(s); s.on('error', () => {}); });   // never writes a byte
  servers.push({ close: () => { for (const s of sockets) s.destroy(); srv.close(); } });
  const port = await listen(srv);
  const r = await within(typeInto({ port, token: 't' }, 'hello', [], { handshakeMs: 500 }), 5000);
  assert.match(r.err, /handshake|pty-host/);
  try { r.ws.terminate(); } catch {}
});

test('a host that closes right after the upgrade: an error naming the close, not a hang', async () => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  servers.push(wss);
  await new Promise((r) => wss.on('listening', r));
  wss.on('connection', (ws) => ws.close(1011, 'going away'));
  const r = await within(typeInto({ port: wss.address().port, token: 't' }, 'hello'), 5000);
  assert.match(r.err, /closed the connection/);
});

test('positive control: a host that draws and stays up gets the text and Enter', async () => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  servers.push(wss);
  await new Promise((r) => wss.on('listening', r));
  const got = [];
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ t: 'o', d: 'prompt> ' }));
    ws.on('message', (d) => got.push(JSON.parse(d.toString())));
  });
  const r = await within(typeInto({ port: wss.address().port, token: 't' }, 'hello'), 10_000);
  assert.equal(r.err, null);
  r.ws.close();
  await new Promise((res) => setTimeout(res, 200));
  assert.deepEqual(got.map((m) => m.d), ['\x1b[200~hello\x1b[201~', '\r']);
});
