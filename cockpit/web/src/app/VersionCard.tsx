import { Link } from 'react-router';
import { useUpdates } from '../api/queries';
import { hasUpdate } from '../lib/bots';
import { COPY, t } from '../lib/copy';
import { Icon } from '../icons';

/** The BotCorp mark: the gauge from the favicon, in the accent. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg data-logo viewBox="0 -1.5 32 32" width={size} height={size} aria-hidden className="flex-none text-accent">
      <path d="M7.5 24.5a12 12 0 1 1 17 0M16 18l5.5-7" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" />
      <circle cx="16" cy="18" r="2.6" fill="currentColor" />
    </svg>
  );
}

// The top of the sidebar (the phone's Bots header): the mark, the name and
// the installed version; "Update" with its icon when a newer release
// can be applied. Opens Updates. Never a commit or a transport word.
export function VersionCard() {
  const { data } = useUpdates();
  const version = data?.installed ? `v${String(data.installed).replace(/^v/, '')}` : '';
  const update = hasUpdate(data as { available?: { actions?: string[] }[] } | undefined);
  return (
    <Link to="/updates" data-version-card aria-label={t(COPY.row.version, { version })}
      className="flex items-center gap-3 min-h-14 px-3 py-2 rounded-card no-underline text-text outline-none
        transition-colors duration-[var(--t-fast)] ease-std hover:bg-hover active:bg-press
        focus-visible:outline-2 focus-visible:outline-accent">
      <Logo />
      <span className="flex-1 min-w-0 flex flex-col">
        <span className="font-display text-lg leading-tight">{COPY.row.brand}</span>
        <span className="num text-xs leading-ui text-text-3">{version || ' '}</span>
      </span>
      {update && (
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent">
          <Icon name="upd" />{COPY.button.update}
        </span>
      )}
    </Link>
  );
}
