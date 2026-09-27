// updates.mjs - read-only view of pending/applied harness releases for the
// cockpit's Releases panel.
//
// The daemon's hourly update check WRITES <BOTCORP_HOME>/state/updates.json;
// the cockpit only reads it. Apply/Skip go through the CLI (`update --apply
// <tag>` / `update --skip <tag>`), same as every other write path here.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { BOTCORP_HOME, BOTCORP_ROOT } from './bots.mjs';

const FILE = path.join(BOTCORP_HOME, 'state', 'updates.json');

function semver(text) {
  const m = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
// a - b over [major, minor, patch]; an unparseable side counts as 0.0.0
export function cmpVersion(a, b) {
  const x = semver(a) || [0, 0, 0], y = semver(b) || [0, 0, 0];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
// Pending entries the daemon never cleared (updates.json keeps every tag it
// saw) are not actionable once the checkout is past them. Unknown installed
// version = nothing is older.
export function isOlder(tag, installed) { return !!(installed && semver(installed) && cmpVersion(tag, installed) <= 0); }

// The checked-out version, as engine.mjs reports it.
export async function installedVersion() {
  try { return JSON.parse(await fsp.readFile(path.join(BOTCORP_ROOT, 'botcorp.json'), 'utf-8')).version ?? null; } catch { return null; }
}

export async function listUpdates() {
  const installed = await installedVersion();
  let data;
  try { data = JSON.parse(await fsp.readFile(FILE, 'utf-8')); } catch { return { installed, releases: [] }; }
  const releases = Array.isArray(data.releases) ? data.releases : [];
  return {
    installed,
    releases: releases.map((r) => ({
      tag: String(r?.tag ?? ''),
      sha: typeof r?.sha === 'string' ? r.sha.slice(0, 12) : null,
      date: typeof r?.date === 'string' ? r.date : null,
      what: typeof r?.what === 'string' ? r.what : '',
      why: typeof r?.why === 'string' ? r.why : '',
      value: typeof r?.value === 'string' ? r.value : '',
      status: typeof r?.status === 'string' ? r.status : 'pending',
      older: isOlder(r?.tag, installed),
    })).filter((r) => r.tag),
  };
}
