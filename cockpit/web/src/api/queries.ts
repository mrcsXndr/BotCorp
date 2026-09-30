// One react-query hook per cockpit/server.mjs route. ROUTES is the table the
// hooks build their URLs from; src/api/queries.test.ts checks it against the
// routes server.mjs declares, so a route added there without a hook here fails.
//
// Reads poll only where the classic UI polled; writes invalidate what they
// change. Every response shape is the server's; the types name the fields the
// screens read and leave the rest open.
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { del, fill, get, post, put, request } from './http';
import type { ChatTurn, StatusPush } from './ws';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const r = (m: Method, p: string) => ({ m, p }) as const;

export const ROUTES = {
  accessSelftest: r('GET', '/api/access/selftest'),
  engineVersion: r('GET', '/api/engine/version'),
  bots: r('GET', '/api/bots'),
  models: r('GET', '/api/models'),
  bot: r('GET', '/api/bots/:name'),
  create: r('POST', '/api/bots'),
  archive: r('POST', '/api/bots/:name/archive'),
  start: r('POST', '/api/bots/:name/start'),
  stop: r('POST', '/api/bots/:name/stop'),
  restart: r('POST', '/api/bots/:name/restart'),
  sessions: r('GET', '/api/bots/:name/sessions'),
  chat: r('GET', '/api/bots/:name/chat'),
  send: r('POST', '/api/bots/:name/send'),
  inbox: r('GET', '/api/bots/:name/inbox'),
  automations: r('GET', '/api/bots/:name/automations'),
  pairClaim: r('POST', '/api/pair/claim'),
  pairDevices: r('GET', '/api/pair/devices'),
  pairRevoke: r('DELETE', '/api/pair/devices/:id'),
  attention: r('GET', '/api/attention'),
  usage: r('GET', '/api/usage'),
  approvals: r('GET', '/api/approvals'),
  decide: r('POST', '/api/bots/:name/approvals/:id/:decision'),
  automationAction: r('POST', '/api/bots/:name/automations/:auto/:action'),
  tools: r('GET', '/api/bots/:name/tools'),
  inventory: r('GET', '/api/bots/:name/inventory'),
  toolRegister: r('POST', '/api/bots/:name/tools/register'),
  toolRetire: r('POST', '/api/bots/:name/tools/retire'),
  botAccount: r('POST', '/api/bots/:name/account'),
  botAccounts: r('POST', '/api/bots/:name/accounts'),
  config: r('GET', '/api/bots/:name/config'),
  configSet: r('POST', '/api/bots/:name/config'),
  cockpit: r('GET', '/api/cockpit'),
  tgPairing: r('GET', '/api/bots/:name/pairing'),
  tgPair: r('POST', '/api/bots/:name/pair'),
  tgDeny: r('POST', '/api/bots/:name/pair/deny'),
  secrets: r('GET', '/api/bots/:name/secrets'),
  secretSet: r('PUT', '/api/bots/:name/secrets/:key'),
  secretsLock: r('GET', '/api/bots/:name/secrets/lock'),
  unlock: r('POST', '/api/bots/:name/unlock'),
  secretsAudit: r('GET', '/api/secrets/audit'),
  botSecretsAudit: r('GET', '/api/bots/:name/secrets/audit'),
  updates: r('GET', '/api/updates'),
  cc: r('GET', '/api/cc'),
  updateAction: r('POST', '/api/updates/:tag/:action'),
  accounts: r('GET', '/api/accounts'),
  accountAdd: r('POST', '/api/accounts'),
  accountRemove: r('DELETE', '/api/accounts/:id'),
  accountRename: r('PATCH', '/api/accounts/:id'),
  accountLink: r('POST', '/api/accounts/link'),
  chatRecent: r('GET', '/api/chat/recent'),
  chatLaunch: r('POST', '/api/chat/launch'),
  upload: r('POST', '/api/bots/:name/uploads'),
  uploadFile: r('GET', '/api/bots/:name/uploads/:file'),
} as const;

