// The data layer against the server it talks to: ROUTES covers exactly the
// routes cockpit/server.mjs declares, http.ts reads errors and `need` the way
// the classic operatorApi did, and a read and a write hook hit the right URL.
import { test, expect, vi, afterEach } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import serverSrc from '../../../server.mjs?raw';
import { ROUTES, qk, useBots, useDecide } from './queries';
import { ApiError, fill, post, request, setNeedHandler } from './http';

test('ROUTES matches the routes server.mjs declares, one to one', () => {
  const declared = [...serverSrc.matchAll(/^app\.(get|post|put|delete|patch)\('([^']+)'/gm)]
    .map((m) => `${m[1].toUpperCase()} ${m[2]}`)
    .filter((r) => r !== 'GET /healthz' && r !== 'GET /classic');
  const ours = Object.values(ROUTES).map((r) => `${r.m} ${r.p}`);
  expect(declared.length).toBeGreaterThan(40);   // the scan itself found the table
  expect([...ours].sort()).toEqual([...declared].sort());
  expect(new Set(ours).size).toBe(ours.length);
});

test('fill: every param encoded; a missing one throws', () => {
  expect(fill(ROUTES.decide.p, { name: '_example', id: 'a1/b', decision: 'approve' })).toBe('/api/bots/_example/approvals/a1%2Fb/approve');
  expect(() => fill(ROUTES.bot.p, {})).toThrow(/:name/);
});

// ---- http ------------------------------------------------------------------------------
const calls: { url: string; init: RequestInit }[] = [];
function mockFetch(...responses: [number, unknown][]) {
  calls.length = 0;
  const queue = [...responses];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const [status, body] = queue.shift() ?? [500, {}];
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, statusText: status === 200 ? 'OK' : 'Err', headers: { 'content-type': 'application/json' } });
  }));
}
afterEach(() => { vi.unstubAllGlobals(); setNeedHandler(null); });

test('http: JSON body and same-origin credentials; the error is the route text, else the CLI text, else the status', async () => {
  mockFetch([200, { ok: true }], [400, { error: 'bad approval id or decision' }], [502, { ok: false, code: 1, out: '', err: 'send exited 1\n' }], [500, 'not json']);
  expect(await post('/api/x', { a: 1 })).toEqual({ ok: true });
  expect(calls[0].init).toMatchObject({ method: 'POST', body: '{"a":1}', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } });
  await expect(post('/api/x')).rejects.toThrow('bad approval id or decision');
  await expect(post('/api/x')).rejects.toThrow('send exited 1');
  await expect(post('/api/x')).rejects.toMatchObject({ status: 500, message: '500 Err' });
});

test('http: 403 need goes to the need handler; paired, the call runs once more', async () => {
  const need = { error: 'needs the operator', need: 'approve-token' };
  mockFetch([403, need], [200, { ok: true }]);
  const handler = vi.fn(async () => true);
  setNeedHandler(handler);
  expect(await post('/api/bots/_example/approvals/a1/approve')).toEqual({ ok: true });
  expect(handler).toHaveBeenCalledWith('approve-token', 'needs the operator');
  expect(calls).toHaveLength(2);

  // declined, or still refused after pairing: the error carries `need`, and there is no loop
  mockFetch([403, need]);
  setNeedHandler(async () => false);
  await expect(post('/api/x')).rejects.toMatchObject({ status: 403, need: 'approve-token' });
  mockFetch([403, need], [403, need], [403, need]);
  setNeedHandler(async () => true);
  const e = await post('/api/x').catch((x) => x);
  expect(e).toBeInstanceOf(ApiError);
  expect(calls).toHaveLength(2);
});

test('http: an upload sends the raw bytes with its name header', async () => {
  mockFetch([200, { id: 'x.png' }]);
  const blob = new Blob(['png']);
  await request('POST', '/api/bots/_example/uploads', { raw: { data: blob, headers: { 'X-File-Name': 'a%20b.png' } } });
  expect(calls[0].init.body).toBe(blob);
  expect(calls[0].init.headers).toEqual({ 'X-File-Name': 'a%20b.png' });
});

// ---- hooks -----------------------------------------------------------------------------
function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
}

test('useBots reads /api/bots; useDecide posts the decision and invalidates the approvals', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockFetch([200, [{ name: '_example' }]]);
  const bots = renderHook(() => useBots(), { wrapper: wrapper(client) });
  await waitFor(() => expect(bots.result.current.data).toEqual([{ name: '_example' }]));
  expect(calls[0].url).toBe('/api/bots');
  bots.unmount();

  const spy = vi.spyOn(client, 'invalidateQueries');
  mockFetch([200, { ok: true, code: 0 }]);
  const d = renderHook(() => useDecide(), { wrapper: wrapper(client) });
  await d.result.current.mutateAsync({ name: '_example', id: 'a1b2c3', decision: 'reject', reason: 'not now' });
  expect(calls[0].url).toBe('/api/bots/_example/approvals/a1b2c3/reject');
  expect(JSON.parse(String(calls[0].init.body))).toEqual({ reason: 'not now' });
  await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: qk.approvals() }));
});
