// changelog.mjs - one release's notes out of CHANGELOG.md, for the Updates page.
//
//   node core/changelog.mjs <CHANGELOG.md> <tag>   -> {tag, found, summary, notes, tail} as JSON
//   node core/changelog.mjs --git <repo> <tag>     -> the same, from that tag's own CHANGELOG.md
//
// A release section runs from `## <tag>` (also `## [<tag>]`, `## <tag> (unreleased)`)
// to the next `## `. Our format: a lead paragraph that says what the release is,
// then bullets that start with a bold title (`- **Failover.** When ...`), then
// sometimes an "Upgrading: ..." paragraph. So:
//   summary  the paragraphs before the first bullet (markdown, paragraphs split by a blank line)
//   notes    one {title, text} per top-level bullet: title = the bold lead without its
//            closing period ('' when the bullet has none), text = the rest, wrapped
//            lines joined; nested bullets stay as "- " lines under it
//   tail     the paragraphs after the bullets (the upgrade note)
// `### ` headings are boundaries only. Nothing is invented: a section with no
// lead paragraph has summary '', a tag with no section has found: false.
// update.ps1 -Check stores the result in state/updates.json; the cockpit falls
// back to the installed CHANGELOG.md for an entry recorded without notes.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function sectionLines(text, tag) {
  const lines = String(text || '').split(/\r?\n/);
  const head = new RegExp(`^##\\s+\\[?${escRe(tag)}\\]?(?=\\s|$)`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

const BULLET = /^([-*+])\s+(.*)$/;
const join = (parts) => parts.map((s) => s.trim()).filter(Boolean).join(' ');

// "**Backup accounts.** When ..." -> {title: 'Backup accounts', text: 'When ...'}
export function splitTitle(body) {
  const m = /^\*\*(.+?)\*\*\s*(.*)$/s.exec(body);
  if (!m) return { title: '', text: body };
  const title = m[1].trim().replace(/[.:]$/, '').trim();
  const text = m[2].replace(/^[,;:]\s*/, '').trim();
  return { title, text };
}

export function releaseNotes(text, tag) {
  const lines = sectionLines(text, tag);
  if (!lines) return { tag, found: false, summary: '', notes: [], tail: '' };
  const lead = [], tail = [], notes = [];
  let para = [];            // the paragraph being read (lead or tail)
  let item = null;          // the bullet being read: {main: [], subs: [[...]]}
  let seenBullet = false;
  const endPara = () => { if (para.length) (seenBullet ? tail : lead).push(join(para)); para = []; };
  const endItem = () => {
    if (!item) return;
    const main = join(item.main);
    const subs = item.subs.map((s) => `- ${join(s)}`);
    notes.push(splitTitle([main, ...subs].filter(Boolean).join('\n')));
    item = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { endPara(); continue; }
    if (/^#{3,6}\s/.test(line)) { endPara(); endItem(); continue; }
    const indent = line.length - line.trimStart().length;
    const b = BULLET.exec(line.trimStart());
    if (b && indent === 0) { endPara(); endItem(); seenBullet = true; item = { main: [b[2]], subs: [] }; continue; }
    if (item && indent > 0) {
      if (b) item.subs.push([b[2]]);
      else if (item.subs.length) item.subs[item.subs.length - 1].push(line);
      else item.main.push(line);
      continue;
    }
    endItem();
    para.push(line);
  }
  endPara();
  endItem();
  return { tag, found: true, summary: lead.join('\n\n'), notes, tail: tail.join('\n\n') };
}

// The CLI prints ASCII-only JSON (\uXXXX escapes): PowerShell decodes a child's
// stdout in the console code page, which would mangle an arrow or an accent.
export const asciiJson = (v) => JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('core/changelog.mjs')) {
  const args = process.argv.slice(2);
  const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const repo = opt('--git'), gitExe = opt('--git-exe') || 'git';
  const [a, b] = args;
  const tag = repo ? a : b;
  if (!tag || (!repo && !a)) { console.error('usage: changelog.mjs <CHANGELOG.md> <tag> | --git <repo> <tag> [--git-exe <git>]'); process.exit(2); }
  let text = '';
  try {
    // --git: the release's OWN changelog (<tag>:CHANGELOG.md), read as UTF-8 here rather than through a console pipe
    text = repo
      ? execFileSync(gitExe, ['-C', repo, 'show', `${tag}:CHANGELOG.md`], { encoding: 'utf-8', timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
      : fs.readFileSync(a, 'utf-8');
  } catch (e) { console.error(`changelog: ${e.message.split('\n')[0]}`); process.exit(1); }
  console.log(asciiJson(releaseNotes(text, tag)));
}
