---
name: a-roll-is-not-done-until-the-id-changed
description: A restart, redeploy, or session roll is verified by what actually came up afterward, not by the command that triggered it returning cleanly — the trigger and the effect can silently disagree for a long time
metadata:
  type: lesson
---

# A restart is verified by the new state, not by the command exiting

Announcing that a restart/redeploy/session-roll happened, based on the
trigger command returning successfully, is not the same as confirming it
happened. The documented procedure and the code that's supposed to implement
it can silently disagree for a long time, and a log line that *sounds* like
success can be printed by a code path that took the opposite branch.

**Why.** In one case, a restart script had — months earlier, for an
unrelated and correct reason — been changed to always relaunch in
"continue the existing session" mode, unconditionally deleting the marker
file that was supposed to force a genuinely fresh start. The operating
procedure still told the operator to drop that marker and trigger a restart
to apply a configuration change. Nobody had wired a check that the fresh
start actually happened, so the mismatch went unnoticed: the restart was
"announced" as done twice, days apart, and neither time actually took effect
— same session id, same stale configuration, until someone independently
confirmed it by reading the resulting state instead of trusting the trigger.

**How to apply.**
- After any roll, restart, or redeploy, read whatever log/status the
  operation is supposed to produce and confirm it says what you expect —
  not just that the command exited 0.
- Confirm an identifier that can only change if the new state actually took
  effect (a new session id, a new process id, a new deployed version/commit)
  before reporting the operation as done.
- Treat "the trigger fired" and "the effect happened" as two separate claims
  that both need evidence — especially when a past fix silently changed what
  the trigger does without anyone updating the procedure that describes it.

Related: [[exit-zero-hides-outages]] · [[subagent-verified-is-not-verified]]
