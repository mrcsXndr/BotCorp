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
