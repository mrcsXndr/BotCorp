// New chat / New bot against a mocked server: the request bodies POST
// /api/bots receives, the Telegram token going to the vault before Start,
// and a refusal landing in the form's error region.
import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NewSheets } from './NewSheets';

const ACCOUNTS = { accounts: [
  { id: 'studio', label: 'Studio', plan: 'Max 20×', masked: '****St01', state: 'ok', fiveHour: { pct: 60 }, sevenDay: { pct: 20 } },
  { id: 'spare', label: 'Spare', plan: '', masked: '****Sp02', state: 'ok', fiveHour: { pct: 5 }, sevenDay: { pct: 10 } },
  { id: 'empty', label: 'Empty', plan: '', masked: null, state: 'no-token', fiveHour: null, sevenDay: null },
], bots: [] };

type Call = { method: string; url: string; body: unknown };
const calls: Call[] = [];
function serve(routes: Record<string, [number, unknown]>) {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const [status, body] = routes[`${method} ${url}`] ?? [404, { error: 'no route' }];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }));
}
afterEach(() => vi.unstubAllGlobals());

function mount(kind: 'chat' | 'bot') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<NewSheets kind={kind} onClose={onClose} />} />
          <Route path="/bots/:name" element={<p>opened bot</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return onClose;
}
const writes = () => calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.url, c.body]);

it('New chat: the account with the most headroom, service manual, then Start and open it', async () => {
  serve({
    'GET /api/accounts': [200, ACCOUNTS],
    'POST /api/bots': [200, { ok: true, name: 'chat-0930-1200', code: 0 }],
    'POST /api/bots/chat-0930-1200/start': [200, { ok: true, code: 0 }],
  });
  const onClose = mount('chat');
  await userEvent.click(await screen.findByRole('button', { name: 'Start chat' }));
  await screen.findByText('opened bot');
  expect(onClose).toHaveBeenCalled();
  await waitFor(() => expect(writes()).toEqual([
    ['POST', '/api/bots', { account: 'spare', service: 'manual' }],
    ['POST', '/api/bots/chat-0930-1200/start', { fresh: false }],
  ]));
});

it('New bot: Keep running = daemon; the Telegram token goes to the vault before Start', async () => {
  serve({
    'GET /api/accounts': [200, ACCOUNTS],
    'POST /api/bots': [200, { ok: true, name: 'wren', code: 0 }],
    'PUT /api/bots/wren/secrets/telegram': [200, { ok: true }],
    'POST /api/bots/wren/start': [200, { ok: true, code: 0 }],
  });
  mount('bot');
  await userEvent.type(await screen.findByRole('textbox', { name: 'Name' }), 'wren');
  await userEvent.type(screen.getByRole('textbox', { name: 'Persona' }), 'Quiet and exact.');
  await userEvent.click(screen.getByRole('switch', { name: 'Telegram' }));
  await userEvent.type(screen.getByLabelText('Telegram token'), '123:abc');
  await userEvent.click(screen.getByRole('button', { name: 'Create bot' }));
  await screen.findByText('opened bot');
  await waitFor(() => expect(writes()).toEqual([
    ['POST', '/api/bots', { name: 'wren', persona: 'Quiet and exact.', account: 'spare', telegram: true, service: 'daemon' }],
    ['PUT', '/api/bots/wren/secrets/telegram', { value: '123:abc' }],
    ['POST', '/api/bots/wren/start', { fresh: false }],
  ]));
});

it('a refusal shows the server text in the form error region and opens nothing', async () => {
  serve({
    'GET /api/accounts': [200, ACCOUNTS],
    'POST /api/bots': [409, { ok: false, code: 2, err: 'new: no account with a token' }],
  });
  mount('chat');
  await userEvent.click(await screen.findByRole('button', { name: 'Start chat' }));
  await waitFor(() => expect(document.querySelector('[data-form-error]')!.textContent).toBe('new: no account with a token'));
  expect(screen.queryByText('opened bot')).toBeNull();
  expect(writes()).toHaveLength(1);
});
