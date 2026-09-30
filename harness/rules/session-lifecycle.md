# Session Lifecycle — when to roll a fresh session

Purpose: long `--continue` sessions balloon context (slower turns, resume-picker
risk); the three-channel memory (journal → timeline → recall) plus the TDL make
handoff lossless, so rolling a FRESH session at a clean breakpoint is cheap and
routine — **without ever losing in-flight work**.

## The invariant (read first)

**NEVER roll mid-task.** A lost working context is far worse than a big
session. Roll ONLY at a clean breakpoint. When unsure whether it's a
breakpoint, DON'T roll.

## When to roll (ALL must hold)

1. **Context large** — last-turn context tokens are well into the hundreds of
   thousands (around 500,000 is a reasonable line; the Director judges it,
   nothing measures it for you). Resume-picker risk begins meaningfully
   before the hard ceiling, so don't wait for it.
2. **Idle** — no turn in flight.
3. **No in-flight work** — no running subagents, no in-progress task, no build
   the Director is actively watching.
4. **Not mid-thread with the operator** — not waiting to answer a question that
   needs this session live *right now*. The journal captures the thread, so a
   roll is usually still fine — but don't roll in the middle of a
   back-and-forth.

## Lossless handoff checklist (DO before rolling)

1. **Journal current** — append any pending `decision`/`action`/`finding`.
2. **Build the timeline** — `python tools/v2/timeline.py build $SESSION_ID`
   (distils the journal; session-start re-injects it as "Last session").
3. **TDL `## Open` updated** — every unfinished item has a status tag + the
   exact next step + blocker, so the fresh session resumes precisely.
4. **Roll fresh** — `botcorp restart <bot> --fresh` (it drops
   `.claude/.botcorp_fresh_restart`; a marker younger than 300s forces a
   NON-continue start).
   Session-start re-injects journal + timeline + last-session + TDL Open +
   recall. **Verify it landed:** the restart log must confirm a fresh start,
   and the next status footer must show a NEW session id — a roll is not done
   until the id actually changed.

A fresh roll (not `--continue`) is ALSO the only way a model pin in
`bot.yaml` / `.claude/settings.json` finally takes — `--continue` preserves the
running model.

## Who triggers it

- **Manual (the only way)** — the Director decides at a breakpoint and runs the
  checklist above. Nothing rolls a session on its own: there is no token
  threshold and no automatic roll.
- **Declared breakpoint** — an idle-transcript signal rarely holds during long
  autonomous work (the Director's own tool call is always the freshest
  transcript write, so it can never observe itself as idle). Instead the
  Director *declares* the breakpoint: after the handoff checklist, with no
  subagent running, no in-progress task and no build being watched, drop
  `.claude/.botcorp_breakpoint` as the **last action of the turn** and end the
  turn. For the next `BOT_BREAKPOINT_TTL_MIN` (30) minutes the daemon's
  session-busy check treats the session as IDLE and may act on it — a
  deferred idle-gated heal, an update restart (`update_restart.py`, which
  consumes the marker). The next prompt deletes it, so it never outlives
  the turn it closed. Without a marker the daemon counts a session as idle
  once its transcripts have been quiet for 5 minutes; a stale marker is
  ignored. The invariant holds because the Director only drops it when the
  turn is genuinely over — never mid-task, never with work in flight.

## Never kill a live session to "fix" it

A supervisor / daemon process must never terminate a session it cannot prove
is idle. Idle-gate on transcript/journal mtime, not on a guess — killing a
session mid-task to force a restart has destroyed live working context before,
and that is strictly worse than leaving a slightly-stale process running one
extra tick.

## Blocking dialogs are hard-denied

`AskUserQuestion` and `ExitPlanMode` are denied at the settings/tool-guard
level everywhere the bot might be Telegram-driven or headless: a blocking
dialog freezes a loop nobody is sitting in front of. When a choice is needed,
pick the sensible default and proceed, stating the choice; if the operator's
input is genuinely required, send a **non-blocking** question via
`tg_send.py` and continue with a reasonable default rather than waiting.

## Transcript retention (disk hygiene)

Raw transcripts under the Claude Code project directory are pure logs — a
week-old session is never resumed with `--continue` (roll fresh with journal
handoff instead), so old transcripts are dead weight. Keep a bounded recent
window (e.g. 7 days) and prune older ones; anything under `memory/` is
load-bearing and is never pruned by this cleanup.
