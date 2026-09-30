import { useEffect, useState } from 'react';
import { Header, ListBoxSection } from 'react-aria-components';
import { useAccounts, useBotConfig, useHelpers, useModels, useUsage, type Bot, type LiveModel, type ModelTier } from '../../api/queries';
import { Disclosure, Hint, Select, SelectItem, Skeleton, Switch, TextField, useConfirm } from '../../ui';
import { COPY, t } from '../../lib/copy';
import {
  SETTINGS, ago, boardWrites, cfgGet, effortChoices, liveModelOf, liveOptions, modelKey, needsRestart, parseProjectLink, priceText,
  projectLinkOf, resolvedId, type SettingDef, type Write,
} from '../../lib/settings';
import { ChainEditor, ChainTitle } from './ChainEditor';
import { Chip, Group, QueuedMark, useSetter, usePendingPaths } from './shared';

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

const HINT_LABEL = { admin: COPY.row.adminHint, backups: COPY.row.backupsHint, autoFix: COPY.row.autoFixHint, debrief: COPY.row.debriefHint } as const;

function SwitchRow({ def, cfg, save, queued, bot }: { def: SettingDef; cfg: unknown; save: Save; queued: boolean; bot?: Bot }) {
  const cur = cfgGet(cfg, def.path!);
  const on = def.on === true ? cur === true : cur === def.on;
  const row = (
    <div className="flex items-center gap-2" data-setting={def.id}>
      <Switch className="flex-1 min-w-0" isSelected={on} onChange={(v) => save({ path: def.path!, value: (v ? def.on : def.off) as Write['value'] })}>
        {COPY.row[def.label]}
      </Switch>
      {def.hint && <Hint label={HINT_LABEL[def.hint]}>{COPY.tooltip[def.hint]}</Hint>}
      {queued && <QueuedMark />}
    </div>
  );
  if (!def.detail || !bot) return row;
  return <div className="flex flex-col gap-2">{row}<HelperDetail bot={bot} which={def.detail} /></div>;
}

// Model, then effort and ultracode for that model. Tiers first, then what the
// pinned Claude Code offers (a live model saves its resolved id). Effort lists
// only the model's own levels; ultracode shows only where the model has it.
function ModelRows({ bot, cfg, save, queuedOf }: { bot: Bot; cfg: unknown; save: Save; queuedOf: (p: string[]) => boolean }) {
  const models = useModels().data;
  const usage = useUsage().data;
  const [sheet, ask] = useConfirm();
  if (!models) return <Skeleton lines={1} />;
  const { tiers } = models;
  const live = liveOptions(models.models);
  const cur = cfgGet(cfg, 'model');
  const key = modelKey(cur, tiers, live);
  const lm = liveModelOf(cur, tiers, live);
  const effort = cfgGet(cfg, 'effort');
  const ultracode = cfgGet(cfg, 'ultracode') === true;
  const reading = (usage?.bots || []).find((r) => r.bot === bot.name) as Parameters<typeof needsRestart>[0];
  const restart = bot.running && needsRestart(reading, { model: resolvedId(cur, tiers, models.models), effort: typeof effort === 'string' ? effort : null });
  const levels = lm ? lm.supportedEffortLevels : [];
  const choices = effortChoices(levels, effort);
  const pick = (k: string) => {
    if (k === key) return;
    const m = k.startsWith('live:') ? live.find((x) => `live:${x.value}` === k) : null;
    save({ path: 'model', value: m ? m.resolvedModel : k });
  };
  const setUltracode = async (on: boolean) => {
    if (on) {
      const c = COPY.confirm.ultracode;
      if (!(await ask({ title: c.title, body: c.body, verb: c.verb, cancel: COPY.button.cancel, safe: true }))) return;
    }
    save({ path: 'ultracode', value: on });
  };
  return (
    <>
      <div className="flex flex-col gap-1.5" data-setting="model">
        <Select label={COPY.row.model} selectedKey={key} placeholder={String(cur ?? '')} onSelectionChange={(k) => { if (k != null) pick(String(k)); }}>
          {tiers.map((m: ModelTier) => <SelectItem key={m.tier} id={m.tier} textValue={m.name}>{m.name}</SelectItem>)}
          {live.length > 0 && (
            <ListBoxSection>
              <Header className="px-3 pt-2 pb-1 text-sm font-semibold text-text-3">{t(COPY.row.liveModels, { version: models.cc_version ?? '' })}</Header>
              {live.map((m: LiveModel) => (
                <SelectItem key={m.value} id={`live:${m.value}`} textValue={m.displayName}>
                  <span className="flex items-baseline gap-2"><span className="truncate">{m.displayName}</span>{m.price && <span className="num text-sm text-text-3">{priceText(m.price)}</span>}</span>
                </SelectItem>
              ))}
            </ListBoxSection>
          )}
        </Select>
        <div className="flex flex-wrap items-center gap-2">
          {queuedOf(['model']) && <QueuedMark />}
          {restart && <Chip icon="restart" tone="warn">{COPY.status.restartToApply}</Chip>}
        </div>
      </div>
      {(levels.length > 0 || typeof effort === 'string') && (
        <div className="flex flex-col gap-1.5" data-setting="effort">
          <Select label={COPY.row.effort} selectedKey={typeof effort === 'string' ? effort : ''}
            onSelectionChange={(k) => { const v = String(k ?? ''); if (v !== (typeof effort === 'string' ? effort : '')) save({ path: 'effort', value: v || null }); }}>
            {choices.map((e) => <SelectItem key={e || 'default'} id={e} textValue={e || COPY.row.tierDefault}>{e || COPY.row.tierDefault}</SelectItem>)}
          </Select>
          {queuedOf(['effort']) && <QueuedMark />}
        </div>
      )}
      {(lm?.ultracodeAvailable === true || ultracode) && (
        <div className="flex items-center gap-2" data-setting="ultracode">
          <Switch className="flex-1 min-w-0" isSelected={ultracode} onChange={(v) => { void setUltracode(v); }}>{COPY.row.ultracode}</Switch>
          {queuedOf(['ultracode']) && <QueuedMark />}
        </div>
      )}
      {sheet}
    </>
  );
}

