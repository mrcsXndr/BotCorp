import { useEffect, useState } from 'react';
import { useBotAccounts, type AccountView, type Bot } from '../../api/queries';
import { Button, Hint, IconButton, Select, SelectItem, toast, useConfirm } from '../../ui';
import { CHAIN_MAX, chainBody, chainOf, moveItem, sameChain } from '../../lib/settings';
import { COPY, t } from '../../lib/copy';

// A bot's account chain as ONE ordered list of Accounts: position 1 is the
// primary, the rest are the backups tried in order when a limit hits (at most
// 6). Saved in one POST. There is no "own token": every entry is an account.
export function ChainEditor({ bot, accounts }: { bot: Bot; accounts: AccountView[] }) {
  const saved = chainOf(bot);
  const [chain, setChain] = useState<string[]>(saved);
  const savedKey = saved.join(',');
  useEffect(() => { setChain(saved); }, [savedKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  const post = useBotAccounts();
  const [confirmSheet, ask] = useConfirm();
  const label = (id: string) => accounts.find((a) => a.id === id)?.label || id;
  const spare = accounts.filter((a) => a.state !== 'no-token' && !chain.includes(a.id));
  const changed = !sameChain(chain, saved);

  const save = async () => {
    const primaryChanged = chain[0] !== saved[0];
    const c = primaryChanged ? COPY.confirm.primary : COPY.confirm.chain;
    const ok = await ask({
      title: t(c.title, { bot: bot.name, account: label(chain[0]) }), body: c.body, verb: c.verb, cancel: COPY.button.cancel,
    });
    if (!ok) return;
    try {
      await post.mutateAsync({ name: bot.name, ...chainBody(chain) });
      toast(COPY.toast.chainSaved, 'ok');
    } catch (e) { toast((e as Error).message, 'bad'); }
  };

  return (
    <div className="flex flex-col gap-2" data-chain>
      <ol className="m-0 p-0 list-none flex flex-col">
        {chain.map((id, i) => (
          <li key={id} data-chain-item={id} className="flex items-center gap-1 min-h-[var(--tap)] shadow-[0_1px_0_var(--line)] last:shadow-none">
            <span className="num w-6 text-center text-sm text-text-3" aria-label={t(COPY.row.position, { n: i + 1 })}>{i + 1}</span>
            <span className="flex-1 min-w-0 flex flex-col">
              <span className="truncate text-ui text-text leading-ui">{label(id)}</span>
              <span data-chain-role className="text-sm text-text-3 leading-ui">{i === 0 ? COPY.row.primaryTag : COPY.row.backupTag}</span>
            </span>
            {chain.length > 1 && <>
              <IconButton icon="chev" className="rotate-180" label={t(COPY.row.moveUp, { name: label(id) })} isDisabled={i === 0} onPress={() => setChain(moveItem(chain, i, i - 1))} />
              <IconButton icon="chev" label={t(COPY.row.moveDown, { name: label(id) })} isDisabled={i === chain.length - 1} onPress={() => setChain(moveItem(chain, i, i + 1))} />
              <IconButton icon="x" label={t(COPY.row.removeFrom, { name: label(id) })} onPress={() => setChain(chain.filter((x) => x !== id))} />
            </>}
          </li>
        ))}
      </ol>
      {chain.length < CHAIN_MAX && spare.length > 0 && (
        <Select aria-label={COPY.row.addBackup} placeholder={COPY.row.addBackup} selectedKey={null} items={spare}
          onSelectionChange={(k) => { if (k != null) setChain([...chain, String(k)]); }}>
          {(a: AccountView) => <SelectItem id={a.id} textValue={a.label}>{a.label}</SelectItem>}
        </Select>
      )}
      {changed && chain.length > 0 && (
        <Button variant="secondary" icon="check" className="self-start" isDisabled={post.isPending} onPress={save}>{COPY.button.saveBackups}</Button>
      )}
      {confirmSheet}
    </div>
  );
}

export function ChainTitle() {
  return (
    <span className="inline-flex items-center gap-1">
      {COPY.row.chain}<Hint label={COPY.row.backupsHint}>{COPY.tooltip.backups}</Hint>
    </span>
  );
}
