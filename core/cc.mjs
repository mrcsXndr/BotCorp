// cc.mjs - the Claude Code pin as `botcorp cc status --json` and the cockpit's
// GET /api/cc report it: <BOTCORP_HOME>/state/cc.json (daemon/cc.ps1 writes
// it; docs/daemon.md "Claude Code pin") plus, per bot, the Claude Code it runs
// (observe cc_exe / cc_version) against the pin. Read-only.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR, readJson, readCcState, listBots } from '../cli/_lib.mjs';

function samePath(a, b) { return path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase(); }

// One bot against the pin. on_pin: true, false (a roll is pending), or null
// (not alive, no pin, or nothing tells) - daemon/_common.ps1 Get-CcRollAction's rule.
export function botCc(bot, observed, pin) {
  const o = observed || {};
  const alive = o.alive === true;
  let onPin = null;
  if (alive && pin && pin.exe && (o.cc_exe || o.cc_version)) {
    const off = (o.cc_exe && !samePath(o.cc_exe, pin.exe)) || (o.cc_version && String(o.cc_version) !== String(pin.version));
    onPin = !off;
  }
  return { bot, alive, phase: o.phase ?? null, cc_version: o.cc_version ?? null, cc_exe: o.cc_exe ?? null, on_pin: onPin, at: o.at ?? null };
}

// `observed`: { <bot>: observe record }; default each bot's last tick record (state/<bot>.json `observed`).
export function ccStatus({ observed = null } = {}) {
  const s = readCcState() || {};
  const pinned = s.pinned || null;
  const obs = observed || Object.fromEntries(listBots().map((b) => [b, (readJson(path.join(STATE_DIR, `${b}.json`)) || {}).observed || null]));
  return {
    pinned,
    previous: Array.isArray(s.previous) ? s.previous : [],
    candidate: s.candidate || null,
    rejected: Array.isArray(s.rejected) ? s.rejected : [],
    checked_at: s.checked_at || null,
    bots: Object.entries(obs).map(([b, o]) => botCc(b, o, pinned)),
  };
}

export function fileSha256(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}
