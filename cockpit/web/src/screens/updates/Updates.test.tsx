// Updates against a mocked /api/updates: the order releaseView() gave, one
// primary, Roll back only in History behind its confirm, and no build id.
import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UpdatesScreen } from './UpdatesScreen';
import { MotionRoot, ToastRegion } from '../../ui';
import { primaryTag, releaseStatus, scrub } from '../../lib/updates';

const day = (n: number) => new Date(Date.now() - n * 864e5).toISOString();
const REL = (tag: string, extra: object = {}) => ({ tag, sha: 'deadbeef0f00', date: day(1), status: 'pending', summary: `Summary of ${tag}.`, notes: [{ title: 'What changed', text: `Notes for ${tag} at commit 3fa9c2e1.` }], actions: [], ...extra });
const UPDATES = {
  installed: '0.9.0',
  current: REL('v0.9.0', { status: 'applied', view: 'installed', actions: [] }),
  available: [REL('v0.10.0', { view: 'available', actions: ['apply', 'skip'] }), REL('v0.9.1', { view: 'comes_with', included_in: 'v0.10.0', actions: ['apply'] })],
  history: [REL('v0.8.5', { view: 'history', status: 'applied', actions: ['rollback'] })],
  releases: [],
};

type Call = { method: string; url: string; body: unknown };
const calls: Call[] = [];
function serve() {
  calls.length = 0;
  const routes: Record<string, [number, unknown]> = {
    'GET /api/updates': [200, UPDATES], 'GET /api/cockpit': [200, { exposure: 'access', cc: { pinned: '2.3.1', candidate: { version: '2.3.2', status: 'rejected' } } }],
    'POST /api/updates/v0.8.5/rollback': [200, { ok: true, code: 0 }], 'POST /api/updates/v0.10.0/apply': [200, { ok: true, code: 0 }],
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const [status, out] = routes[`${method} ${url}`] ?? [404, { error: `no route ${method} ${url}` }];
    return new Response(JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } });
  }));
}
afterEach(() => vi.unstubAllGlobals());
const writes = () => calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.url, c.body]);
const confirmDialog = () => waitFor(() => { const d = document.querySelector<HTMLElement>('.sheet [role=alertdialog]'); if (!d) throw new Error('no confirm'); return d; });
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><MotionRoot><MemoryRouter><UpdatesScreen /></MemoryRouter><ToastRegion /></MotionRoot></QueryClientProvider>);
}

it('cards in releaseView order; one primary; no build id, no transport word', async () => {
  serve();
  mount();
  await screen.findByText('v0.10.0');
  const order = [...document.querySelectorAll('[data-release]')].map((e) => (e as HTMLElement).dataset.release);
  expect(order).toEqual(['v0.10.0', 'v0.9.1', 'v0.8.5']);
  expect(document.querySelectorAll('[data-variant=primary]')).toHaveLength(1);
  expect(document.querySelector('[data-variant=primary]')!.textContent).toBe('Apply v0.10.0');
  const text = document.body.textContent || '';
  expect(text).not.toMatch(/\b[0-9a-f]{7,8}\b|via\s*access|loopback/i);
  expect(text).toContain('comes with v0.10.0');
  expect(document.querySelector('[data-engine]')!.textContent).toBe('Engine · Claude Code 2.3.1');
  expect(text).not.toMatch(/2\.3\.2|rejected|canary/i);   // a held-back candidate is an Inbox item, not this page
});

it('Roll back exists only in History and asks first', async () => {
  serve();
  mount();
  await screen.findByText('v0.10.0');
  const all = screen.getAllByRole('button', { name: 'Roll back', hidden: true });   // folded away, still in the page
  expect(all).toHaveLength(1);
  expect(all[0].closest('[data-history]')).not.toBeNull();
  await userEvent.click(screen.getByRole('button', { name: /^History/ }));   // expand the fold
  await userEvent.click(screen.getByRole('button', { name: 'Roll back' }));
  const dialog = await confirmDialog();
  expect(within(dialog).getByText('Bots switch at their next pause.')).toBeTruthy();
  expect(writes()).toEqual([]);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Roll back' }));
  await waitFor(() => expect(writes()).toEqual([['POST', '/api/updates/v0.8.5/rollback', {}]]));
});

it('Apply asks first too', async () => {
  serve();
  mount();
  await userEvent.click(await screen.findByRole('button', { name: 'Apply v0.10.0' }));
  const dialog = await confirmDialog();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Apply v0.10.0' }));
  await waitFor(() => expect(writes()).toEqual([['POST', '/api/updates/v0.10.0/apply', {}]]));
});

it('helpers: scrub drops build ids only; the primary is the first applicable', () => {
  expect(scrub('Fixed in 3fa9c2e1 and shipped')).toBe('Fixed in and shipped');
  expect(scrub('Version 2026 build 1234567 of v0.9.0 ships deadbeef')).toBe('Version 2026 build of v0.9.0 ships');
  expect(primaryTag([{ tag: 'a', actions: [] }, { tag: 'b', actions: ['apply'] }, { tag: 'c', actions: ['apply'] }])).toBe('b');
  expect(releaseStatus({ tag: 'x', view: 'failed', fail_reason: 'candidate abcdef12 rejected: check 3' })).toEqual({ text: 'failed', tone: 'bad' });
});
