import { useMemo, useState } from 'react';
import { useBotConfig, useInventory, useToolRegister, useToolRetire, useTools, type Bot } from '../../api/queries';
import { Button, EmptyState, Segment, Segmented, Skeleton, Switch, TextField, toast, useConfirm } from '../../ui';
import { Icon } from '../../icons';
import { COPY, t } from '../../lib/copy';
import { HIDDEN_TOOLS, TOOL_KIND, itemPath, toolWrite, type ToolFilter, type ToolItem } from '../../lib/settings';
import { Group, QueuedMark, usePendingPaths, useSetter } from './shared';

interface Section { kind: string; label: string; items: ToolItem[] }
interface InvGroup { source: 'harness' | 'bot' | 'third'; label: string; license: string; sections: Section[] }
interface Proposal { name: string; path: string; kind: 'cli' | 'monitor' | 'integration' | 'lib'; purpose?: string; secrets?: string[] }
interface Scan { registry: string; missing: string[]; registered: { name: string; path: string }[]; proposal: { tools: Proposal[]; orphans: (string | { path: string })[] } }

function ToolRow({ item, queued, onToggle }: { item: ToolItem; queued: boolean; onToggle: (on: boolean) => void }) {
  const text = item.kind === 'module' ? (COPY.module as Record<string, string>)[item.name] ?? item.description : item.description;
  const body = (
    <span className="block">
      <span className="flex items-baseline gap-2">
        <span className="text-ui font-semibold text-text break-all">{item.name}</span>
        <span className="text-sm text-text-3 flex-none">{TOOL_KIND[item.kind] || item.kind}</span>
      </span>
      {text && <span className="block text-sm leading-ui text-text-2 line-clamp-2">{text}</span>}
      {item.locked && <span className="mt-1 flex items-center gap-1.5 text-sm text-text-2"><Icon name="lock" size={14} />{COPY.status.alwaysOn}</span>}
      {item.missing && <span className="mt-1 flex items-center gap-1.5 text-sm text-warn"><Icon name="warn" size={14} />{COPY.status.missing}</span>}
    </span>
  );
  if (!item.toggle) return <div className="py-2.5" data-locked={item.locked ? '' : undefined}>{body}</div>;
  return (
    <div className="flex items-center gap-2">
      <Switch className="flex-1 min-w-0 py-1.5" isSelected={item.on} isDisabled={queued} onChange={onToggle} aria-label={item.name}>{body}</Switch>
      {queued && <QueuedMark />}
    </div>
  );
}

function RegistryPanel({ bot, scan, refetch }: { bot: Bot; scan: Scan; refetch: () => Promise<unknown> }) {
  const register = useToolRegister();
  const retire = useToolRetire();
  const [confirmSheet, ask] = useConfirm();
  const off = scan.registry === 'off';
  const orphanPath = (o: string | { path: string }) => (typeof o === 'string' ? o : o.path);
  const doRetire = async (target: string) => {
    const c = COPY.confirm.retire;
    if (!(await ask({ title: t(c.title, { tool: target }), body: c.body, verb: c.verb, cancel: COPY.button.cancel }))) return;
    try { await retire.mutateAsync({ name: bot.name, target }); toast(t(COPY.toast.retired, { tool: target }), 'ok'); }
    catch (e) { toast((e as Error).message, 'bad'); }
  };
  const doRegister = async (p: Proposal) => {
    try { await register.mutateAsync({ name: bot.name, tool: p.name, path: p.path, kind: p.kind, purpose: p.purpose, secrets: p.secrets }); toast(t(COPY.toast.registered, { tool: p.name }), 'ok'); }
    catch (e) { toast((e as Error).message, 'bad'); }
  };
  if (off) {
    return (
      <Group title={COPY.row.registry}>
        <EmptyState inline action={<Button variant="secondary" onPress={async () => { await refetch(); toast(t(COPY.toast.found, { n: scan.proposal.tools.length }), 'ok'); }}>{COPY.button.scan}</Button>}>
          {COPY.empty.noToolList}
        </EmptyState>
      </Group>
    );
  }
  const orphans = scan.proposal.orphans.map(orphanPath);
  const missing = scan.registered.filter((r) => scan.missing.includes(r.name));
  if (!scan.proposal.tools.length && !orphans.length && !missing.length) return null;
  return (
    <Group title={<>{COPY.row.registry}</>}>
      {(scan.proposal.tools.length > 0 || orphans.length > 0) && (
        <ul className="m-0 p-0 list-none flex flex-col" data-unregistered>
          {scan.proposal.tools.map((p) => (
            <li key={p.path} className="flex items-center gap-2 py-2">
              <span className="flex-1 min-w-0 flex flex-col"><span className="num text-sm text-text break-all">{p.path}</span><span className="text-sm text-text-3">{COPY.row.unregistered} · {p.kind}</span></span>
              <Button variant="tonal" isDisabled={register.isPending} onPress={() => doRegister(p)}>{COPY.button.register}</Button>
              {!p.path.includes('*') && <Button variant="danger" onPress={() => doRetire(p.path)}>{COPY.button.retire}</Button>}
            </li>
          ))}
          {orphans.map((p) => (
            <li key={p} className="flex items-center gap-2 py-2">
              <span className="flex-1 min-w-0 flex flex-col"><span className="num text-sm text-text break-all">{p}</span><span className="text-sm text-text-3">{COPY.row.unregistered}</span></span>
              <Button variant="danger" onPress={() => doRetire(p)}>{COPY.button.retire}</Button>
            </li>
          ))}
        </ul>
      )}
      {missing.length > 0 && (
        <ul className="m-0 p-0 list-none flex flex-col" data-missing>
          {missing.map((r) => (
            <li key={r.name} className="flex items-center gap-2 py-2">
              <span className="flex-1 min-w-0 flex flex-col"><span className="text-ui font-semibold text-text">{r.name}</span><span className="text-sm text-warn">{COPY.status.missing}</span></span>
              <Button variant="danger" onPress={() => doRetire(r.name)}>{COPY.button.removeEntry}</Button>
            </li>
          ))}
        </ul>
      )}
      {confirmSheet}
    </Group>
  );
}

