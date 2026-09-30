import { useBotConfig, useTgDeny, useTgPair, useTgPairing, type Bot } from '../../api/queries';
import { Button, EmptyState, Radio, RadioGroup, Skeleton, Switch, toast, useConfirm } from '../../ui';
import { COPY } from '../../lib/copy';
import { ago, cfgGet } from '../../lib/settings';
import { Group, QueuedMark, usePendingPaths, useSetter } from './shared';

interface Pairing { present?: boolean; dmPolicy?: string | null; allowFrom?: string[]; pending?: { senderId: string; ageS: number }[] }

// Telegram, per bot: the module switch, who may message it, who is waiting
// to pair. Pair and Deny are one tap (no confirm).
export function TelegramTab({ bot }: { bot: Bot }) {
  const cfg = useBotConfig(bot.name).data?.config;
  const pairing = useTgPairing(bot.name).data as Pairing | undefined;
  const pending = usePendingPaths(bot.name);
  const save = useSetter(bot.name);
  const pair = useTgPair();
  const deny = useTgDeny();
  const [confirmSheet, ask] = useConfirm();
  if (!cfg) return <Skeleton lines={4} />;
  const on = cfgGet(cfg, 'harness.modules.telegram') === true;
  const policy = String(cfgGet(cfg, 'integrations.telegram.dm_policy') ?? 'pairing');
  const act = async (fn: typeof pair, senderId: string, done: string) => {
    try { await fn.mutateAsync({ name: bot.name, senderId }); toast(done, 'ok'); } catch (e) { toast((e as Error).message, 'bad'); }
  };
  // anything here can cut the bot off from Telegram: ask first, the change waits for the verb
  const confirmed = (c: { title: string; body: string; verb: string }) =>
    ask({ title: c.title, body: c.body, verb: c.verb, cancel: COPY.button.cancel });
  return (
    <div className="flex flex-col gap-5 pb-8" data-tab-panel="telegram">
      {confirmSheet}
      <div className="flex items-center gap-2">
        <Switch className="flex-1 min-w-0" isSelected={on}
          onChange={async (v) => { if (await confirmed(COPY.confirm.telegram)) save({ path: 'harness.modules.telegram', value: v }); }}>{COPY.tab.telegram}</Switch>
        {pending.has('harness.modules.telegram') && <QueuedMark />}
      </div>
      {on && (
        <>
          <RadioGroup label={COPY.row.whoCanMessage} appearance="segmented" value={policy}
            onChange={async (v) => { if (v !== policy && await confirmed(COPY.confirm.telegram)) save({ path: 'integrations.telegram.dm_policy', value: v }); }}>
            <Radio value="pairing">{COPY.row.paired}</Radio>
            <Radio value="allowlist">{COPY.row.onlyListed}</Radio>
            <Radio value="disabled">{COPY.row.nobody}</Radio>
          </RadioGroup>
          {pending.has('integrations.telegram.dm_policy') && <QueuedMark />}
          <Group title={<>{COPY.row.waitingToPair}<span className="num font-normal text-text-3">{pairing?.pending?.length ?? 0}</span></>}>
            {pairing?.pending?.length ? (
              <ul className="m-0 p-0 list-none flex flex-col">
                {pairing.pending.map((p) => (
                  <li key={p.senderId} data-pending={p.senderId} className="flex items-center gap-2 min-h-[var(--tap)] py-1">
                    <span className="flex-1 min-w-0 flex flex-col">
                      <span className="num text-ui text-text">{p.senderId}</span>
                      <span className="text-sm text-text-3">{ago(new Date(Date.now() - p.ageS * 1000).toISOString())}</span>
                    </span>
                    <Button variant="tonal" icon="check" isDisabled={pair.isPending} onPress={async () => { if (await confirmed(COPY.confirm.pairSender)) act(pair, p.senderId, COPY.toast.paired); }}>{COPY.button.pair}</Button>
                    <Button variant="quiet" isDisabled={deny.isPending} onPress={() => act(deny, p.senderId, COPY.toast.denied)}>{COPY.button.deny}</Button>
                  </li>
                ))}
              </ul>
            ) : <EmptyState inline>{COPY.empty.nobodyWaiting}</EmptyState>}
          </Group>
          {!!pairing?.allowFrom?.length && (
            <Group title={<>{COPY.row.allowedSenders}<span className="num font-normal text-text-3">{pairing.allowFrom.length}</span></>}>
              <p className="m-0 num text-sm text-text-2 break-words">{pairing.allowFrom.join(' · ')}</p>
            </Group>
          )}
        </>
      )}
    </div>
  );
}
