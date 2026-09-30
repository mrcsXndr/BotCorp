import { useAutomationAction, useAutomations, type Bot } from '../../api/queries';
import { Button, Disclosure, EmptyState, Skeleton, toast } from '../../ui';
import { COPY, t } from '../../lib/copy';
import { ago, autoStatus, triggerText, type AutoState } from '../../lib/settings';
import { Group } from './shared';

interface Declared { name: string; kind: string; trigger: unknown; enabled: boolean }
interface Run { automation: string; run_id?: string; start?: string; end?: string; exit?: number; summary?: string }
interface Payload { declared: Declared[]; state: Record<string, AutoState>; runs: Run[] }

const TONE = { bad: 'text-bad', ok: 'text-text-2', idle: 'text-text-3', warn: 'text-warn' } as const;

// A bot's automations: each row says when it runs next, or how it last went
// (Next / Last / Never / Failing), not a count. Run now and Pause are one tap;
// Resume waits for the operator like any change that widens the bot.
export function AutomationsTab({ bot }: { bot: Bot }) {
  const q = useAutomations(bot.name).data as unknown as Payload | undefined;
  const act = useAutomationAction();
  if (!q) return <Skeleton lines={4} />;
  const go = async (auto: string, action: 'run' | 'pause' | 'resume') => {
    try { await act.mutateAsync({ name: bot.name, auto, action }); if (action === 'run') toast(t(COPY.toast.ran, { name: auto }), 'ok'); }
    catch (e) { toast((e as Error).message, 'bad'); }
  };
  const runs = [...(q.runs || [])].reverse().slice(0, 12);
  return (
    <div className="flex flex-col gap-5 pb-8" data-tab-panel="automations">
      {q.declared.length ? (
        <ul className="m-0 p-0 list-none flex flex-col">
          {q.declared.map((a) => {
            const s = autoStatus(q.state[a.name], a.enabled);
            return (
              <li key={a.name} data-automation={a.name} className="flex items-center gap-2 py-2 shadow-[0_1px_0_var(--line)] last:shadow-none">
                <span className="flex-1 min-w-0 flex flex-col">
                  <span className="text-ui font-semibold text-text truncate">{a.name}</span>
                  <span data-status className={`text-sm ${TONE[s.tone]}`}>{a.enabled ? s.text : `${s.text} · ${COPY.status.paused}`}</span>
                  <span className="text-sm text-text-3">{triggerText(a.trigger)}</span>
                </span>
                <Button variant="quiet" isDisabled={act.isPending} onPress={() => go(a.name, 'run')}>{COPY.button.runNow}</Button>
                <Button variant="quiet" isDisabled={act.isPending} onPress={() => go(a.name, a.enabled ? 'pause' : 'resume')}>{a.enabled ? COPY.button.pause : COPY.button.resume}</Button>
              </li>
            );
          })}
        </ul>
      ) : <EmptyState>{COPY.empty.noAutomations}</EmptyState>}
      {runs.length > 0 && (
        <Group>
          <Disclosure title={COPY.row.recentRuns} meta={<span className="num">{runs.length}</span>}>
            <ul className="m-0 p-0 list-none flex flex-col gap-2">
              {runs.map((r, i) => (
                <li key={r.run_id || i} className="flex flex-col">
                  <span className="flex items-baseline gap-2 text-sm">
                    <span className="text-text font-semibold truncate">{r.automation}</span>
                    <span className={r.exit === 0 ? 'text-ok' : 'text-bad'}>{r.exit === 0 ? 'ok' : `exit ${r.exit}`}</span>
                    <span className="ml-auto flex-none text-text-3">{ago(r.end || r.start)}</span>
                  </span>
                  {r.summary && <span className="text-sm text-text-2 line-clamp-2">{r.summary}</span>}
                </li>
              ))}
            </ul>
          </Disclosure>
        </Group>
      )}
    </div>
  );
}