// What a background helper does, under its switch: a sub-label, then its facts.
function HelperDetail({ bot, which }: { bot: Bot; which: 'autoFix' | 'debrief' }) {
  const h = useHelpers(bot.name).data?.[which];
  const tiers = useModels().data?.tiers || [];
  if (!h) return null;
  const every = 'everyMin' in h ? t(COPY.row.everyMin, { n: h.everyMin }) : t(COPY.row.everyHours, { n: h.everyHours });
  const model = tiers.find((x) => x.id === h.model)?.name ?? h.model;
  const writes = h.writes.includes('/') ? t(COPY.row.writesTo, { file: h.writes }) : h.writes;
  return (
    <div className="flex flex-col gap-2 pl-0.5" data-helper={which}>
      <p className="m-0 text-sm text-text-2 leading-ui">{which === 'autoFix' ? COPY.module.alert_triage : COPY.module.debrief}</p>
      <div className="flex flex-wrap gap-1.5">
        <Chip icon="clock">{every}</Chip>
        {model && <Chip mono>{model}</Chip>}
        <Chip icon="doc">{writes}</Chip>
        <Chip>{h.lastRun ? t(COPY.row.lastRun, { ago: ago(h.lastRun) }) : COPY.row.notRunYet}</Chip>
        {h.on && 'fed' in h && !h.fed && <Chip icon="warn" tone="warn">{COPY.status.nothingFeeds}</Chip>}
      </div>
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
          {bot.telegram && <SwitchRow def={{ id: 'failover', section: 'main', kind: 'switch', label: 'tellMe', path: 'harness.failover_notify', on: true, off: false }}
            cfg={cfg} save={save} queued={queuedOf(['harness.failover_notify'])} />}
        </Group>
      );
    }
    if (d.kind === 'model') return <ModelRows key={d.id} bot={bot} cfg={cfg} save={save} queuedOf={queuedOf} />;
    if (d.kind === 'project') return <ProjectRow key={d.id} cfg={cfg} save={save} queued={queuedOf(['integrations.board.owner', 'harness.modules.board'])} />;
    if (d.kind === 'switch') return <SwitchRow key={d.id} def={d} cfg={cfg} save={save} queued={queuedOf([d.path])} bot={bot} />;
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