// ---- shapes (the fields the screens read) ------------------------------------------
type Open = Record<string, unknown>;
export interface Bot extends Open {
  name: string; displayName: string; persona: string; model: string | null; kind: 'bg' | 'pty';
  running: boolean; phase: string | null; activity?: unknown; telegram: boolean; account: string | null; backups: string[];
  reviewBoard: { url: string | null; open: number | null; answered: number | null; sentAt: string | null } | null;
  automations: { name: string; kind: string; trigger: unknown; enabled: boolean; secrets: string[] }[];
  tools: number | null; yamlError?: string | null;
  /** harness.service: 'daemon' keeps it running (Pinned); 'manual' is a chat */
  service: string; startedAt: string | null;
  blocked: { needs: string; detail: string } | null; down: string | null;
}
export interface ModelTier { tier: string; id: string; name: string; effort: string | null }
export interface AccountView extends Open {
  id: string; label: string; plan: string; masked: string | null; state: 'ok' | 'limited' | 'failed' | 'no-token';
  fiveHour: { pct?: number; na?: string } | null; sevenDay: { pct?: number; na?: string } | null;
}
export interface CreateResult extends CliResult { name: string | null }
export interface CliResult extends Open { ok: boolean; code: number; timedOut?: boolean; out?: string; err?: string }
export interface InboxItem { id: string; source: string; at: string; status: string; detail?: string; status_at?: string }
export interface ChatState { available: boolean; reason?: string; hasSession: boolean; turns: ChatTurn[]; cursor: number; file: string | null }
export interface ApprovalEntry extends Open { id: string; bot: string; path: string; value?: unknown; requested_by?: string; why?: string; diff?: string }
export interface Approvals { pending: ApprovalEntry[]; recent: Open[]; admin: Open[] }
export interface Attention { at: string; count: number; items: Open[] }
export interface ConfigSetResult extends CliResult { applied: boolean; queued: string | null; duplicate: boolean }
export interface PairDevices { exposure: 'access' | 'loopback'; devices: (Open & { id: string; current?: boolean })[] }
export interface Upload { id: string; path: string; type: string; bytes: number; image: boolean }
export type { StatusPush };

// ---- keys ------------------------------------------------------------------------------
export const qk = {
  all: ['cockpit'] as const,
  engine: () => ['cockpit', 'engine'] as const,
  selftest: () => ['cockpit', 'selftest'] as const,
  bots: () => ['cockpit', 'bots'] as const,
  bot: (name: string) => ['cockpit', 'bots', name] as const,
  botPart: (name: string, part: string, ...rest: unknown[]) => ['cockpit', 'bots', name, part, ...rest] as const,
  pairDevices: () => ['cockpit', 'pair', 'devices'] as const,
  attention: () => ['cockpit', 'attention'] as const,
  usage: () => ['cockpit', 'usage'] as const,
  approvals: () => ['cockpit', 'approvals'] as const,
  cockpit: () => ['cockpit', 'host'] as const,
  secretsAudit: (bot: string | null, limit: number) => ['cockpit', 'secrets-audit', bot, limit] as const,
  updates: () => ['cockpit', 'updates'] as const,
  cc: () => ['cockpit', 'cc'] as const,
  accounts: () => ['cockpit', 'accounts'] as const,
  chatRecent: () => ['cockpit', 'chat-recent'] as const,
};

