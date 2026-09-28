// Attachments: the upload rules (core/attach.mjs), the composer's early checks
// and the sent-turn parsing (public/cards.js, evaluated verbatim), the chips
// (public/inbox.js, on a DOM that refuses innerHTML), then a real cockpit on a
// free port: the operator gate, the allow-list, the size cap, a `../` name that
// stays inside, the served thumbnail, and /send naming the file after the text.
// Run: node --test cockpit/tests/

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as attach from '../../core/attach.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-attach-test-'));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

const cards = {};
vm.createContext(cards);
vm.runInContext(fs.readFileSync(path.join(HERE, '..', 'public', 'cards.js'), 'utf-8'), cards);
const { attachView, splitAttached, ATTACH_EXT, ATTACH_MAX } = cards.CockpitCards;
const ib = {};
vm.createContext(ib);
vm.runInContext(fs.readFileSync(path.join(HERE, '..', 'public', 'inbox.js'), 'utf-8'), ib);
const { chip, sentBubble } = ib.CockpitInbox;
const plain = (o) => JSON.parse(JSON.stringify(o));   // across the vm realm

// ---- the rules -----------------------------------------------------------------------
test('safeName: the last segment, reduced to safe characters; refused types throw', () => {
  assert.equal(attach.safeName('Screen Shot 2026-09-28 at 10.00.png'), 'Screen-Shot-2026-09-28-at-10.00.png');
  assert.equal(attach.safeName('../../../etc/evil.png'), 'evil.png');
  assert.equal(attach.safeName('..\\..\\x\\..png'), 'file.png');
  assert.equal(attach.safeName('.hidden.JSON'), 'hidden.json');
  assert.equal(attach.safeName('rapport ÅÄÖ <b>.md'), 'rapport-b.md');
  assert.equal(attach.safeName(`${'a'.repeat(300)}.txt`).length, 80);
  assert.throws(() => attach.safeName('setup.exe'), /\.exe files are not accepted/);
  assert.throws(() => attach.safeName('x.png.exe'), /\.exe files are not accepted/);
  assert.throws(() => attach.safeName('Makefile'), /no extension/);
  assert.match(attach.storedName('a b.pdf', new Date(2026, 8, 28, 9, 5, 7)), /^20260928-090507-a-b\.pdf$/);
});

test('resolveUpload: only a plain name of an existing file in the uploads folder', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'home-'));
  const dir = attach.uploadsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '20260928-090507-a.png'), PNG);
  fs.writeFileSync(path.join(home, 'secret.txt'), 'no');
  assert.equal(attach.resolveUpload(home, '20260928-090507-a.png'), path.join(dir, '20260928-090507-a.png'));
  for (const bad of ['../../secret.txt', '..\\..\\secret.txt', '..', '.gitignore', 'sub/x.png', path.join(home, 'secret.txt'), 'missing.png', '', null]) {
    assert.equal(attach.resolveUpload(home, bad), null, String(bad));
  }
});

test('delivery format: the text, then one [attached: ...] line per file; images inside the folder are pasted', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'home-'));
  const dir = attach.uploadsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const img = path.join(dir, '20260928-090507-shot.png');
  const pdf = path.join(dir, '20260928-090507-doc.pdf');
  fs.writeFileSync(img, PNG);
  fs.writeFileSync(pdf, 'pdf');
  const text = attach.withAttachments('what is wrong here?  \n', [{ path: img, bytes: 2048 }, { path: pdf, bytes: 3 * 1024 * 1024 }]);
  assert.equal(text, `what is wrong here?\n[attached: ${img} (png, 2 KB)]\n[attached: ${pdf} (pdf, 3 MB)]`);
  assert.equal(attach.withAttachments('', [{ path: pdf, bytes: 10 }]), `[attached: ${pdf} (pdf, 10 B)]`);
  assert.deepEqual(attach.imagePastes(text, home), [img], 'the image is pasted, the PDF stays a path line');
  // negative controls: an image outside the folder, a missing one, a line mid-sentence
  const outside = path.join(home, 'elsewhere.png');
  fs.writeFileSync(outside, PNG);
  const forged = [`[attached: ${outside} (png, 1 KB)]`, `[attached: ${path.join(dir, 'gone.png')} (png, 1 KB)]`,
    `[attached: ${dir}${path.sep}..${path.sep}elsewhere.png (png, 1 KB)]`, `see [attached: ${img} (png, 1 KB)]`].join('\n');
  assert.deepEqual(attach.imagePastes(forged, home), []);
  assert.deepEqual(attach.imagePastes(`[attached: ${img} (png, 1 KB)]`, home), [img], 'positive control');
});

