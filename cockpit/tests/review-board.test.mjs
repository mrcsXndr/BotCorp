// The header's review-board link (harness.modules.review_board): getBot reads
// the bot-written <bot>/.botcorp/review-board.json only with the module on and
// passes only a private claude.ai artifact link; cards.js boardLink turns that
// into the link, the muted "no board yet", or nothing. Run: node --test cockpit/tests/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-board-test-'));
process.env.BOTCORP_HOME = path.join(TMP, 'rt');
process.env.BOTCORP_BOTS_DIR = path.join(TMP, 'bots');
const { getBot } = await import('../bots.mjs');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(HERE, '..', 'public', 'cards.js'), 'utf-8'), sandbox);
const { boardLink } = sandbox.CockpitCards;
const plain = (o) => JSON.parse(JSON.stringify(o));

const URL = 'https://claude.ai/code/artifact/0a1b2c3d-4e5f-6789-abcd-ef0123456789';
function bot(name, on, record) {
  const home = path.join(TMP, 'bots', name);
  fs.mkdirSync(path.join(home, '.botcorp'), { recursive: true });
  fs.writeFileSync(path.join(home, 'bot.yaml'), `name: ${name}\nharness:\n  service: manual\n  modules:\n    review_board: ${on}\n`);
  if (record) fs.writeFileSync(path.join(home, '.botcorp', 'review-board.json'), JSON.stringify(record));
}

test('module off: no board in the API and nothing in the header, even with a record on disk', async () => {
  bot('off', false, { url: URL, open: 4, answered: 1 });
  const b = await getBot('off');
  assert.equal(b.reviewBoard, null);
  assert.equal(boardLink(b.reviewBoard), null);
});

test('positive control: module on with a record gives the link and the open count', async () => {
  bot('on', true, { url: URL, open: 4, answered: 1, sent_at: '2026-09-28T12:52:00Z' });
  const b = await getBot('on');
  assert.deepEqual(plain(b.reviewBoard), { url: URL, open: 4, answered: 1, sentAt: '2026-09-28T12:52:00Z' });
  const v = plain(boardLink(b.reviewBoard));
  assert.equal(v.url, URL);
  assert.equal(v.count, '4 open');
  assert.match(v.title, /4 open, 1 answered/);
});

test('module on, nothing recorded yet: the muted "no board yet"', async () => {
  bot('fresh', true, null);
  const b = await getBot('fresh');
  assert.deepEqual(plain(b.reviewBoard), { url: null, open: null, answered: null, sentAt: null });
  assert.equal(boardLink(b.reviewBoard).none, true);
});

test('a hostile record never becomes a link or a count', async () => {
  for (const [i, url] of ['javascript:alert(1)', 'https://claude.ai.evil.example/artifact/0a1b2c3d-4e5f', 'http://claude.ai/artifact/0a1b2c3d-4e5f', 'https://claude.ai/public/artifacts/0a1b2c3d-4e5f'].entries()) {
    bot(`bad${i}`, true, { url, open: 3 });
    const b = await getBot(`bad${i}`);
    assert.equal(b.reviewBoard.url, null, url);
    assert.equal(b.reviewBoard.open, null, url);
    assert.equal(boardLink(b.reviewBoard).none, true, url);
  }
  bot('badcount', true, { url: URL, open: '5', answered: -1, sent_at: '<b>' });
  const b = await getBot('badcount');
  assert.deepEqual(plain(b.reviewBoard), { url: URL, open: null, answered: null, sentAt: null });
  assert.equal(boardLink(b.reviewBoard).count, '');
  // the client refuses a bad URL on its own too
  assert.equal(boardLink({ url: 'javascript:alert(1)', open: 1 }).none, true);
});

test('the header markup starts hidden and opens the board in a new tab without an opener', () => {
  const html = fs.readFileSync(path.join(HERE, '..', 'public', 'index.html'), 'utf-8');
  const link = /<a [^>]*id="hBoard"[^>]*>/.exec(html)?.[0] || '';
  assert.match(link, /\bhidden\b/);
  assert.match(link, /target="_blank"/);
  assert.match(link, /rel="noopener noreferrer"/);
  assert.match(/<span [^>]*id="hBoardNone"[^>]*>/.exec(html)?.[0] || '', /\bhidden\b/);
});