const url = (route: { p: string }, params?: Record<string, string>) => fill(route.p, params);
function useRead<T>(key: QueryKey, route: { p: string }, params?: Record<string, string>, opts: { enabled?: boolean; refetchInterval?: number | false; search?: string } = {}) {
  return useQuery<T>({
    queryKey: key,
    queryFn: ({ signal }) => get<T>(url(route, params) + (opts.search || ''), signal),
    enabled: opts.enabled,
    refetchInterval: opts.refetchInterval,
  });
}
// A write that invalidates `keys` (prefix match) when it settles, success or not.
function useWrite<V, T = CliResult>(fn: (v: V) => Promise<T>, keys: (v: V) => QueryKey[]) {
  const qc = useQueryClient();
  return useMutation<T, Error, V>({
    mutationFn: fn,
    onSettled: (_d, _e, v) => Promise.all(keys(v).map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}
const botKeys = (name: string): QueryKey[] => [qk.bots(), qk.bot(name), qk.attention()];

// ---- machine ---------------------------------------------------------------------------
export const useAccessSelftest = () => useRead<{ verified: boolean; email: string; access: boolean }>(qk.selftest(), ROUTES.accessSelftest);
export const useEngineVersion = () => useRead<Open & { exposure: 'access' | 'loopback' }>(qk.engine(), ROUTES.engineVersion);
export const useCockpit = () => useRead<Open & { exposure: 'access' | 'loopback'; cc: { pinned: string | null; candidate: { version: string; status: string } | null } }>(qk.cockpit(), ROUTES.cockpit);
export const useAttention = () => useRead<Attention>(qk.attention(), ROUTES.attention, undefined, { refetchInterval: 15000 });
export const useUsage = () => useRead<Open & { at: string; bots: Open[]; accounts: Open[] }>(qk.usage(), ROUTES.usage, undefined, { refetchInterval: 60000 });
export const useApprovals = () => useRead<Approvals>(qk.approvals(), ROUTES.approvals, undefined, { refetchInterval: 15000 });
export const useUpdates = () => useRead<Open & { installed: string | null; releases: Open[] }>(qk.updates(), ROUTES.updates);
export const useCc = () => useRead<Open>(qk.cc(), ROUTES.cc);
export const useAccounts = () => useRead<Open & { accounts: AccountView[]; bots: Open[] }>(qk.accounts(), ROUTES.accounts);
export const useModels = () => useRead<ModelTier[]>(['cockpit', 'models'], ROUTES.models);
export const useChatRecent = () => useRead<Open[]>(qk.chatRecent(), ROUTES.chatRecent);
export const usePairDevices = () => useRead<PairDevices>(qk.pairDevices(), ROUTES.pairDevices);
export const useSecretsAudit = (bot: string | null = null, limit = 100) =>
  useRead<Open[]>(qk.secretsAudit(bot, limit), ROUTES.secretsAudit, undefined, { search: `?${new URLSearchParams({ ...(bot ? { bot } : {}), limit: String(limit) })}` });

// ---- one bot ----------------------------------------------------------------------------
export const useBots = () => useRead<Bot[]>(qk.bots(), ROUTES.bots, undefined, { refetchInterval: 5000 });
export const useBot = (name: string) => useRead<Bot>(qk.bot(name), ROUTES.bot, { name }, { enabled: !!name });
export const useSessions = (name: string) => useRead<Open[]>(qk.botPart(name, 'sessions'), ROUTES.sessions, { name }, { enabled: !!name });
// The socket pushes chat while it is open; this is the read for when it is not.
export const useChat = (name: string, after = 0, enabled = true) =>
  useRead<ChatState>(qk.botPart(name, 'chat', after), ROUTES.chat, { name }, { enabled: !!name && enabled, search: `?after=${after}` });
// Polled while a sent message is not settled yet (the composer's status line).
export const useInbox = (name: string, poll: boolean) => useRead<InboxItem[]>(qk.botPart(name, 'inbox'), ROUTES.inbox, { name }, { enabled: !!name, refetchInterval: poll ? 2000 : false });
export const useAutomations = (name: string) => useRead<Open>(qk.botPart(name, 'automations'), ROUTES.automations, { name }, { enabled: !!name });
export const useTools = (name: string) => useRead<Open>(qk.botPart(name, 'tools'), ROUTES.tools, { name }, { enabled: !!name });
export const useInventory = (name: string) => useRead<Open & { groups: Open[] }>(qk.botPart(name, 'inventory'), ROUTES.inventory, { name }, { enabled: !!name });
export const useBotConfig = (name: string) => useRead<{ config: Open; set: string[] }>(qk.botPart(name, 'config'), ROUTES.config, { name }, { enabled: !!name });
export const useTgPairing = (name: string) => useRead<Open>(qk.botPart(name, 'pairing'), ROUTES.tgPairing, { name }, { enabled: !!name });
export const useSecrets = (name: string) => useRead<Open>(qk.botPart(name, 'secrets'), ROUTES.secrets, { name }, { enabled: !!name });
export const useSecretsLock = (name: string) => useRead<Open>(qk.botPart(name, 'secrets-lock'), ROUTES.secretsLock, { name }, { enabled: !!name });
export const useBotSecretsAudit = (name: string, limit = 100) =>
  useRead<Open[]>(qk.botPart(name, 'secrets-audit', limit), ROUTES.botSecretsAudit, { name }, { enabled: !!name, search: `?limit=${limit}` });
// An uploaded image (operator-gated), for a thumbnail: the caller makes the object URL.
export const useUploadFile = (name: string, file: string) =>
  useQuery<Blob>({ queryKey: qk.botPart(name, 'upload', file), queryFn: ({ signal }) => request<Blob>('GET', url(ROUTES.uploadFile, { name, file }), { signal, as: 'blob' }), enabled: !!name && !!file, staleTime: Infinity });

// ---- writes -----------------------------------------------------------------------------
export const useLifecycle = () => useWrite(
  ({ name, action, fresh }: { name: string; action: 'start' | 'stop' | 'restart'; fresh?: boolean }) => post<CliResult>(url(ROUTES[action], { name }), action === 'stop' ? {} : { fresh: !!fresh }),
  ({ name }) => botKeys(name));
export const useSend = () => useWrite(
  ({ name, text, attachments = [] }: { name: string; text: string; attachments?: string[] }) => post<InboxItem>(url(ROUTES.send, { name }), { text, attachments }),
  ({ name }) => [qk.botPart(name, 'inbox')]);
export const useUpload = () => useWrite(
  ({ name, file }: { name: string; file: File }) => request<Upload>('POST', url(ROUTES.upload, { name }), { raw: { data: file, headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name || 'pasted') } } }),
  () => []);
export const usePairClaim = () => useWrite(
  ({ code }: { code: string }) => post<{ ok: true; device: Open }>(url(ROUTES.pairClaim), { code }),
  () => [qk.pairDevices()]);
export const usePairRevoke = () => useWrite(
  ({ id }: { id: string }) => del<{ ok: true; removed: number }>(url(ROUTES.pairRevoke, { id })),
  () => [qk.pairDevices()]);
export const useDecide = () => useWrite(
  ({ name, id, decision, reason }: { name: string; id: string; decision: 'approve' | 'reject'; reason?: string }) => post<CliResult>(url(ROUTES.decide, { name, id, decision }), reason ? { reason } : {}),
  ({ name }) => [qk.approvals(), qk.attention(), qk.botPart(name, 'config'), qk.bot(name)]);
export const useAutomationAction = () => useWrite(
  ({ name, auto, action }: { name: string; auto: string; action: 'run' | 'pause' | 'resume' | 'enable' | 'disable' }) => post<CliResult>(url(ROUTES.automationAction, { name, auto, action })),
  ({ name }) => [qk.botPart(name, 'automations'), qk.attention()]);
export const useToolRegister = () => useWrite(
  ({ name, ...body }: { name: string; tool: string; path: string; kind: 'cli' | 'monitor' | 'integration' | 'lib'; purpose?: string; secrets?: string[] }) =>
    post<CliResult>(url(ROUTES.toolRegister, { name }), { name: body.tool, path: body.path, kind: body.kind, purpose: body.purpose, secrets: body.secrets }),
  ({ name }) => [qk.botPart(name, 'tools'), qk.botPart(name, 'inventory'), qk.attention()]);
export const useToolRetire = () => useWrite(
  ({ name, target }: { name: string; target: string }) => post<CliResult>(url(ROUTES.toolRetire, { name }), { target }),
  ({ name }) => [qk.botPart(name, 'tools'), qk.botPart(name, 'inventory'), qk.attention()]);
export const useBotAccount = () => useWrite(
  ({ name, id }: { name: string; id: string }) => post<CliResult>(url(ROUTES.botAccount, { name }), { id }),
  ({ name }) => [...botKeys(name), qk.usage(), qk.accounts()]);
export const useBotAccounts = () => useWrite(
  ({ name, primary, backups }: { name: string; primary: string; backups: string[] }) => post<CliResult & { steps: Open[] }>(url(ROUTES.botAccounts, { name }), { primary, backups }),
  ({ name }) => [...botKeys(name), qk.usage(), qk.accounts()]);
export const useConfigSet = () => useWrite(
  ({ name, path, value }: { name: string; path: string; value: unknown }) => post<ConfigSetResult>(url(ROUTES.configSet, { name }), { path, value }),
  ({ name }) => [qk.botPart(name, 'config'), qk.botPart(name, 'inventory'), qk.bot(name), qk.approvals(), qk.attention()]);
export const useTgPair = () => useWrite(
  ({ name, senderId }: { name: string; senderId: string }) => post<Open>(url(ROUTES.tgPair, { name }), { senderId }),
  ({ name }) => [qk.botPart(name, 'pairing'), qk.attention()]);
export const useTgDeny = () => useWrite(
  ({ name, senderId }: { name: string; senderId: string }) => post<Open>(url(ROUTES.tgDeny, { name }), { senderId }),
  ({ name }) => [qk.botPart(name, 'pairing'), qk.attention()]);
export const useSecretSet = () => useWrite(
  ({ name, key, value }: { name: string; key: string; value: string }) => put<Open>(url(ROUTES.secretSet, { name, key }), { value }),
  ({ name }) => [qk.botPart(name, 'secrets'), qk.botPart(name, 'secrets-audit')]);
export const useUnlock = () => useWrite(
  ({ name, passphrase }: { name: string; passphrase: string }) => post<Open>(url(ROUTES.unlock, { name }), { passphrase }),
  ({ name }) => [qk.botPart(name, 'secrets-lock'), qk.botPart(name, 'secrets')]);
export const useUpdateAction = () => useWrite(
  ({ tag, action }: { tag: string; action: 'apply' | 'skip' | 'rollback' | 'cancel' }) => post<CliResult>(url(ROUTES.updateAction, { tag, action })),
  () => [qk.updates(), qk.attention()]);
export const useAccountAdd = () => useWrite(
  (body: { id: string; label?: string; plan?: string; token: string }) => post<CliResult>(url(ROUTES.accountAdd), body),
  () => [qk.accounts(), qk.usage(), qk.attention()]);
export const useAccountRemove = () => useWrite(
  ({ id }: { id: string }) => del<CliResult>(url(ROUTES.accountRemove, { id })),
  () => [qk.accounts(), qk.usage(), qk.attention()]);
export const useAccountRename = () => useWrite(
  ({ id, label }: { id: string; label: string }) => request<CliResult>('PATCH', url(ROUTES.accountRename, { id }), { body: { label } }),
  () => [qk.accounts(), qk.usage()]);
export const useAccountLink = () => useWrite(
  () => post<Open & { ok: true }>(url(ROUTES.accountLink)),
  () => [qk.accounts(), qk.usage(), qk.attention(), qk.bots()]);
// New bot / New chat: creating never launches (the caller starts it).
export const useCreateBot = () => useWrite(
  (body: { name?: string; persona?: string; account: string; telegram?: boolean; service: 'daemon' | 'manual' }) => post<CreateResult>(url(ROUTES.create), body),
  () => [qk.bots(), qk.attention(), qk.accounts()]);
export const useArchive = () => useWrite(
  ({ name }: { name: string }) => post<CliResult>(url(ROUTES.archive, { name })),
  () => [qk.bots(), qk.attention(), qk.accounts()]);
export const useChatLaunch = () => useWrite(
  (body: { account: string; generic?: boolean; cwd?: string }) => post<CliResult>(url(ROUTES.chatLaunch), body),
  () => [qk.chatRecent()]);
