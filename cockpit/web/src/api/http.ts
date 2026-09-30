// Same-origin fetch for the cockpit API. The server (cockpit/server.mjs) gates
// every /api call on the session cookie the page load minted, so there is no
// proxy and no token here: the browser sends the cookie, and a paired
// browser's operator cookie too.
//
// An operator-gated route answers 403 {need: 'approve-token'} on a loopback
// cockpit whose browser is not paired yet. That goes to the need handler (the
// PairSheet): when it resolves true the browser now holds the operator cookie
// and the request runs once more; otherwise the call fails with the server's text.

export class ApiError extends Error {
  status: number;
  need: string | null;
  body: unknown;
  constructor(message: string, status: number, need: string | null, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.need = need;
    this.body = body;
  }
}

export type NeedHandler = (need: string, message: string) => Promise<boolean>;
let needHandler: NeedHandler | null = null;
// One handler at a time (the app shell mounts the PairSheet); returns the unregister.
export function setNeedHandler(fn: NeedHandler | null): () => void {
  needHandler = fn;
  return () => { if (needHandler === fn) needHandler = null; };
}

// The same handler for a caller that is not a fetch: the terminal socket, refused with 4403.
export function askNeed(need: string, message: string): Promise<boolean> {
  return needHandler ? needHandler(need, message) : Promise.resolve(false);
}

type Json = Record<string, unknown>;
// The message a failed call shows: the route's `error`, else the CLI's err/out
// (lifecycle and decision routes answer {ok:false, code, out, err}), else the status.
function errorText(res: Response, data: Json): string {
  if (typeof data.error === 'string' && data.error) return data.error;
  const cli = String(data.err || data.out || '').trim();
  return cli || `${res.status} ${res.statusText}`.trim();
}

export interface RequestOptions {
  body?: unknown;                    // JSON-encoded
  raw?: { data: Blob | ArrayBuffer; headers: Record<string, string> };   // uploads: the bytes as the body
  signal?: AbortSignal;
  as?: 'json' | 'blob';
}

export async function request<T = unknown>(method: string, url: string, opts: RequestOptions = {}, retried = false): Promise<T> {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (opts.raw) { Object.assign(headers, opts.raw.headers); body = opts.raw.data; }
  else if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
  const res = await fetch(url, { method, headers, body, credentials: 'same-origin', signal: opts.signal });
  if (res.ok && opts.as === 'blob') return (await res.blob()) as T;
  const data = (await res.json().catch(() => ({}))) as Json;
  if (res.ok) return data as T;
  const need = typeof data.need === 'string' ? data.need : null;
  const message = errorText(res, data);
  if (res.status === 403 && need && !retried && needHandler && await needHandler(need, message)) {
    return request<T>(method, url, opts, true);
  }
  throw new ApiError(message, res.status, need, data);
}

export const get = <T = unknown>(url: string, signal?: AbortSignal) => request<T>('GET', url, { signal });
export const post = <T = unknown>(url: string, body?: unknown) => request<T>('POST', url, { body: body ?? {} });
export const put = <T = unknown>(url: string, body?: unknown) => request<T>('PUT', url, { body: body ?? {} });
export const del = <T = unknown>(url: string) => request<T>('DELETE', url);

// A route pattern with its :params filled in, each one URI-encoded.
export function fill(pattern: string, params: Record<string, string> = {}): string {
  return pattern.replace(/:([A-Za-z]+)/g, (_m, k: string) => {
    if (!(k in params)) throw new Error(`missing route param :${k} for ${pattern}`);
    return encodeURIComponent(params[k]);
  });
}
