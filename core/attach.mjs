// attach.mjs - files the operator attaches from the cockpit (composer, terminal
// paste/drop): which types are taken, where they are kept, and how a message
// names them to the session.
//
//   <bot>/.botcorp/uploads/<yyyymmdd-hhmmss>-<safe name>
//
// The folder carries its own `.gitignore` (`*`), so a bot folder that is a
// repo never commits an upload, whatever its own ignore file says.
//
// A message names each file on a line of its own, after the text:
//
//   [attached: <absolute path> (<type>, <size>)]
//
// On delivery (core/inbox.mjs) each such line that names an image in the bot's
// own uploads folder is also pasted on its own: Claude Code turns a
// bracketed-pasted image path into an image attachment ("[Image #1]"; checked
// against a real session, 2026-09-28). It does not do that for a PDF or a text
// file, which stay a path line the session opens with Read.

import fs from 'node:fs';
import path from 'node:path';

export const UPLOAD_MAX = 20 * 1024 * 1024;
export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const DOC_EXT = ['pdf', 'txt', 'md', 'csv', 'json', 'log'];
const CODE_EXT = ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'ps1', 'sql', 'html', 'css', 'scss', 'xml', 'yaml', 'yml', 'toml', 'ini', 'diff', 'patch'];
export const ALLOWED_EXT = new Set([...IMAGE_EXT, ...DOC_EXT, ...CODE_EXT]);
export const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export const uploadsDir = (home) => path.join(home, '.botcorp', 'uploads');

export function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}
export const isImage = (name) => IMAGE_EXT.includes(extOf(name));

// The last path segment, reduced to [A-Za-z0-9._-], no leading dot, at most 80
// characters with the extension kept. Throws on a type outside the allow-list.
export function safeName(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  const ext = extOf(base);
  if (!ext) throw new Error('the file has no extension, so its type is unknown');
  if (!ALLOWED_EXT.has(ext)) throw new Error(`.${ext} files are not accepted (images, PDF, text and code files are)`);
  let stem = base.slice(0, -(ext.length + 1)).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[.-]+|[.-]+$/g, '');
  stem = stem.slice(0, 80 - ext.length - 1) || 'file';
  return `${stem}.${ext}`;
}

// yyyymmdd-hhmmss (local time) + '-' + the safe name.
export function storedName(name, date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `${stamp}-${safeName(name)}`;
}

// A stored upload -> its absolute path, or null when `file` is no plain name of
// a file inside the folder (a traversal, a separator, a missing file).
export function resolveUpload(home, file) {
  const f = String(file || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(f)) return null;
  const dir = uploadsDir(home);
  const abs = path.join(dir, f);
  if (path.dirname(abs) !== dir) return null;
  try { if (!fs.statSync(abs).isFile()) return null; } catch { return null; }
  return abs;
}

export function fmtSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  return `${(b / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}

export const attachedLine = ({ path: p, bytes }) => `[attached: ${p} (${extOf(p)}, ${fmtSize(bytes)})]`;

// The message as it is queued: the text, then one line per file.
export function withAttachments(text, files) {
  const lines = (files || []).map(attachedLine);
  const body = String(text || '').replace(/\s+$/, '');
  return [body, ...lines].filter(Boolean).join('\n');
}

const LINE_RE = /^\[attached: (.+) \(([a-z0-9]{1,8}), [0-9.]+ [KM]?B\)\]$/gm;

// The images a queued message names that sit in this bot's uploads folder and
// still exist: the paths to paste after the text.
export function imagePastes(text, home) {
  const dir = path.resolve(uploadsDir(home)).toLowerCase() + path.sep;
  const out = [];
  for (const m of String(text || '').matchAll(LINE_RE)) {
    const p = m[1];
    if (!isImage(p) || !path.isAbsolute(p)) continue;
    if (!path.resolve(p).toLowerCase().startsWith(dir)) continue;
    try { if (!fs.statSync(p).isFile()) continue; } catch { continue; }
    out.push(p);
  }
  return out;
}
