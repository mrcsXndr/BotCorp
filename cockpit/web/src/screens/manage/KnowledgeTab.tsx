import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  useBotKnowledge, useBotKnowledgeDoc, useKnowledge, useKnowledgeDoc, useKnowledgeRemove, useKnowledgeSave,
  type Bot, type KnowledgeRow,
} from '../../api/queries';
import { ApiError } from '../../api/http';
import { Button, EmptyState, Segment, Segmented, Skeleton, TextField, toast, useConfirm } from '../../ui';
import { Icon } from '../../icons';
import { COPY, t } from '../../lib/copy';
import { renderMarkdown } from '../../lib/md';
import { ago } from '../../lib/settings';
import { Chip, Group } from './shared';

// A new doc's id; CLAUDE is the bot's main file and already exists.
export const NEW_DOC_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
// Past this, every start pays for it: the list says so.
export const TOKENS_WARN = 20000;

function DocRows({ docs, onOpen }: { docs: KnowledgeRow[]; onOpen?: (id: string) => void }) {
  return (
    <ul className="m-0 p-0 list-none flex flex-col" data-docs>
      {docs.map((d) => {
        const body = (
          <>
            <Icon name="doc" className="flex-none text-text-2" />
            <span className="flex-1 min-w-0 truncate text-ui text-text">{d.id}</span>
            <span className="num text-sm text-text-2">{t(COPY.row.tokensEst, { n: d.tokens.toLocaleString('en-US') })}</span>
            <span className="hidden sm:inline text-sm text-text-3 w-28 text-right">{t(COPY.row.edited, { ago: ago(d.updated_at) })}</span>
          </>
        );
        return (
          <li key={d.id} data-doc={d.id}>
            {onOpen
              ? <button type="button" onClick={() => onOpen(d.id)} className="flex items-center gap-3 w-full min-h-[var(--tap)] px-2 -mx-2 rounded-btn bg-transparent border-0 text-left cursor-default outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent">{body}</button>
              : <div className="flex items-center gap-3 min-h-[var(--tap)] px-2 -mx-2">{body}</div>}
          </li>
        );
      })}
    </ul>
  );
}

const total = (docs: KnowledgeRow[]) => docs.reduce((n, d) => n + d.tokens, 0);
function TotalChip({ docs }: { docs: KnowledgeRow[] }) {
  const n = total(docs);
  if (!docs.length) return null;
  return n > TOKENS_WARN
    ? <Chip icon="warn" tone="warn">{COPY.status.tooBig}</Chip>
    : <Chip mono>{t(COPY.row.tokensEst, { n: n.toLocaleString('en-US') })}</Chip>;
}

