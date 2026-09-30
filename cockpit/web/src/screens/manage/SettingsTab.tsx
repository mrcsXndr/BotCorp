import { useEffect, useState } from 'react';
import { useAccounts, useBotConfig, useModels, type Bot, type ModelTier } from '../../api/queries';
import { Disclosure, Hint, Select, SelectItem, Skeleton, Switch, TextField } from '../../ui';
import { COPY } from '../../lib/copy';
import {
  SETTINGS, boardWrites, cfgGet, parseProjectLink, projectLinkOf, tierKey, type SettingDef, type Write,
} from '../../lib/settings';
import { ChainEditor, ChainTitle } from './ChainEditor';
import { Group, QueuedMark, useSetter, usePendingPaths } from './shared';

type Save = (...w: Write[]) => Promise<boolean>;

// Saves on blur or Enter, and only when the text changed. The draft follows
// the saved value when it changes from elsewhere.
function TextRow({ label, name, value, onSave, queued, invalid, error, grow }:
  { label: string; name: string; value: string; onSave: (v: string) => void; queued: boolean; invalid?: boolean; error?: string; grow?: boolean }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const commit = () => { if (draft.trim() !== value.trim()) onSave(draft.trim()); };
  return (
    <div className="flex flex-col gap-1.5" data-setting={name}>
      <TextField label={label} name={name} value={draft} onChange={setDraft} onBlur={commit} autoComplete="off"
        multiline={grow} autoGrow={grow} rows={2}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLElement).blur(); }} isInvalid={invalid} errorMessage={error} />
      {queued && <QueuedMark />}
    </div>
  );
}

function SwitchRow({ def, cfg, save, queued }: { def: SettingDef; cfg: unknown; save: Save; queued: boolean }) {
  const cur = cfgGet(cfg, def.path!);
  const on = def.on === true ? cur === true : cur === def.on;
  return (
    <div className="flex items-center gap-2" data-setting={def.id}>
      <Switch className="flex-1 min-w-0" isSelected={on} onChange={(v) => save({ path: def.path!, value: (v ? def.on : def.off) as Write['value'] })}>
        {COPY.row[def.label]}
      </Switch>
      {def.hint === 'admin' && <Hint label={COPY.row.adminHint}>{COPY.tooltip.admin}</Hint>}
      {queued && <QueuedMark />}
    </div>
  );
}

function ModelRow({ cfg, save, queued }: { cfg: unknown; save: Save; queued: boolean }) {
  const tiers = useModels().data;
  const cur = cfgGet(cfg, 'model');
  if (!tiers) return <Skeleton lines={1} />;
  return (
    <div className="flex flex-col gap-1.5" data-setting="model">
      <Select label={COPY.row.model} selectedKey={tierKey(cur, tiers)} placeholder={String(cur ?? '')} items={tiers}
        onSelectionChange={(k) => { if (k != null && k !== tierKey(cur, tiers)) save({ path: 'model', value: String(k) }); }}>
        {(m: ModelTier) => <SelectItem id={m.tier} textValue={m.name}>{m.name}</SelectItem>}
      </Select>
      {queued && <QueuedMark />}
    </div>
  );
}

function ProjectRow({ cfg, save, queued }: { cfg: unknown; save: Save; queued: boolean }) {
  const saved = projectLinkOf(cfg);
  const [bad, setBad] = useState(false);
  return (
    <TextRow label={COPY.row.projectLink} name="project" value={saved} queued={queued} invalid={bad} error={COPY.row.projectRule}
      onSave={(v) => {
        const link = parseProjectLink(v);
        setBad(!!v && !link);
        if (v && !link) return;
        save(...boardWrites(link));
      }} />
  );
}

/** A bot's Settings tab: the curated table (IA §4), Advanced folded away. */
export function SettingsTab({ bot }: { bot: Bot }) {
  const cfgQ = useBotConfig(bot.name);
  const accounts = useAccounts().data?.accounts;
  const pending = usePendingPaths(bot.name);
  const save = useSetter(bot.name);
  const cfg = cfgQ.data?.config;
  if (!cfg || !accounts) return <Skeleton lines={5} />;
  const queuedOf = (paths: (string | undefined)[]) => paths.some((p) => p && pending.has(p));
  const rows = (section: SettingDef['section']) => SETTINGS.filter((d) => d.section === section && (!d.when || d.when(cfg, bot)));
  const render = (d: SettingDef) => {
    if (d.kind === 'chain') {
      return (
        <Group key={d.id} title={<ChainTitle />}>
          <ChainEditor bot={bot} accounts={accounts} />
          {bot.telegram && <SwitchRow def={{ id: 'failover', section: 'main', kind: 'switch', label: 'tellMe', path: 'failover_notify', on: true, off: false }}
            cfg={cfg} save={save} queued={queuedOf(['failover_notify'])} />}
        </Group>
      );
    }
    if (d.kind === 'model') return <ModelRow key={d.id} cfg={cfg} save={save} queued={queuedOf(['model'])} />;
    if (d.kind === 'project') return <ProjectRow key={d.id} cfg={cfg} save={save} queued={queuedOf(['integrations.board.owner', 'harness.modules.board'])} />;
    if (d.kind === 'switch') return <SwitchRow key={d.id} def={d} cfg={cfg} save={save} queued={queuedOf([d.path])} />;
    if (d.kind === 'diagnostics') {
      return (
        <div key={d.id} className="flex flex-col gap-1" data-setting="diagnostics">
          <span className="text-sm font-semibold text-text-2">{COPY.row.diagnostics}</span>
          <dl className="m-0 flex items-baseline gap-3 text-sm">
            <dt className="text-text-3">{COPY.row.folder}</dt>
            <dd className="m-0 num min-w-0 break-all text-text-2">{String(bot.home ?? '')}</dd>
          </dl>
        </div>
      );
    }
    return (
      <TextRow key={d.id} label={COPY.row[d.label]} name={d.id} grow={d.id === 'persona'} value={String(cfgGet(cfg, d.path!) ?? '')}
        queued={queuedOf([d.path])} onSave={(v) => save({ path: d.path!, value: v === '' ? null : v }, ...(d.also ? d.also(v) : []))} />
    );
  };
  return (
    <div className="flex flex-col gap-5 pb-8" data-tab-panel="settings">
      {rows('main').map(render)}
      <Disclosure title={COPY.row.advanced}>
        <div className="flex flex-col gap-4 pt-1">{rows('advanced').map(render)}</div>
      </Disclosure>
    </div>
  );
}
