// core/changelog.mjs against the real CHANGELOG.md: the lead paragraph is the
// summary, each top-level bullet one note with its bold title split off, the
// upgrade paragraph after the bullets the tail. Run: node --test core/tests/changelog.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { releaseNotes, sectionLines, splitTitle, asciiJson } from '../changelog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CL = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf-8');
const TAGS = [...CL.matchAll(/^## \[?(v\d+\.\d+\.\d+)/gm)].map((m) => m[1]);
// the paragraph right under a heading (it ends at a blank line or at the first
// bullet), joined the way the extractor joins it
const leadOf = (tag) => {
  const out = [];
  for (const l of sectionLines(CL, tag).join('\n').trim().split('\n')) {
    if (!l.trim() || /^([-*+]\s|#{3,6}\s)/.test(l)) break;
    out.push(l.trim());
  }
  return out.join(' ');
};

test('every release heading in CHANGELOG.md is found, and a longer tag is never a prefix match', () => {
  assert.ok(TAGS.length > 40, `found ${TAGS.length} headings`);
  for (const t of TAGS) assert.equal(releaseNotes(CL, t).found, true, t);
  assert.equal(releaseNotes(CL, 'v0.8.10').found, false);
  assert.equal(releaseNotes(CL, 'v0.8').found, false);
  assert.deepEqual(releaseNotes(CL, 'v9.9.9'), { tag: 'v9.9.9', found: false, summary: '', notes: [], tail: '' });
});

test('v0.8.1: the lead paragraph is the summary and each bold-led bullet a titled note', () => {
  const n = releaseNotes(CL, 'v0.8.1');
  assert.equal(n.summary, 'Backup accounts with automatic failover and failback, a Settings page, a favicon and newest-first releases.');
  assert.deepEqual(n.notes.slice(0, 3).map((x) => x.title), ['Backup accounts', 'Failover', 'Failback']);
  // one note per top-level bullet, none lost to a wrapped line
  const bullets = sectionLines(CL, 'v0.8.1').filter((l) => /^- /.test(l)).length;
  assert.equal(n.notes.length, bullets);
  assert.match(n.notes[0].text, /^`backup_accounts` in bot\.yaml \(up to 5, in order, none equal to `account`\) gives a bot a chain/);
  assert.ok(n.notes[0].text.includes('like `account`. `accounts remove` refuses while any bot\'s chain names the account.'), 'the wrapped lines are joined into one text');
  assert.ok(n.notes.every((x) => x.title && x.text && !x.text.includes('\n')), 'every note titled, one line');
});

test('every section: the summary is its lead paragraph, and no note is empty', () => {
  for (const t of TAGS) {
    const n = releaseNotes(CL, t);
    assert.equal(n.summary.split('\n\n')[0], leadOf(t), t);
    for (const x of n.notes) assert.ok(x.title || x.text, `${t}: an empty note`);
    assert.ok(n.summary || n.notes.length, `${t}: nothing extracted`);
  }
});

test('a section without a lead paragraph has summary "" (nothing invented); the upgrade note is the tail', () => {
  const n = releaseNotes(CL, 'v0.2.17');
  assert.equal(n.summary, '');
  assert.equal(n.notes.length, 1);
  assert.equal(n.notes[0].title, 'Prompt automations');
  assert.match(n.tail, /^Upgrading: check out `v0\.2\.17`/);
});

test('a lead paragraph only (v0.2.1) and nested bullets kept as "- " lines (v0.1.16)', () => {
  const a = releaseNotes(CL, 'v0.2.1');
  assert.match(a.summary, /^v0\.2\.0 plus the v0\.1\.4 hotfix below/);
  assert.deepEqual(a.notes, []);
  const b = releaseNotes(CL, 'v0.1.16');
  const lines = b.notes[0].text.split('\n');
  assert.ok(lines.length >= 4 && lines.slice(1).every((l) => l.startsWith('- ')), b.notes[0].text);
});

test('headings with a suffix or brackets, and titles with a trailing colon or a comma after them', () => {
  const md = '# x\n\n## v1.2.0 (unreleased)\n\nLead one\ncontinues.\n\nLead two.\n\n- **A thing.** Text\n  more.\n- **B**: rest\n- **C**, rest\n- plain bullet\n\nUpgrading: nothing.\n\n## [v1.1.0]\n\n- **Old.** x\n';
  const n = releaseNotes(md, 'v1.2.0');
  assert.equal(n.summary, 'Lead one continues.\n\nLead two.');
  assert.deepEqual(n.notes, [{ title: 'A thing', text: 'Text more.' }, { title: 'B', text: 'rest' }, { title: 'C', text: 'rest' }, { title: '', text: 'plain bullet' }]);
  assert.equal(n.tail, 'Upgrading: nothing.');
  assert.deepEqual(releaseNotes(md, 'v1.1.0').notes, [{ title: 'Old', text: 'x' }]);
  assert.deepEqual(splitTitle('no bold here'), { title: '', text: 'no bold here' });
});

test('the CLI prints ASCII-only JSON that parses back to the same notes (PowerShell reads it)', () => {
  const s = asciiJson({ t: 'a → b · ×2 é' });
  assert.ok(/^[\x00-\x7e]*$/.test(s));
  assert.deepEqual(JSON.parse(s), { t: 'a → b · ×2 é' });
  const out = execFileSync(process.execPath, [path.join(ROOT, 'core', 'changelog.mjs'), path.join(ROOT, 'CHANGELOG.md'), 'v0.8.1'], { encoding: 'utf-8' });
  assert.ok(/^[\x00-\x7e\r\n]*$/.test(out));
  assert.deepEqual(JSON.parse(out), releaseNotes(CL, 'v0.8.1'));
});
