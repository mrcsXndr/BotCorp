import { useState } from 'react';
import { Form } from 'react-aria-components';
import { useSecretSet, useSecrets, useSecretsLock, useUnlock, type Bot } from '../../api/queries';
import { Button, EmptyState, Hint, Skeleton, TextField, toast, useConfirm } from '../../ui';
import { COPY, t } from '../../lib/copy';
import { fmtWhen } from '../../lib/format';
import { Group } from './shared';

interface SecretRow { key: string; updatedAt?: string | null }
interface Lock { mode?: string; locked?: boolean }

// Secrets are write-only: the names and when each was set, never a value, not
// even masked. Replace and Add both write through PUT /secrets/:key; replacing
// a key that exists asks first.
export function SecretsTab({ bot }: { bot: Bot }) {
  const list = useSecrets(bot.name).data as unknown as SecretRow[] | undefined;
  const lock = useSecretsLock(bot.name).data as Lock | undefined;
  const set = useSecretSet();
  const unlock = useUnlock();
  const [confirmSheet, ask] = useConfirm();
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [pass, setPass] = useState('');

  const write = async (key: string, val: string, replacing: boolean): Promise<boolean> => {
    if (replacing) {
      const c = COPY.confirm.replaceSecret;
      if (!(await ask({ title: t(c.title, { key }), body: c.body, verb: c.verb, cancel: COPY.button.cancel }))) return false;
    }
    try { await set.mutateAsync({ name: bot.name, key, value: val }); toast(t(COPY.toast.secretSaved, { key }), 'ok'); return true; }
    catch (e) { toast((e as Error).message, 'bad'); return false; }
  };
  if (!list) return <Skeleton lines={4} />;
  const has = (k: string) => list.some((r) => r.key === k);
  const state = lock?.locked ? COPY.status.locked : lock?.mode && lock.mode !== 'none' ? COPY.status.unlocked : COPY.status.off;

  return (
    <div className="flex flex-col gap-6 pb-8" data-tab-panel="secrets">
      <Group>
        {list.length ? (
          <ul className="m-0 p-0 list-none flex flex-col">
            {list.map((r) => (
              <li key={r.key} data-secret={r.key} className="flex flex-col gap-2 py-1 shadow-[0_1px_0_var(--line)] last:shadow-none">
                <div className="flex items-center gap-2 min-h-[var(--tap)]">
                  <span className="flex-1 min-w-0 flex flex-col">
                    <span className="num text-ui text-text truncate">{r.key}</span>
                    {r.updatedAt && <span className="text-sm text-text-3">{fmtWhen(r.updatedAt)}</span>}
                  </span>
                  {editing !== r.key && <Button variant="quiet" icon="lock" onPress={() => { setEditing(r.key); setValue(''); }}>{COPY.button.replace}</Button>}
                </div>
                {editing === r.key && (
                  <Form className="flex flex-col gap-2 pb-2" onSubmit={async (e) => {
                    e.preventDefault();
                    if (value.trim() && (await write(r.key, value, true))) { setEditing(null); setValue(''); }
                  }}>
                    <TextField aria-label={t(COPY.row.replaceValue, { key: r.key })} type="password" autoComplete="off" autoFocus value={value} onChange={setValue} mono />
                    <div className="grid grid-cols-2 gap-2">
                      <Button type="submit" variant="secondary" isDisabled={!value.trim() || set.isPending}>{COPY.button.replace}</Button>
                      <Button variant="quiet" onPress={() => { setEditing(null); setValue(''); }}>{COPY.button.cancel}</Button>
                    </div>
                  </Form>
                )}
              </li>
            ))}
          </ul>
        ) : <EmptyState inline>{COPY.empty.noSecrets}</EmptyState>}
      </Group>

      <Form className="flex flex-col gap-3" onSubmit={async (e) => {
        e.preventDefault();
        const key = newKey.trim();
        if (key && newValue.trim() && (await write(key, newValue, has(key)))) { setNewKey(''); setNewValue(''); }
      }}>
        <TextField label={COPY.row.secretName} name="secret-key" value={newKey} onChange={(v) => setNewKey(v.toLowerCase())} autoComplete="off" mono />
        <TextField label={COPY.row.secretValue} name="secret-value" type="password" value={newValue} onChange={setNewValue} autoComplete="off" mono />
        <Button type="submit" variant="secondary" icon="plus" className="self-start" isDisabled={!newKey.trim() || !newValue.trim() || set.isPending}>{COPY.button.addSecret}</Button>
      </Form>

      <Group title={<>{COPY.row.lockPass}<Hint label={COPY.row.lockHint}>{COPY.tooltip.lock}</Hint></>}>
        <p data-lock-state className={`m-0 text-ui font-semibold ${lock?.locked ? 'text-warn' : 'text-text-2'}`}>{state}</p>
        {lock?.locked && (
          <Form className="flex flex-col gap-2" onSubmit={async (e) => {
            e.preventDefault();
            try { await unlock.mutateAsync({ name: bot.name, passphrase: pass }); setPass(''); toast(COPY.toast.unlocked, 'ok'); }
            catch (err) { toast((err as Error).message, 'bad'); }
          }}>
            <TextField aria-label={COPY.row.passphrase} type="password" autoComplete="off" value={pass} onChange={setPass} />
            <Button type="submit" variant="secondary" className="self-start" isDisabled={!pass || unlock.isPending}>{COPY.button.unlock}</Button>
          </Form>
        )}
      </Group>
      {confirmSheet}
    </div>
  );
}