// A bot's Tools tab: every harness, own and third-party tool with a switch, or
// a lock where a switch is refused; a switch that widens the bot queues its
// approval inline. Then the registry: what is unregistered or missing.
export function ToolsTab({ bot }: { bot: Bot }) {
  const inv = useInventory(bot.name).data as unknown as { groups: InvGroup[] } | undefined;
  const scanQ = useTools(bot.name);
  const cfg = useBotConfig(bot.name).data?.config;
  const pending = usePendingPaths(bot.name);
  const save = useSetter(bot.name);
  const [filter, setFilter] = useState<ToolFilter>('all');
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const groups = useMemo(() => (inv?.groups || [])
    .filter((g) => filter === 'all' || g.source === filter)
    .map((g) => ({
      ...g,
      sections: g.sections
        .map((s) => ({ ...s, items: s.items.filter((i) => !HIDDEN_TOOLS.has(i.id) && (!needle || `${i.name} ${i.description || ''}`.toLowerCase().includes(needle))) }))
        .filter((s) => s.items.length),
    }))
    .filter((g) => g.sections.length), [inv, filter, needle]);
  if (!inv || !cfg) return <Skeleton lines={6} />;
  const toggle = (item: ToolItem, on: boolean) => {
    const w = toolWrite(item, on, cfg);
    if (w) save(w);
  };
  return (
    <div className="flex flex-col gap-4 pb-8" data-tab-panel="tools">
      <Segmented aria-label={COPY.row.filter} value={filter} onChange={(k) => setFilter(k as ToolFilter)} className="w-full">
        <Segment id="all">{COPY.row.all}</Segment>
        <Segment id="harness">{COPY.row.harness}</Segment>
        <Segment id="bot">{COPY.row.own}</Segment>
        <Segment id="third">{COPY.row.thirdParty}</Segment>
      </Segmented>
      <TextField aria-label={COPY.row.searchTools} placeholder={COPY.row.searchTools} type="search" value={q} onChange={setQ} />
      {!groups.length && <EmptyState>{COPY.empty.noToolMatch}</EmptyState>}
      {groups.map((g) => (
        <section key={g.source} data-tool-group={g.source} className="flex flex-col gap-1">
          <h2 className="m-0 text-sm font-semibold text-text">{g.label}</h2>
          {g.sections.map((s) => (
            <div key={`${s.kind}:${s.label}`} className="flex flex-col">
              <h3 className="m-0 pt-2 pb-0.5 text-sm font-normal text-text-3">{s.label}</h3>
              <ul className="m-0 p-0 list-none">
                {s.items.map((i) => (
                  <li key={i.id} data-tool={i.id}><ToolRow item={i} queued={pending.has(itemPath(i) || '')} onToggle={(on) => toggle(i, on)} /></li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
      {scanQ.data && <RegistryPanel bot={bot} scan={scanQ.data as unknown as Scan} refetch={scanQ.refetch} />}
    </div>
  );
}
