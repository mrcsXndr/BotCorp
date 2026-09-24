// Session history - read-only list of a bot's Claude Code sessions.
//
// Claude Code stores one transcript per session at
// <config home>/projects/<slug>/<session-id>.jsonl, slug = the absolute cwd
// with every non-alphanumeric char replaced by '-'. We list files and mtimes
// only; the preview reads the head of the file and is best-effort (the
// transcript format is internal to Claude Code and may change), so a preview
// that comes back empty is not an error. Strictly read-only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ccProjectSlug } from './bots.mjs';

const PREVIEW_SCAN_BYTES = 64 * 1024;

async function previewOf(file) {
  let fh;
  try {
    fh = await fs.open(file, 'r');
    const buf = Buffer.alloc(PREVIEW_SCAN_BYTES);
    const { bytesRead } = await fh.read(buf, 0, PREVIEW_SCAN_BYTES, 0);
    for (const line of buf.subarray(0, bytesRead).toString('utf-8').split('\n')) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj?.type !== 'user') continue;
      let text = '';
      const c = obj.message?.content;
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) text = c.filter((p) => p?.type === 'text').map((p) => p.text).join(' ');
      text = text.replace(/\s+/g, ' ').trim();
      if (text) return text.slice(0, 120);
    }
    return '';
  } catch {
    return '';
  } finally {
    try { await fh?.close(); } catch {}
  }
}

// Newest first, across every project dir in the config home. `own` marks the
// dir that is the bot's own BOT_HOME (the slug matches); others are sessions
// the bot started elsewhere.
export async function listSessions(configDir, botHome, limit = 40) {
  const projectsDir = path.join(configDir, 'projects');
  const ownSlug = ccProjectSlug(botHome).toLowerCase();
  let projects;
  try { projects = await fs.readdir(projectsDir, { withFileTypes: true }); } catch { return []; }
  const sessions = [];
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const dir = path.join(projectsDir, p.name);
    let files;
    try { files = await fs.readdir(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const st = await fs.stat(path.join(dir, f));
        sessions.push({ id: f.replace(/\.jsonl$/, ''), project: p.name, own: p.name.toLowerCase() === ownSlug, file: path.join(dir, f), mtime: st.mtimeMs, size: st.size });
      } catch {}
    }
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  const top = sessions.slice(0, limit);
  await Promise.all(top.map(async (s) => { s.preview = await previewOf(s.file); delete s.file; }));
  return top;
}