// One doc, open: Edit (a tall mono field) or Preview, Save with the sha it was
// read at (a doc changed since is refused and reloaded), Delete for any doc
// but the bot's CLAUDE.md. `doc` null = a new doc, named here.
function Editor({ bot, doc, onClose }: { bot: string | null; doc: string | null; onClose: () => void }) {
  const botQ = useBotKnowledgeDoc(bot || '', bot ? doc : null);
  const globalQ = useKnowledgeDoc(bot ? null : doc);
  const q = bot ? botQ : globalQ;
  const save = useKnowledgeSave();
  const remove = useKnowledgeRemove();
  const [confirmSheet, ask] = useConfirm();
  const [draft, setDraft] = useState('');
  const [name, setName] = useState('');
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const loaded = q.data;
  useEffect(() => { if (loaded) setDraft(loaded.content); }, [loaded]);
  if (doc && !loaded) return q.isError ? <EmptyState>{(q.error as Error).message}</EmptyState> : <Skeleton lines={6} />;
  const id = doc ?? name.trim();
  const badName = !doc && !!name && !NEW_DOC_RE.test(name.trim());
  const dirty = doc ? draft !== loaded!.content : !!draft;
  const onSave = async () => {
    try {
      await save.mutateAsync({ bot, doc: id, content: draft, ifMatch: loaded?.sha256 ?? null });
      toast(t(COPY.toast.docSaved, { doc: id }), 'ok');
      if (!doc) onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { toast(COPY.toast.docConflict, 'bad'); const r = await q.refetch(); if (r.data) setDraft(r.data.content); return; }
      toast((e as Error).message, 'bad');
    }
  };
  const onDelete = async () => {
    const c = COPY.confirm.deleteDoc;
    if (!(await ask({ title: t(c.title, { doc: id }), body: c.body, verb: c.verb, cancel: COPY.button.cancel }))) return;
    try { await remove.mutateAsync({ bot, doc: id }); toast(t(COPY.toast.docDeleted, { doc: id }), 'ok'); onClose(); }
    catch (e) { toast((e as Error).message, 'bad'); }
  };
  return (
    <div className="flex flex-col gap-3" data-editor={doc ?? 'new'}>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onClose} aria-label={COPY.button.back}
          className="grid place-items-center size-[var(--tap)] -ml-3 flex-none rounded-btn bg-transparent border-0 text-text-2 outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent">
          <Icon name="chev" size={18} className="rotate-90" />
        </button>
        <h2 className="m-0 flex-1 min-w-0 truncate text-ui font-semibold text-text">{doc ?? COPY.title.newDoc}</h2>
        <Segmented aria-label={COPY.button.preview} value={view} onChange={(k) => setView(k as 'edit' | 'preview')}>
          <Segment id="edit">{COPY.button.edit}</Segment>
          <Segment id="preview">{COPY.button.preview}</Segment>
        </Segmented>
      </div>
      {!doc && (
        <TextField label={COPY.row.docName} name="doc" value={name} onChange={setName} autoComplete="off"
          isInvalid={badName} errorMessage={COPY.row.docRule} description={COPY.row.docRule} />
      )}
      {view === 'edit'
        ? <TextField aria-label={COPY.row.docText} name="content" value={draft} onChange={setDraft} multiline mono rows={22} />
        : <div className="md min-h-[40dvh] px-1" data-preview dangerouslySetInnerHTML={{ __html: renderMarkdown(draft) }} />}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" isDisabled={!dirty || !id || badName || save.isPending} onPress={onSave}>{doc ? COPY.button.save : COPY.button.createDoc}</Button>
        <span className="flex-1 text-sm text-text-3">{COPY.status.loadsNextStart}</span>
        {doc && !(bot && doc === 'CLAUDE') && <Button variant="danger" onPress={onDelete}>{COPY.button.deleteDoc}</Button>}
      </div>
      {confirmSheet}
    </div>
  );
}

/** The docs of one scope: a list, or one of them open in the editor. `bot` null = All bots. */
export function KnowledgePanel({ bot }: { bot: string | null }) {
  const botQ = useBotKnowledge(bot || '');
  const globalQ = useKnowledge();
  const q = bot ? botQ : globalQ;
  const [open, setOpen] = useState<string | null | undefined>(undefined);   // undefined = the list; null = a new doc
  if (open !== undefined) return <Editor key={open ?? '+new'} bot={bot} doc={open} onClose={() => setOpen(undefined)} />;
  if (!q.data) return q.isError ? <EmptyState inline>{(q.error as Error).message}</EmptyState> : <Skeleton lines={3} />;
  const docs = q.data.docs;
  return (
    <div className="flex flex-col gap-2">
      {docs.length ? <DocRows docs={docs} onOpen={setOpen} /> : <EmptyState inline>{COPY.empty.noDocs}</EmptyState>}
      <div className="flex flex-wrap items-center gap-2">
        <Button icon="plus" onPress={() => setOpen(null)}>{COPY.button.newDoc}</Button>
        <TotalChip docs={docs} />
      </div>
    </div>
  );
}

// A bot's Knowledge tab: what it loads at start. "All bots" is read-only here
// (the operator edits it in Settings); "This bot" is its CLAUDE.md and rules.
export function KnowledgeTab({ bot }: { bot: Bot }) {
  const all = useKnowledge().data?.docs;
  return (
    <div className="flex flex-col gap-6 pb-8" data-tab-panel="knowledge">
      <Group title={COPY.row.thisBot}>
        <KnowledgePanel bot={bot.name} />
      </Group>
      <Group title={COPY.row.allBots} extra={<span className="text-sm font-normal text-text-3">{COPY.status.readOnlyHere}</span>}>
        {!all ? <Skeleton lines={2} /> : all.length ? <DocRows docs={all} /> : <EmptyState inline>{COPY.empty.noDocs}</EmptyState>}
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/settings" className="inline-flex items-center gap-2 min-h-[var(--tap)] text-ui font-semibold text-accent no-underline outline-none rounded-btn hover:underline focus-visible:outline-2 focus-visible:outline-accent">
            {COPY.button.editIn}
          </Link>
          {all && <TotalChip docs={all} />}
        </div>
      </Group>
    </div>
  );
}