test('the composer mirrors the server allow-list and cap', () => {
  assert.deepEqual([...ATTACH_EXT].sort(), [...attach.ALLOWED_EXT].sort());
  assert.equal(ATTACH_MAX, attach.UPLOAD_MAX);
});

test('attachView: what the composer refuses before uploading', () => {
  assert.deepEqual(plain(attachView({ name: 'shot.PNG', size: 2048 }, 0)), { name: 'shot.PNG', size: '2 KB', image: true, why: '' });
  assert.deepEqual(plain(attachView({ name: 'notes.md', size: 10 }, 3)), { name: 'notes.md', size: '10 B', image: false, why: '' });
  assert.match(attachView({ name: 'setup.exe', size: 10 }, 0).why, /^setup\.exe: \.exe files are not accepted\./);
  assert.match(attachView({ name: 'Makefile', size: 10 }, 0).why, /without an extension/);
  assert.match(attachView({ name: 'big.pdf', size: ATTACH_MAX + 1 }, 0).why, /over 20 MB/);
  assert.match(attachView({ name: 'e.txt', size: 0 }, 0).why, /empty/);
  assert.match(attachView({ name: 'a.png', size: 1 }, 10).why, /At most 10 files/);
  assert.doesNotMatch(Object.values(plain(attachView({ name: 'setup.exe', size: 1 }, 0))).join(' '), /—/, 'no em dash in UI text');
});

test('splitAttached: the sent turn back into its text and chips, [Image #n] included', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'home-'));
  const img = path.join(attach.uploadsDir(home), '20260928-090507-shot.png');
  const pdf = path.join(attach.uploadsDir(home), '20260928-090507-doc.pdf');
  const sent = attach.withAttachments('look\n\nat this', [{ path: img, bytes: 2048 }, { path: pdf, bytes: 5 }]);
  // what Claude Code records once it attached the image
  const recorded = sent.replace(`(png, 2 KB)]`, `(png, 2 KB)] [Image #1]`);
  for (const t of [sent, recorded]) {
    assert.deepEqual(plain(splitAttached(t)), { body: 'look\n\nat this', files: [
      { id: '20260928-090507-shot.png', name: 'shot.png', size: '2 KB', image: true },
      { id: '20260928-090507-doc.pdf', name: 'doc.pdf', size: '5 B', image: false },
    ] });
  }
  assert.deepEqual(plain(splitAttached('no files [attached: here] mid-line')), { body: 'no files [attached: here] mid-line', files: [] });
});

// ---- the chips -------------------------------------------------------------------------
function stubDoc() {
  const make = (tag) => {
    const n = { tagName: tag, className: '', title: '', children: [], text: '' };
    n.appendChild = (c) => { n.children.push(c); return c; };
    Object.defineProperty(n, 'textContent', { get: () => n.text + n.children.map((c) => c.textContent).join(''), set: (v) => { n.text = String(v); n.children = []; } });
    Object.defineProperty(n, 'innerHTML', { get: () => { throw new Error('innerHTML read'); }, set: () => { throw new Error('innerHTML assigned'); } });
    return n;
  };
  return { createElement: make };
}

test('chip: a thumbnail slot for an image, name and size as text, a remove button when removable', () => {
  let removed = 0;
  const hostile = '<img src=x onerror=alert(1)>.png';
  const { node, thumb } = chip(stubDoc(), { name: hostile, size: '2 KB', image: true }, () => removed++);
  assert.equal(node.className, 'achip img');
  assert.equal(thumb.tagName, 'img');
  assert.deepEqual(node.children.map((c) => c.tagName), ['img', 'span', 'span', 'button']);
  assert.equal(node.children[1].textContent, hostile, 'the name is text, never markup');
  assert.equal(node.children[3].title, `Remove ${hostile}`);
  node.children[3].onclick();
  assert.equal(removed, 1);
  const doc = chip(stubDoc(), { name: 'notes.md', size: '10 B', image: false });
  assert.equal(doc.thumb, null);
  assert.deepEqual(doc.node.children.map((c) => c.tagName), ['span', 'span'], 'a sent chip has no remove button');
});

test('sentBubble with files: the chips under the text; an attachment-only message has no empty body', () => {
  const files = [{ name: 'a.png', size: '1 KB', image: true }, { name: 'b.pdf', size: '2 MB', image: false }];
  const b = sentBubble(stubDoc(), 'see these', files);
  assert.deepEqual(b.node.children.map((c) => c.className), ['plain', 'achips', 'ist sending']);
  assert.equal(b.node.children[1].children.length, 2);
  assert.equal(b.thumbs.length, 2);
  assert.equal(b.thumbs[0].tagName, 'img');
  assert.equal(b.thumbs[1], null);
  const only = sentBubble(stubDoc(), '', files);
  assert.deepEqual(only.node.children.map((c) => c.className), ['achips', 'ist sending']);
});

