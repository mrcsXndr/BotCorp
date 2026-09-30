import { useState, type ReactNode } from 'react';
import { Form } from 'react-aria-components';
import { useNavigate } from 'react-router';
import { useAccounts, useCreateBot, useLifecycle, useSecretSet, type AccountView } from '../api/queries';
import { Button, EmptyState, Select, SelectItem, Sheet, Switch, TextField, toast } from '../ui';
import { mostHeadroom } from '../lib/bots';
import { COPY, t } from '../lib/copy';
import type { NewKind } from './layout';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// Create (POST /api/bots: never launches), then the Telegram token if one was
// given, then Start, then open the bot. Every new bot runs on a registered
// account; a chat is service: manual and named by the server.
function useCreateFlow(onDone: () => void) {
  const nav = useNavigate();
  const create = useCreateBot();
  const secret = useSecretSet();
  const lifecycle = useLifecycle();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (body: Parameters<typeof create.mutateAsync>[0], tgToken?: string) => {
    setError(''); setBusy(true);
    try {
      const r = await create.mutateAsync(body);
      if (!r.ok || !r.name) throw new Error(String(r.err || r.out || `exit ${r.code}`).trim());
      if (tgToken) await secret.mutateAsync({ name: r.name, key: 'telegram', value: tgToken });
      lifecycle.mutate({ name: r.name, action: 'start' }, { onError: (e) => toast(e.message, 'bad') });
      toast(t(COPY.toast.starting, { bot: r.name }));
      onDone();
      nav(`/bots/${encodeURIComponent(r.name)}`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return { run, error, busy };
}

function AccountSelect({ accounts, value, onChange }: { accounts: AccountView[]; value: string; onChange: (id: string) => void }) {
  return (
    <Select label={COPY.row.account} name="account" selectedKey={value || null} onSelectionChange={(k) => onChange(String(k))} items={accounts}>
      {(a: AccountView) => (
        <SelectItem id={a.id} textValue={a.label}>
          <span className="flex items-baseline gap-2 min-w-0">
            <span className="truncate">{a.label}</span>{a.plan && <span className="text-sm text-text-3 font-normal flex-none">{a.plan}</span>}
          </span>
        </SelectItem>
      )}
    </Select>
  );
}

function FormError({ children }: { children: string }) {
  return <p role="alert" data-form-error className="m-0 min-h-5 text-sm text-bad leading-ui break-words">{children}</p>;
}

// Accounts with a token only (a new bot never takes a typed token).
function useUsableAccounts() {
  const q = useAccounts();
  const list = (q.data?.accounts || []).filter((a) => a.state !== 'no-token');
  return { list, loading: !q.data };
}

function NewChatForm({ close }: { close: () => void }) {
  const { list, loading } = useUsableAccounts();
  const [picked, setPicked] = useState('');
  const account = picked || mostHeadroom(list) || list[0]?.id || '';
  const flow = useCreateFlow(close);
  if (!loading && !list.length) return <EmptyState>{COPY.empty.noAccounts}</EmptyState>;
  return (
    <Form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (account) flow.run({ account, service: 'manual' }); }}>
      <AccountSelect accounts={list} value={account} onChange={setPicked} />
      <FormError>{flow.error}</FormError>
      <Button type="submit" variant="primary" icon="new" block isDisabled={!account || flow.busy}>{COPY.button.startChat}</Button>
    </Form>
  );
}

function NewBotForm({ close }: { close: () => void }) {
  const { list, loading } = useUsableAccounts();
  const [name, setName] = useState('');
  const [persona, setPersona] = useState('');
  const [picked, setPicked] = useState('');
  const [telegram, setTelegram] = useState(false);
  const [token, setToken] = useState('');
  const [keep, setKeep] = useState(true);
  const account = picked || mostHeadroom(list) || list[0]?.id || '';
  const flow = useCreateFlow(close);
  const badName = !!name && !NAME_RE.test(name);
  if (!loading && !list.length) return <EmptyState>{COPY.empty.noAccounts}</EmptyState>;
  return (
    <Form className="flex flex-col gap-4" onSubmit={(e) => {
      e.preventDefault();
      if (!account || !name || badName) return;
      flow.run({ name, persona: persona.trim() || undefined, account, telegram, service: keep ? 'daemon' : 'manual' }, telegram ? token.trim() : undefined);
    }}>
      <TextField label={COPY.row.name} name="name" value={name} onChange={(v) => setName(v.toLowerCase())} isRequired autoComplete="off"
        isInvalid={badName} errorMessage={COPY.row.nameRule} />
      <TextField label={COPY.row.persona} name="persona" value={persona} onChange={setPersona} autoComplete="off" />
      <AccountSelect accounts={list} value={account} onChange={setPicked} />
      <Switch isSelected={keep} onChange={setKeep}>{COPY.row.keepRunning}</Switch>
      <Switch isSelected={telegram} onChange={setTelegram}>{COPY.row.telegram}</Switch>
      {telegram && <TextField label={COPY.row.telegramToken} name="telegram-token" type="password" value={token} onChange={setToken} autoComplete="off" mono />}
      <FormError>{flow.error}</FormError>
      <Button type="submit" variant="primary" icon="newbot" block isDisabled={!account || !name || badName || flow.busy}>{COPY.button.createBot}</Button>
    </Form>
  );
}

// New chat and New bot (IA §10 row 10): the two main actions' sheets.
export function NewSheets({ kind, onClose }: { kind: NewKind | null; onClose: () => void }) {
  let body: ReactNode = null;
  if (kind === 'chat') body = <NewChatForm close={onClose} />;
  if (kind === 'bot') body = <NewBotForm close={onClose} />;
  return (
    <Sheet isOpen={kind != null} onOpenChange={(o) => { if (!o) onClose(); }}
      title={kind === 'bot' ? COPY.title.newBot : COPY.title.newChat}>
      {body}
    </Sheet>
  );
}
