// _zip.mjs - a minimal ZIP writer/reader on node:zlib, for `botcorp export` /
// `botcorp import`. No dependency, no shell: Compress-Archive cannot exclude
// paths without a staging copy and writes backslash entry names on older
// PowerShell, and a bot folder is small (transcripts and the vault are never
// in the archive). Deflate (method 8), UTF-8 names, no zip64: an archive over
// 4 GB or 65535 entries is refused with a clear error rather than corrupted.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const LOCAL_SIG = 0x04034b50, CENTRAL_SIG = 0x02014b50, EOCD_SIG = 0x06054b50;
const FLAG_UTF8 = 0x0800;

let crcTable = null;
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;   // node >= 22.2
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosDateTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  const year = Math.max(1980, d.getFullYear());
  const date = (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

// entries: [{ name: 'memory/TDL.md', file: '<abs path>' }], names forward-slash.
export function zipWrite(outFile, entries) {
  if (entries.length > 0xffff) throw new Error(`zip: ${entries.length} entries exceeds the 65535 limit (no zip64)`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const fd = fs.openSync(outFile + '.tmp', 'w');
  let offset = 0;
  const central = [];
  const write = (buf) => { fs.writeSync(fd, buf); offset += buf.length; };
  try {
    for (const e of entries) {
      const name = Buffer.from(e.name.replace(/\\/g, '/'), 'utf-8');
      const data = fs.readFileSync(e.file);
      const st = fs.statSync(e.file);
      if (data.length > 0xffffffff) throw new Error(`zip: ${e.name} is over 4 GB (no zip64)`);
      const comp = zlib.deflateRawSync(data);
      const crc = crc32(data);
      const { time, date } = dosDateTime(st.mtime);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(LOCAL_SIG, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(FLAG_UTF8, 6); local.writeUInt16LE(8, 8);
      local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
      const headerOffset = offset;
      if (headerOffset > 0xffffffff) throw new Error('zip: archive over 4 GB (no zip64)');
      write(local); write(name); write(comp);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(CENTRAL_SIG, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(FLAG_UTF8, 8); c.writeUInt16LE(8, 10);
      c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24);
      c.writeUInt16LE(name.length, 28); c.writeUInt16LE(0, 30); c.writeUInt16LE(0, 32); c.writeUInt16LE(0, 34); c.writeUInt16LE(0, 36);
      c.writeUInt32LE(0, 38); c.writeUInt32LE(headerOffset, 42);
      central.push(c, name);
    }
    const cdOffset = offset;
    for (const b of central) write(b);
    const cdSize = offset - cdOffset;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(cdOffset, 16); eocd.writeUInt16LE(0, 20);
    write(eocd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(outFile + '.tmp', outFile);
  return { file: outFile, entries: entries.length, bytes: offset };
}

// Returns [{ name, size, csize, method, offset }] from the central directory.
export function zipList(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 22) throw new Error(`zip: ${file} is too small to be a zip`);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`zip: ${file}: no end-of-central-directory record`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL_SIG) throw new Error(`zip: ${file}: bad central directory entry ${i}`);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf-8', p + 46, p + 46 + nlen);
    entries.push({ name, size, csize, method, offset });
    p += 46 + nlen + xlen + clen;
  }
  return { buf, entries };
}

function safeRel(name) {
  const n = name.replace(/\\/g, '/');
  if (!n || n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..')) throw new Error(`zip: refusing unsafe entry name ${JSON.stringify(name)}`);
  return n;
}

export function zipEntryData(buf, entry) {
  const p = entry.offset;
  if (buf.readUInt32LE(p) !== LOCAL_SIG) throw new Error(`zip: bad local header for ${entry.name}`);
  const nlen = buf.readUInt16LE(p + 26), xlen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nlen + xlen;
  const raw = buf.subarray(start, start + entry.csize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`zip: unsupported compression method ${entry.method} for ${entry.name}`);
}

// Extract into destDir; `rename(name) -> name|null` lets the caller move or
// drop entries. Directory entries (trailing '/') are skipped; parents are made.
export function zipExtract(file, destDir, rename = (n) => n) {
  const { buf, entries } = zipList(file);
  const written = [];
  for (const e of entries) {
    const rel = safeRel(e.name);
    if (rel.endsWith('/')) continue;
    const target = rename(rel);
    if (!target) continue;
    const out = path.join(destDir, safeRel(target));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, zipEntryData(buf, e));
    written.push(target);
  }
  return written;
}
