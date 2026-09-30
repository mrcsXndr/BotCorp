import { Button, Disclosure, toast } from '../ui';
import { KitScreen, ScreenTitle } from './Kit';
import { Section } from './KitInbox';
import { RELEASES, type Release } from './fixtures';

// Updates fixture: Installed, Newer (newest first; the newest applicable is the
// only primary on the page), History (Roll back lives only here). Buttons come
// straight from each release's actions[], as the server returns them.
function ReleaseBlock({ r, primary, onAction }: { r: Release; primary?: boolean; onAction: (a: string) => void }) {
  return (
    <article className="px-4 py-3">
      <div className="flex items-baseline gap-2">
        <h3 className="m-0 num text-lg font-semibold text-text">{r.tag}</h3>
        <span className="text-sm text-text-3">{r.date}</span>
      </div>
      <p className="m-0 mt-1 text-body leading-body text-text-2">{r.summary}</p>
      {r.notes.length > 0 && (
        <Disclosure title="Release notes" meta={<span className="num">{r.notes.length}</span>} className="mt-1">
          <dl className="m-0 flex flex-col gap-2">
            {r.notes.map((n) => (
              <div key={n.title}>
                <dt className="text-ui font-semibold text-text">{n.title}</dt>
                <dd className="m-0 text-ui text-text-2">{n.body}</dd>
              </div>
            ))}
          </dl>
        </Disclosure>
      )}
      {r.actions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {r.actions.includes('apply') && <Button variant={primary ? 'primary' : 'secondary'} icon="upd" onPress={() => onAction(`Applying ${r.tag}`)}>Apply {r.tag}</Button>}
          {r.actions.includes('rollback') && <Button variant="secondary" icon="restart" onPress={() => onAction(`Rolling back to ${r.tag}`)}>Roll back to {r.tag}</Button>}
          {r.actions.includes('skip') && <Button variant="quiet" onPress={() => onAction(`Skipped ${r.tag}`)}>Skip</Button>}
        </div>
      )}
    </article>
  );
}

export function KitUpdates() {
  const avail = RELEASES.available;
  const say = (t: string) => toast(`${t} (fixture)`);
  const inst = RELEASES.installed;
  return (
    <KitScreen nav="/_kit/bots" header={<ScreenTitle>Updates</ScreenTitle>}>
      <div className="mx-4 px-4 py-3.5 rounded-card bg-surface shadow-1">
        <div className="text-sm text-text-2">Installed</div>
        <div className="mt-0.5 flex items-baseline gap-2">
          <span className="num text-xl font-semibold text-text">{inst.tag}</span>
          <span className="text-sm text-text-3">{inst.date}</span>
        </div>
        <p className="m-0 mt-1 text-ui text-text-2">{inst.summary}</p>
        <p className="m-0 mt-2 text-sm text-text-2">{inst.pin}</p>
      </div>
      <Section title="Newer" count={avail.length}>
        {avail.map((r, i) => <ReleaseBlock key={r.tag} r={r} primary={i === 0} onAction={say} />)}
      </Section>
      <Section title="History">
        {RELEASES.history.map((r) => <ReleaseBlock key={r.tag} r={r} onAction={say} />)}
      </Section>
      <div className="h-4" />
    </KitScreen>
  );
}
