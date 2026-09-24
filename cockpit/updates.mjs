// updates.mjs - read-only view of pending/applied harness releases for the
// cockpit's Releases panel.
//
// The daemon's hourly update check WRITES <BOTCORP_HOME>/state/updates.json;
// the cockpit only reads it. Apply/Skip go through the CLI (`update --apply
// <tag>` / `update --skip <tag>`), same as every other write path here.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { BOTCORP_HOME } from './bots.mjs';

const FILE = path.join(BOTCORP_HOME, 'state', 'updates.json');

export async function listUpdates() {
  let data;
  try { data = JSON.parse(await fsp.readFile(FILE, 'utf-8')); } catch { return { releases: [] }; }
  const releases = Array.isArray(data.releases) ? data.releases : [];
  return {
    releases: releases.map((r) => ({
      tag: String(r?.tag ?? ''),
      sha: typeof r?.sha === 'string' ? r.sha.slice(0, 12) : null,
      date: typeof r?.date === 'string' ? r.date : null,
      what: typeof r?.what === 'string' ? r.what : '',
      why: typeof r?.why === 'string' ? r.why : '',
      value: typeof r?.value === 'string' ? r.value : '',
      status: typeof r?.status === 'string' ? r.status : 'pending',
    })).filter((r) => r.tag),
  };
}