// ---- a real cockpit ------------------------------------------------------------------------
const children = [];
after(() => { for (const c of children) c.kill(); });

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

test('the upload route: gated, allow-listed, capped, contained; /send names the file', async () => {
  const rt = path.join(TMP, 'rt');
  const botsDir = path.join(TMP, 'bots');
  const home = path.join(botsDir, 'demo');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'bot.yaml'), 'name: demo\nharness:\n  service: manual\n  session: bg\n  modules:\n    telegram: false\n');
  const port = await freePort();
  const env = { ...process.env, BOTCORP_HOME: rt, BOTCORP_BOTS_DIR: botsDir, BOT_TG_MUTE: '1' };
  const child = spawn(process.execPath, [SERVER, '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {}
    if (i > 100) throw new Error(`cockpit did not start: ${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const cookie = (await fetch(`${base}/`)).headers.get('set-cookie').split(';')[0];
  const token = fs.readFileSync(path.join(rt, 'state', 'cockpit-approve-token'), 'utf-8').trim();
  const up = async (name, body, withToken = true) => {
    const r = await fetch(`${base}/api/bots/demo/uploads`, { method: 'POST', body,
      headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name), ...(withToken ? { 'x-approve-token': token } : {}) } });
    return { status: r.status, json: await r.json() };
  };
  const dir = attach.uploadsDir(home);

  // the gate: no token, no file
  const denied = await up('shot.png', PNG, false);
  assert.equal(denied.status, 403);
  assert.equal(denied.json.need, 'approve-token');
  assert.equal(fs.existsSync(dir), false, 'nothing written without the token');

  const ok = await up('Screen Shot.png', PNG);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.match(ok.json.id, /^\d{8}-\d{6}-Screen-Shot\.png$/);
  assert.equal(ok.json.path, path.join(dir, ok.json.id));
  assert.equal(ok.json.image, true);
  assert.deepEqual(fs.readFileSync(ok.json.path), PNG);
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8'), '*\n', 'the folder ignores itself');

  // negative controls: a refused type, a name that tries to climb out, an empty body, over the cap
  const exe = await up('setup.exe', Buffer.from('MZ'));
  assert.equal(exe.status, 400);
  assert.match(exe.json.error, /\.exe files are not accepted/);
  const climb = await up('../../../escape.png', PNG);
  assert.equal(climb.status, 200);
  assert.equal(path.dirname(climb.json.path), dir, 'the ../ name stays inside the uploads folder');
  assert.equal(fs.existsSync(path.join(botsDir, 'escape.png')) || fs.existsSync(path.join(TMP, 'escape.png')), false);
  assert.equal((await up('empty.txt', Buffer.alloc(0))).status, 400);
  const big = await up('big.txt', Buffer.alloc(attach.UPLOAD_MAX + 1, 97));
  assert.equal(big.status, 413);
  assert.match(big.json.error, /20 MB max/);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.gitignore', climb.json.id, ok.json.id].sort(), 'only the accepted files were kept');

  // the served thumbnail: gated, images only, no traversal
  const get = (f, withToken = true) => fetch(`${base}/api/bots/demo/uploads/${encodeURIComponent(f)}`, { headers: { cookie, ...(withToken ? { 'x-approve-token': token } : {}) } });
  assert.equal((await get(ok.json.id, false)).status, 403);
  const img = await get(ok.json.id);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
  assert.equal((await get('..\\..\\bot.yaml')).status, 404);
  assert.equal((await get('.gitignore')).status, 404);

  // /send: a bad id is refused; a good one lands as a line after the text
  const send = async (body) => {
    const r = await fetch(`${base}/api/bots/demo/send`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  assert.equal((await send({ text: 'hi', attachments: ['../bot.yaml'] })).status, 400);
  assert.equal((await send({ text: 'hi', attachments: 'x' })).status, 400);
  const sent = await send({ text: 'what is this?', attachments: [ok.json.id] });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  const queued = fs.readFileSync(path.join(rt, 'state', 'demo', 'inbox.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(queued.at(-1).text, `what is this?\n[attached: ${ok.json.path} (png, ${attach.fmtSize(PNG.length)})]`);
  assert.equal((await send({ text: '', attachments: [ok.json.id] })).status, 200, 'a message may be only a file');

  // the audit names the upload, never its bytes
  const audit = fs.readFileSync(path.join(rt, 'state', 'cockpit-audit.jsonl'), 'utf-8');
  assert.match(audit, new RegExp(ok.json.id.replace(/\./g, '\\.')));
  assert.doesNotMatch(audit, /IHDR/);
});
