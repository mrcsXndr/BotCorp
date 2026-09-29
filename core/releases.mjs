// releases.mjs - how the recorded harness releases (state/updates.json) read
// against the installed version. Pure: the cockpit's Updates page and the CLI
// share it. Releases are cumulative: checking out vN carries every older tag.

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
// At or below the installed version. Unknown installed version = nothing is older.
export function isOlder(tag, installed) { return !!(installed && semver(installed) && cmpVersion(tag, installed) <= 0); }
const isCurrent = (tag, installed) => !!(installed && semver(installed) && cmpVersion(tag, installed) === 0);

// Newest first by version: the order the releases build on each other. (By
// date, a v0.1.x hotfix tagged after v0.2.7 sorted above it.) The date breaks
// a tie; the input is left alone.
export function sortReleases(releases) {
  const t = (r) => { const v = Date.parse(r && r.date); return Number.isFinite(v) ? v : 0; };
  return [...releases].sort((a, b) => cmpVersion(b.tag, a.tag) || t(b) - t(a));
}

// -> { installed, current, available, history }, each release annotated with
//   view        installed | requested | will_be_included | available | failed | skipped
//               | comes_with | rollback_requested | history
//   included_in the release that carries this one (will_be_included, comes_with, history)
//   actions     what the page offers: apply | skip | cancel | rollback
// available = newer than installed, newest first; history = older, newest first.
// The newest newer release still pending (or failed) is the one to apply; the
// ones below it come with it (Apply stays, quietly, to stop at one). A
// requested release makes every newer one below it "will be included".
// current = the installed release's entry, or a stand-in {tag, synthetic}.
export function releaseView(releases, installed) {
  const all = sortReleases((releases || []).filter((r) => r && r.tag));
  const newer = all.filter((r) => !isOlder(r.tag, installed));
  const older = all.filter((r) => isOlder(r.tag, installed) && !isCurrent(r.tag, installed));
  const cur = all.find((r) => isCurrent(r.tag, installed)) || null;

  const available = [];
  const req = newer.find((r) => r.status === 'apply_requested');
  // the releases above a request are decided among themselves; below it, all are carried
  const above = req ? newer.slice(0, newer.indexOf(req)) : newer;
  const head = above.find((r) => r.status === 'pending' || r.status === 'failed');
  for (const r of newer) {
    const i = newer.indexOf(r);
    if (r === req) available.push({ ...r, view: 'requested', actions: ['cancel'] });
    else if (req && i > newer.indexOf(req)) available.push({ ...r, view: 'will_be_included', included_in: req.tag, actions: [] });
    else if (r === head) available.push({ ...r, view: r.status === 'failed' ? 'failed' : 'available', actions: r.status === 'failed' ? ['apply'] : ['apply', 'skip'] });
    else if (r.status === 'skipped' || (head && i < newer.indexOf(head))) available.push({ ...r, view: r.status === 'skipped' ? 'skipped' : r.status === 'failed' ? 'failed' : 'available', actions: ['apply'] });
    else if (head) available.push({ ...r, view: 'comes_with', included_in: head.tag, actions: ['apply'] });
    else available.push({ ...r, view: r.status === 'failed' ? 'failed' : 'available', actions: ['apply', 'skip'] });
  }

  // What carried an older release in: the upgrade that recorded it, else the lowest
  // release applied above it, else the installed version.
  const applied = all.filter((r) => r.status === 'applied').reverse();   // oldest first
  const carrier = (r) => r.included_in || (applied.find((a) => cmpVersion(a.tag, r.tag) > 0) || {}).tag || (installed ? `v${String(installed).replace(/^v/, '')}` : null);
  const history = older.map((r) => (r.status === 'apply_requested'
    ? { ...r, view: 'rollback_requested', actions: ['cancel'] }
    : { ...r, view: 'history', included_in: r.status === 'applied' ? null : carrier(r), actions: ['rollback'] }));

  const current = cur
    ? { ...cur, view: 'installed', actions: [] }
    : (installed ? { tag: `v${String(installed).replace(/^v/, '')}`, synthetic: true, view: 'installed', actions: [] } : null);
  return { installed, current, available, history };
}
