# Memory Loop — Three Channels + Tiered Agents

Purpose: how the harness carries state across sessions without re-reading transcripts, and which agent tier to dispatch each task to.

## The Three Channels

| Channel | Purpose | Storage | Lifetime |
|---|---|---|---|
| **Director's Journal** | Live structured working memory. Findings / decisions / open questions / hypotheses / actions captured AS THEY HAPPEN. | `memory/sessions/<id>/journal.md` | per session |
| **Timeline** | Distilled chronological narrative built periodically from the journal. | `memory/sessions/<id>/timeline.md` | per session |
| **Critic envelope** | Per-subagent credibility JSON, written only on demand (see below). | `memory/sessions/<id>/critic-<ts>.json` | per manual grading |

The main thread (the **Director**) writes journal entries **liberally**:
journal + timeline replace re-reading message history after compaction. If you
don't write it down, it's gone.

```bash
PYTHONIOENCODING=utf-8 python tools/v2/journal.py append "$SESSION_ID" decision "switching deploys to dev-only by default"
```

Six entry kinds: `finding` (synthesised conclusions), `decision` (chosen-path
commitments), `observation` (raw tool/file output worth remembering),
`question` (blockers needing the operator), `hypothesis` ("next session try
X"), `action` (things performed).

## Cross-session recall — and an honesty note on trust

`tools/v2/recall.py` is a zero-LLM FTS5 index over ALL session journals +
timelines, refreshed at session start:
`python tools/v2/recall.py search "<query>" [--min-trust X]`. Each fact carries
a `trust_score` (default 0.5) meant to rise/fall with
`recall.py feedback <id> helpful|unhelpful` (+0.05 / −0.10, clamped) so wrong
facts decay out of results.

**That mechanism only works if something calls `feedback`.** Left to manual
discipline, it typically doesn't: measured in production, the overwhelming
majority of entries sat at the untouched default score with almost no
feedback events ever recorded — a scoring column nobody feeds is not a filter,
and describing it as one is worse than not having it, because it invites
trusting a recalled fact because it "survived" a decay that never ran. Either
wire a deterministic downvoter (e.g. an index-time check that a fact's named
file/flag still exists) or don't claim recall is trust-filtered — and treat
every recalled fact as unranked until you do: verify it against current code
before acting on it.

## Token-saving discipline (non-negotiable)

1. **Never paste full file contents into chat.** Use `Read` and reference the path.
2. **Use subagents for anything >1 file or >3 grep-passes.** The subagent's transcript stays out of the main thread.
3. **Match the agent to the task.** Don't reach for a top-tier agent on a single-file edit; don't reach for the workhorse tier on a multi-file refactor with non-obvious sequencing.
4. **Append to the journal aggressively.** Journal entries are 1-line and replace re-explaining context next session.

## Tiered subagents (`.claude/agents/`)

| Agent | Default model | When |
|---|---|---|
| **Director** (main thread) | your default | Always. Orchestrator: holds plan state, reads journal+timeline, dispatches subagents, replies on TG. |
| `planner` | fable | Architecture, multi-file refactor design, trade-offs that cost hours if wrong |
| `senior-coder` | fable | Plan locked, implementation needs top-tier care (cross-layer bugs, new abstractions) |
| `coder` | sonnet | Mechanical edits, single-file fixes, per-item batches — spawn freely, in parallel |
| `one-shot` | sonnet | Factual lookups, status checks, single-tool answers (≤200 words) |
| `critic` | sonnet | Credibility-score a subagent result on demand (5-band rubric, JSON envelope) |
| `fable` | fable | The hardest work — most ambiguous architecture, deepest cross-layer implementation, rigorous reviews, creative builds. Top tier, top cost; reserve for where model strength changes the outcome. Runs in PLAN/IMPLEMENT/REVIEW mode. |

Models are documented defaults — edit the `model:` frontmatter in
`.claude/agents/*.md` to taste (e.g. if a bot has no access to the top tier,
point `planner`/`senior-coder`/`fable` at your best available model). When in
doubt: `planner` first to scope, then `senior-coder` or a fan-out of `coder`s,
`critic` to verify.

**Default to subagents for anything >1 file or >3 grep-passes.** Subagent
transcripts stay out of the main thread; each finds its own context; long
sessions stay viable because the journal is the long-term memory.

## Critic — manual/on-demand only

There is no automatic per-subagent scoring. The harness's subagent lifecycle
hooks append one line each to an activity log — nothing more. For an actual
credibility grade, invoke deliberately:
`Agent(subagent_type="critic", ...)` or the `/critic <result-file>` command.
A gated, deliberate critic is the defensible version; auto-firing on every
subagent return is pure cost with no payoff.
