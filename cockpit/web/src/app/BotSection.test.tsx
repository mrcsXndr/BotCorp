// The sidebar's subagent rows and the agent screen against a mocked server:
// only running subagents under their bot (type mark, name, model chip,
// elapsed), a tap opens the read-only agent screen, which lists the last
// finished ones.
import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BotSection } from './BotSection';
import { AgentScreen } from '../screens/bot/AgentScreen';
import { MotionRoot } from '../ui';

const BOT = { name: 'example', displayName: 'example', persona: '', model: 'top', kind: 'bg', running: true, phase: 'running', telegram: false, account: null, backups: [], service: 'daemon', automations: [], tools: null };
const ago = (min: number) => new Date(Date.now() - min * 60e3).toISOString();
const row = (id: string, name: string, state: string, extra = {}) => ({ id, name, type: 'coder', model: 'claude-sonnet-5-5', state, status: null, startedAt: ago(7), lastAt: ago(1), progress: null, background: true, depth: 1, parentId: null, workflow: null, ...extra });
const AGENTS = [{ bot: 'example', session: 's1', running: [row('a1b2c3', 'Build the parser', 'running')], recent: [row('d4e5f6', 'Read the logs', 'done', { type: 'Explore' })], workflows: [] }];
const DETAIL = { agent: row('a1b2c3', 'Build the parser', 'running'), cursor: 99, turns: [{ role: 'user', text: 'Build the parser.' }, { role: 'assistant', text: 'Reading the grammar.', tools: ['Read'] }] };

function serve() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const routes: Record<string, unknown> = { '/api/agents': AGENTS, '/api/bots/example/agents/a1b2c3': DETAIL };
    const body = routes[url];
    return new Response(JSON.stringify(body ?? { error: 'no route' }), { status: body ? 200 : 404, headers: { 'content-type': 'application/json' } });
  }));
}
afterEach(() => vi.unstubAllGlobals());

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}><MotionRoot>
      <MemoryRouter initialEntries={['/']}>
        <BotSection id="pinned" title="Pinned" bots={[BOT as never]} attention={{}} dense empty="none" />
        <Routes>
          <Route path="/" element={null} />
          <Route path="/bots/:name" element={null} />
          <Route path="/bots/:name/agents/:id" element={<AgentScreen />} />
        </Routes>
      </MemoryRouter>
    </MotionRoot></QueryClientProvider>,
  );
}

it('BotSection: one running subagent under its bot, with its model chip and elapsed time; no finished ones', async () => {
  serve();
  mount();
  const list = await screen.findByRole('list', { name: 'example subagent' });
  const rows = within(list).getAllByRole('link');
  expect(rows).toHaveLength(1);
  expect(rows[0].getAttribute('href')).toBe('/bots/example/agents/a1b2c3');
  expect(rows[0].textContent).toContain('Build the parser');
  expect(rows[0].querySelector('[data-model]')!.textContent).toBe('sonnet 5.5');
  expect(rows[0].querySelector('[data-elapsed]')!.textContent).toBe('7m');
  expect(document.body.textContent).not.toContain('Read the logs');
});

it('the agent screen: its turns read-only, and the last finished ones one tap away', async () => {
  serve();
  mount();
  await userEvent.click(await screen.findByRole('link', { name: /Build the parser/ }));
  await screen.findByText('Reading the grammar.');
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Build the parser');
  expect(screen.getByText('Running')).toBeTruthy();
  expect(document.querySelector('textarea, [contenteditable]'), 'no composer').toBeNull();
  const recent = await waitFor(() => { const r = document.querySelector('[data-recent=d4e5f6]'); if (!r) throw new Error('no recent'); return r; });
  expect(recent.textContent).toContain('Read the logs');
  expect(recent.textContent).toContain('Done');
});
