import { useSessions } from '../../api/queries';
import { EmptyState, Sheet, Skeleton } from '../../ui';
import { fmtWhen } from '../../lib/format';
import { COPY } from '../../lib/copy';

// The bot's past conversations, newest first: when, and how each began. No ids.
export function SessionHistorySheet({ bot, isOpen, onClose }: { bot: string; isOpen: boolean; onClose: () => void }) {
  const sessions = useSessions(isOpen ? bot : '');
  const rows = (sessions.data || []) as { id: string; mtime?: number; preview?: string }[];
  return (
    <Sheet isOpen={isOpen} onOpenChange={(o) => { if (!o) onClose(); }} title={COPY.title.history}>
      {!sessions.data ? <Skeleton lines={4} />
        : !rows.length ? <EmptyState>{COPY.empty.noSessions}</EmptyState>
        : (
          <ul className="m-0 p-0 list-none flex flex-col">
            {rows.map((s) => (
              <li key={s.id} className="flex flex-col gap-0.5 py-2.5 shadow-[0_1px_0_var(--line)] last:shadow-none">
                <span className="num text-xs text-text-3">{fmtWhen(s.mtime)}</span>
                <span className="text-ui text-text line-clamp-2">{s.preview || '…'}</span>
              </li>
            ))}
          </ul>
        )}
    </Sheet>
  );
}
