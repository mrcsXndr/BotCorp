// @ts-check
// updates.mjs - read-only view of the harness releases for the cockpit's
// Updates page.
//
// The daemon's hourly update check WRITES <BOTCORP_HOME>/state/updates.json;
// the cockpit only reads it. Apply / Skip / Roll back / Cancel go through the
// CLI (`update --apply|--skip|--rollback|--cancel <tag>`), same as every other
// write path here. How the releases read against the installed version
// (cumulative: vN carries every older tag) is core/releases.mjs.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { BOTCORP_HOME, BOTCORP_ROOT } from './bots.mjs';
import { cmpVersion, isOlder, sortReleases, releaseView } from '../core/releases.mjs';
import { releaseNotes } from '../core/changelog.mjs';

export { cmpVersion, isOlder, sortReleases, releaseView };

const FILE = path.join(BOTCORP_HOME, 'state', 'updates.json');

// The checked-out version, as engine.mjs reports it.
export async function installedVersion() {
  try { return JSON.parse(await fsp.readFile(path.join(BOTCORP_ROOT, 'botcorp.json'), 'utf-8')).version ?? null; } catch { return null; }
}

const str = (v) => (typeof v === 'string' ? v : '');
// One release's notes: what the daemon stored ({summary, notes, notes_tail},
// v0.8.2+), else that tag's section of the installed CHANGELOG.md (every tag up
// to the installed one is in it). An entry from before v0.8.2 carried only
// what/why/value (the first line of three bullets): not shown.
function notesOf(r, changelog) {
  const stored = Array.isArray(r?.notes) ? r.notes.filter((n) => n && typeof n === 'object').map((n) => ({ title: str(n.title), text: str(n.text) })) : [];
  if (str(r?.summary) || stored.length) return { summary: str(r.summary), notes: stored, tail: str(r.notes_tail) };
  const n = changelog ? releaseNotes(changelog, String(r?.tag || '')) : null;
  return n && n.found ? { summary: n.summary, notes: n.notes, tail: n.tail } : { summary: '', notes: [], tail: '' };
}

export async function listUpdates() {
  const installed = await installedVersion();
  /** @type {any} */
  let data = null;
  try { data = JSON.parse(await fsp.readFile(FILE, 'utf-8')); } catch {}
  const raw = data && Array.isArray(data.releases) ? data.releases : [];
  let changelog = '';
  try { changelog = await fsp.readFile(path.join(BOTCORP_ROOT, 'CHANGELOG.md'), 'utf-8'); } catch {}
  const releases = sortReleases(raw.filter((r) => r && typeof r.tag === 'string' && r.tag).map((r) => ({
    tag: r.tag,
    sha: typeof r.sha === 'string' ? r.sha.slice(0, 12) : null,
    date: str(r.date) || null,
    status: str(r.status) || 'pending',
    ...notesOf(r, changelog),
    included_in: str(r.included_in) || null,
    rollback: r.rollback === true,
    fail_reason: str(r.fail_reason) || null,
    older: isOlder(r.tag, installed),
    current: !!(installed && isOlder(r.tag, installed) && cmpVersion(r.tag, installed) === 0),
  })));
  const view = releaseView(releases, installed);
  // the installed version with no entry of its own still gets its notes
  if (view.current && view.current.synthetic) Object.assign(view.current, notesOf({ tag: view.current.tag }, changelog));
  return { checked_at: data && str(data.checked_at) || null, releases, ...view };   // view carries `installed`
}
