import { Link, useParams } from 'react-router';
import { useAgent, useAgents, type AgentRow } from '../../api/queries';
import { EmptyState, Skeleton } from '../../ui';
import { Icon } from '../../icons';
import { agentIcon, elapsed, shortModel } from '../../lib/agents';
import { ago } from '../../lib/settings';
import { COPY } from '../../lib/copy';
import { ChatView } from './ChatView';

const STATE: Record<AgentRow['state'], [string, string]> = {
  running: [COPY.status.running, 'text-accent'],
  done: [COPY.status.done, 'text-ok'],
  'done?': [COPY.status.doneMaybe, 'text-text-2'],
  ended: [COPY.status.ended, 'text-text-3'],
};

// `#/bots/:name/agents/:id`: one subagent of a bot's live session, read-only:
// what it was asked, its type, model and state, then its turns in the chat
// renderer (no composer). Polled while it runs. Under it, the bot's last 10
// finished subagents, one tap each.
export function AgentScreen() {
  const { name = '', id = '' } = useParams();
  const roster = useAgents().data?.find((r) => r.bot === name);
  const listed = [...(roster?.running || []), ...(roster?.recent || [])].find((a) => a.id === id);
  const q = useAgent(name, id, !listed || listed.state === 'running');
  const agent = q.data?.agent ?? listed ?? null;
  const back = `/bots/${encodeURIComponent(name)}`;
  if (q.isError && !q.data) return <EmptyState className="min-h-[60dvh]">{COPY.empty.noAgent}</EmptyState>;
  const st = agent ? STATE[agent.state] : null;
  const chat = { loaded: !!q.data, available: true, reason: '', hasSession: true, turns: q.data?.turns || [], file: null, cursor: q.data?.cursor || 0, epoch: 0 };
  const recent = (roster?.recent || []).filter((a) => a.id !== id);
  return (
    <div className="h-full flex flex-col" data-agent-screen={id}>
      <header className="flex-none flex items-center gap-1 px-1 pt-[max(8px,env(safe-area-inset-top))]">
        <Link to={back} aria-label={COPY.button.back}
          className="grid place-items-center size-[var(--tap)] flex-none rounded-btn text-text-2 outline-none hover:bg-hover active:bg-press focus-visible:outline-2 focus-visible:outline-accent">
          <Icon name="chev" size={18} className="rotate-90" />
        </Link>
        <h1 className="m-0 flex-1 min-w-0 truncate text-body font-semibold leading-tight text-text">{agent?.name || agent?.type || id}</h1>
      </header>
      {agent ? (
        <div className="flex-none flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-2 text-sm">
          {st && <span className={`font-semibold ${st[1]}`}>{st[0]}</span>}
          <span className="inline-flex items-center gap-1.5 text-text-2"><Icon name={agentIcon(agent.type)} size={14} />{agent.type}</span>
          {agent.model && <span className="px-1.5 rounded-xs bg-task text-xs text-text-2">{shortModel(agent.model)}</span>}
          {agent.startedAt && <span className="num text-text-3">{agent.state === 'running' ? elapsed(agent.startedAt) : ago(agent.lastAt || agent.startedAt)}</span>}
        </div>
      ) : <div className="px-4"><Skeleton lines={1} /></div>}
      <ChatView chat={chat} sent={[]} />
      {recent.length > 0 && (
        <section className="flex-none max-h-[30dvh] overflow-y-auto px-4 py-2 shadow-[0_-1px_0_var(--line)]" aria-label={COPY.row.recentAgents}>
          <h2 className="m-0 pb-1 text-sm font-semibold text-text-2">{COPY.row.recentAgents}</h2>
          <ul className="m-0 p-0 list-none flex flex-col">
            {recent.map((a) => (
              <li key={a.id}>
                <Link to={`${back}/agents/${encodeURIComponent(a.id)}`} data-recent={a.id}
                  className="flex items-center gap-2 min-h-[36px] px-2 -mx-2 rounded-btn no-underline text-text-2 outline-none hover:bg-hover hover:text-text focus-visible:outline-2 focus-visible:outline-accent">
                  <Icon name={agentIcon(a.type)} size={14} className="flex-none text-text-3" />
                  <span className="flex-1 min-w-0 truncate text-sm">{a.name || a.type}</span>
                  <span className={`flex-none text-xs ${STATE[a.state][1]}`}>{STATE[a.state][0]}</span>
                  <span className="num flex-none w-16 text-right text-xs text-text-3">{ago(a.lastAt || a.startedAt || '')}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
