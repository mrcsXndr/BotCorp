# Model routing: which model does the work

The operator set this on 2026-09-29, after Sonnet 5.5 shipped and a Fable-heavy day used half the weekly pool: *"We should prefer Opus 5.5 work for now rather than Fable as it's as strong ... with Sonnet 5.5 we can use it for efficient tasks, and Haiku for TINY ... Fable burns WAY too much."*

**Rule: use the cheapest tier that can do the job well. Escalate a tier when the work fails. Do not escalate in advance "to be safe".**

## The tiers

| Tier | Model (pinned id) | Effort | Agents | Use it for |
|---|---|---|---|---|
| **Top** | Opus 5.5 (`claude-opus-5-5`) | `high` | main thread (the Director), `planner`, `senior-coder` | Architecture and plans, multi-file or cross-layer implementation, security and code review, anything where a wrong call costs hours |
| **Workhorse** | Sonnet 5.5 (`claude-sonnet-5-5`) | `medium` (`low` for lookups) | `coder`, `critic` | Locked-plan edits, batch and per-item work, tests, research and summaries, doc rewrites. **This is the default for any subagent.** |
| **Tiny** | Haiku 4.5 (`claude-haiku-4-5-20251001`) | none (Haiku has no effort setting) | `one-shot` | Lookups, status checks, a single tool call, classifying or triaging a log, formatting, small transforms |
| **Hyper-IQ, opt-in** | Fable 5.1 (`claude-fable-5-1`) | `xhigh` | `fable` | Only when the operator asks for it by name, or when the task has failed on Opus 5.5 at `xhigh` and you can say why Opus fell short. Never for fan-outs, review loops, red-team rounds or coordination. |

**Effort costs as much as the model choice.** The same model at `max` can spend several times the tokens it spends at `medium`.
- Raise effort only for the one hard step, and only with an explicit `effort:` override. Never raise it for a whole fan-out.
- The main thread's effort is set in `bot.yaml` (`effort:`).
- An agent file's `effort:` wins over the session's effort, unless the `CLAUDE_CODE_EFFORT_LEVEL` env var is set. That env var beats everything, so don't set it on a bot.

**Why this split** (public sources, 2026-09-29: Anthropic's models overview and launch pages, Artificial Analysis):

| Model | Terminal-Bench 4.0 (vendor) | Artificial Analysis index | Output speed | API price in/out per MTok |
|---|---|---|---|---|
| Opus 5.5 | 66.4% | 58 | ~93 tok/s | $4 / $20 |
| Sonnet 5.5 | 70.6% | 56 | ~139 tok/s | $2 / $10 |
| Fable 5.1 | 55.8% | 53 | ~69 tok/s | $10 / $50 |
| Haiku 4.5 | n/a | n/a | n/a | $1 / $5 |

The prices come from `harness/models.json` (`price_per_mtok` per tier, with the cache write and read prices); the cost meter's transcript fallback prices from the same file, and a test checks that this column matches it.

- On every row both sources publish, Opus 5.5 is at or above Fable 5.1, at 40% of the price.
- Sonnet 5.5 is close behind Opus and ahead of it on agentic terminal work, at half the price and 1.5× the speed.
- On Max, Fable draws on the same weekly pool as every other model, is capped at 50% of it, and "uses limits faster".
- Haiku 4.5 is stale (knowledge to Feb 2025, no effort setting), so keep it to work that needs no judgement.

## How to route

1. **Pick from the task, not from its importance.** An important task can still be a mechanical one. "Rename 40 files" goes to Sonnet, and so does "summarise these 12 reviews". "Design the failover state machine" goes to Opus.
2. **Fan-outs run on Sonnet or Haiku.** Parallel Opus agents are allowed only when each one does top-tier work. Never run more than 2 at once.
3. **One Opus builder per work tree.** Reviews may run in parallel; writes to one tree may not.
4. **Review loops stop when they converge.** Run a red-team or critic round only when the last round found a BLOCKER. Two rounds with no BLOCKER means stop. Ask the operator before a third round.
5. **Escalate on evidence.** Move up a tier (Haiku → Sonnet → Opus) when the lower tier failed its verify clause or spun. Say in the Journal which failure caused the move.
6. **To override a model per call, use the Agent tool's `model` parameter** (`opus`, `sonnet`, `haiku`). Do not edit the agent files for one call.

## The budget gates

The status footer shows the `5h` and `7d` usage.

| 7d usage | What changes |
|---|---|
| < 70% | Normal routing. |
| 70–90% | No new Opus fan-outs. Opus only for the main thread and one builder. Everything else on Sonnet or Haiku. |
| 90–98% | Sonnet and Haiku only. Finish the work in flight. Start nothing large without the operator's OK. |
| ≥ 98% | The existing hard cap: alerts, lean mode, the resume-at-reset path. |

## Model ids: never guess

- **Where the ids come from:** only from what the running Claude Code reports (the model list in its environment block, or `/model`) or from the provider's model list. Never type an id from memory.
- **Agent files pin a full id.** Aliases (`opus`, `sonnet`, `haiku`) follow Claude Code's own idea of "latest". With a pinned id, a model change is a deliberate, reviewable commit.
- **The single source of truth is `harness/models.json`.** It maps each tier to its id. The agent frontmatter and this table must agree with it, and a test checks that they do.

## When a new model ships

Models and routing change every few weeks, so BotCorp does not wait for someone to notice.

- **Detect.** The `model-watch` check (BotCorp v0.8.x) runs once a day. It compares the models the pinned Claude Code knows (and, where a key allows it, the provider's model list) against `harness/models.json`.
- **Propose, never auto-switch.** When it sees a new model in a tier's family (for example a newer Sonnet), it files **one approval**: "Move the Workhorse tier from `claude-sonnet-5-5` to `<new id>`?" The approval carries:
  - the release date;
  - one canary result: a real `coder` run on a fixture task with the new id, showing it passed and what it cost;
  - what changes: the agent files, `models.json`, this table.
- **Apply on approve.** The approval turns into one harness commit and a release. Bots pick it up at their next sync. A reject silences that model id for 30 days.
- **Tell the operator once.** One TG line with the approval link. Nothing more.

Until `model-watch` ships, the Director makes the same proposal by hand when a new model appears in its own environment block.

## Keeping this table true

Benchmarks and prices move, so a weekly research pass rechecks them: new models, Claude Code changelog entries that touch models or effort, and the benchmark and price sources above. It proposes changes to this file as one reviewable item. Nobody edits the table from memory.
