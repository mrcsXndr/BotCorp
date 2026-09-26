// state.mjs - reads state/<bot>.json in schema v2 (docs/daemon.md "State
// file"). The process record stays flat (bg_id, session_id, claude_pid, ...);
// three blocks carry the rest:
//   desired   {state: running|stopped, by, at}   what the operator or daemon asked for
//   launch    the vault attestation (nonce_sha256, minted_by_pid, at, at_unix,
//             consumed_at) plus the launcher's outcome {phase, phase_at, exit_code}
//   observed  core/observe.mjs, persisted by the daemon tick
// A v1 record (flat `status`, `exit_code`, `stopped_at`, `stopped_by`) reads
// the same way, so every reader works on an un-migrated file during the
// rollout window. Read-only: daemon/_common.ps1 ConvertTo-BotStateV2 applies
// the same mapping when it rewrites a file.

export const LAUNCH_PHASES = ['starting', 'cold-starting', 'restarting', 'up', 'exited', 'locked'];
const V1_PHASE = { running: 'up', starting: 'starting', 'cold-starting': 'cold-starting', restarting: 'restarting', exited: 'exited', locked: 'locked' };

function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

export function stateView(raw) {
  const st = isObj(raw) ? raw : {};
  const status = typeof st.status === 'string' ? st.status : '';
  const at = st.updated_at ?? null;
  let desired = isObj(st.desired) ? st.desired : null;
  if (!desired && status) {
    desired = status === 'stopped'
      ? { state: 'stopped', by: st.stopped_by ?? null, at: st.stopped_at ?? at }
      : { state: 'running', by: st.started_by ?? null, at: st.started_at ?? at };
  }
  const launch = isObj(st.launch) ? { ...st.launch } : {};
  if (!launch.phase && V1_PHASE[status]) { launch.phase = V1_PHASE[status]; launch.phase_at = at; }
  if (launch.exit_code === undefined && st.exit_code !== undefined) launch.exit_code = st.exit_code;
  return { desired, launch, observed: isObj(st.observed) ? st.observed : null };
}

// The one phase every reader shows and gates on (cockpit, tray, status, doctor,
// restart.ps1, the automation and update-apply gates):
//   idle | working | blocked | unknown   alive: observe's activity
//   starting   not alive, a launch began under LAUNCH_GRACE_MS ago
//   stopped    not alive and nobody wants it running (desired stopped, a clean
//              exit, or never started)
//   down       not alive although it should run: the daemon restarts it
// `observed` defaults to the record persisted in the state file; pass a fresh
// one (core/observe.mjs) to judge the live session.
export const PHASES = ['stopped', 'down', 'starting', 'idle', 'working', 'blocked', 'unknown'];
export const LAUNCH_GRACE_MS = 5 * 60_000;
const STARTING = ['starting', 'cold-starting', 'restarting'];

export function phase(raw, observed, now = Date.now()) {
  const v = stateView(raw);
  const o = observed === undefined ? v.observed : observed;
  if (o && o.alive) return ['idle', 'working', 'blocked'].includes(o.activity) ? o.activity : 'unknown';
  const since = Date.parse(v.launch.phase_at);
  if (STARTING.includes(v.launch.phase) && Number.isFinite(since) && now - since < LAUNCH_GRACE_MS) return 'starting';
  if (v.desired && v.desired.state === 'stopped') return 'stopped';
  if (v.launch.phase === 'exited' && !Number(v.launch.exit_code)) return 'stopped';
  if (!v.desired && !v.launch.phase) return 'stopped';
  return 'down';
}
