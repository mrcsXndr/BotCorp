import { useState } from 'react';
import { Form } from 'react-aria-components';
import { Link } from 'react-router';
import { useAccountAdd, useAccountRemove, useAccountRename, useAccounts, type AccountView } from '../../api/queries';
import { AnimatedItems, Button, EmptyState, Hint, ListItem, Menu, MenuItem, Meter, Sheet, SkeletonRow, TextField, toast, useConfirm } from '../../ui';
import { ScreenHeader } from '../../app/ScreenHeader';
import { FormError } from '../manage/shared';
import { hasReading, maskedText, newAccountId, roleText, stateView, windowView } from '../../lib/accounts';
import { COPY, t } from '../../lib/copy';

type Row = AccountView & { plan_source?: string | null; blocked_until?: string | null; used_by?: { bot: string; role: string; order: number }[] };
const TONE = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad', idle: 'text-text-3' } as const;

function AccountRow({ a, onRename, onRemove }: { a: Row; onRename: (id: string, label: string) => Promise<string | null>; onRemove: (a: Row) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(a.label);
  const [error, setError] = useState('');
  const s = stateView(a);
  const five = windowView(a.fiveHour), seven = windowView(a.sevenDay);
  const save = async () => {
    if (!draft.trim() || draft.trim() === a.label) { setEditing(false); return; }
    const err = await onRename(a.id, draft.trim());
    if (err) setError(err); else { setEditing(false); setError(''); }
  };
  return (
    <article data-account={a.id} className="rounded-card bg-task p-4 flex flex-col gap-3">
      <header className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          {editing ? (
            <Form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); save(); }}>
              <TextField aria-label={COPY.row.label} name="label" value={draft} onChange={setDraft} autoFocus autoComplete="off" />
              <FormError>{error}</FormError>
              <div className="grid grid-cols-2 gap-2">
                <Button type="submit" variant="secondary">{COPY.button.save}</Button>
                <Button variant="quiet" onPress={() => { setEditing(false); setDraft(a.label); setError(''); }}>{COPY.button.cancel}</Button>
              </div>
            </Form>
          ) : (
            <>
              <h2 className="m-0 font-display text-lg leading-tight text-text truncate">{a.label}</h2>
              <p className="m-0 mt-0.5 flex items-baseline gap-2 text-sm">
                <span data-state className={`font-semibold ${TONE[s.tone]}`}>{s.word}</span>
                {a.plan && <span data-plan className="text-text-2">{a.plan}</span>}
                {a.masked && <span className="num text-text-3">{maskedText(a.masked)}</span>}
              </p>
            </>
          )}
        </div>
        {!editing && (
          <Menu label={t(COPY.row.accountMenu, { name: a.label })} onAction={(k) => { if (k === 'rename') { setDraft(a.label); setEditing(true); } else onRemove(a); }}>
            <MenuItem id="rename" icon="set">{COPY.button.rename}</MenuItem>
            <MenuItem id="remove" icon="x" tone="bad">{COPY.button.removeAccount}</MenuItem>
          </Menu>
        )}
      </header>
      {hasReading(a.fiveHour) || hasReading(a.sevenDay) ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Meter label={COPY.row.fiveHour} value={five.value} valueLabel={five.text} detail={five.detail} />
          <Meter label={COPY.row.sevenDay} value={seven.value} valueLabel={seven.text} detail={seven.detail} />
        </div>
      ) : <p data-no-usage className="m-0 text-sm text-text-3">{COPY.empty.noUsage}</p>}
      {!!a.used_by?.length && (
        <div className="flex flex-col">
          <h3 className="m-0 mb-0.5 text-sm font-semibold text-text-2">{COPY.row.usedBy}</h3>
          <ul className="m-0 -mx-2 p-0 list-none flex flex-col">
            {a.used_by.map((u) => (
              <li key={`${u.bot}/${u.role}`}>
                <Link to={`/bots/${encodeURIComponent(u.bot)}/manage/settings`} data-used-by={u.bot}
                  className="flex items-baseline justify-between gap-3 min-h-10 px-2 py-2 rounded-btn text-ui text-text no-underline outline-none
                    transition-colors duration-[var(--t-fast)] ease-std hover:bg-hover active:bg-press focus-visible:outline-2 focus-visible:outline-accent">
                  <span className="min-w-0 truncate">{u.bot}</span>{' '}<span className="flex-none text-sm text-text-3">{roleText(u)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

// Add: a label and the setup token; the id follows the label and the plan is
// detected by the server (never a field). The token travels once, in the body.
function AddSheet({ taken, isOpen, onClose }: { taken: string[]; isOpen: boolean; onClose: () => void }) {
  const add = useAccountAdd();
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const close = () => { onClose(); setLabel(''); setToken(''); setError(''); };
  return (
    <Sheet isOpen={isOpen} onOpenChange={(o) => { if (!o) close(); }} title={COPY.title.addAccount}>
      <Form className="flex flex-col gap-4" onSubmit={async (e) => {
        e.preventDefault();
        setError('');
        const id = newAccountId(label, token, taken);
        try {
          await add.mutateAsync({ id, label: label.trim() || undefined, token: token.trim() });
          toast(t(COPY.toast.accountAdded, { name: label.trim() || id }), 'ok');
          close();
        } catch (err) { setError((err as Error).message); }
      }}>
        <TextField label={COPY.row.label} name="label" value={label} onChange={setLabel} autoComplete="off" />
        <div className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1 text-sm font-semibold text-text">{COPY.row.setupToken}<Hint label={COPY.row.setupHint}>{COPY.tooltip.setupToken}</Hint></span>
          <TextField aria-label={COPY.row.setupToken} name="token" type="password" value={token} onChange={setToken} autoComplete="off" mono />
        </div>
        <FormError>{error}</FormError>
        <Button type="submit" variant="primary" icon="plus" block isDisabled={!token.trim() || add.isPending}>{COPY.button.addAccount}</Button>
      </Form>
    </Sheet>
  );
}

// Accounts and Usage in one page (IA §3): every login, its plan when it is
// known, its state, its 5 h and 7 d meters and the bots that use it.
export function AccountsScreen() {
  const q = useAccounts();
  const rename = useAccountRename();
  const remove = useAccountRemove();
  const [adding, setAdding] = useState(false);
  const [confirmSheet, ask] = useConfirm();
  const accounts = (q.data?.accounts || []) as Row[];
  const doRename = async (id: string, label: string): Promise<string | null> => {
    try { await rename.mutateAsync({ id, label }); toast(COPY.toast.renamed, 'ok'); return null; }
    catch (e) { return (e as Error).message; }
  };
  const doRemove = async (a: Row) => {
    const c = COPY.confirm.removeAccount;
    if (!(await ask({ title: t(c.title, { account: a.label }), body: c.body, verb: c.verb, cancel: COPY.button.cancel }))) return;
    try { await remove.mutateAsync({ id: a.id }); toast(t(COPY.toast.accountRemoved, { name: a.label }), 'ok'); }
    catch (e) { toast((e as Error).message, 'bad'); }
  };
  return (
    <div className="mx-auto w-full max-w-[720px] pb-6">
      <ScreenHeader count={q.data ? accounts.length : undefined}
        right={<Button variant="primary" icon="plus" onPress={() => setAdding(true)}>{COPY.button.addAccount}</Button>}>{COPY.title.accounts}</ScreenHeader>
      {!q.data ? <><SkeletonRow /><SkeletonRow /></>
        : !accounts.length ? <EmptyState>{COPY.empty.noAccounts}</EmptyState>
        : (
          <ul className="m-0 px-4 py-0 list-none flex flex-col gap-3" data-accounts>
            <AnimatedItems>
              {accounts.map((a) => <ListItem key={a.id}><AccountRow a={a} onRename={doRename} onRemove={doRemove} /></ListItem>)}
            </AnimatedItems>
          </ul>
        )}
      <AddSheet taken={accounts.map((a) => a.id)} isOpen={adding} onClose={() => setAdding(false)} />
      {confirmSheet}
    </div>
  );
}
