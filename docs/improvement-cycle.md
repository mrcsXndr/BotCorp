# The improvement cycle

Bots propose upgrades to the shared harness; other bots review them; the
operator alone merges. No bot has a path to `main`.

## 1. Weekly suggest tick

For every bot with `suggest.weekly: true` in its `bot.yaml`, the daemon runs
a headless session (staggered per bot, so two bots never open PRs in the same
hour) with the prompt: from this week's journal and shared lessons, propose
at most `suggest.max_prs_per_week` (default 2) **generic** harness upgrades —
nothing bot-specific.

Each proposal becomes `botcorp suggest <bot> --topic <t> [--lesson <path>]`:

1. A fresh worktree at `~/.botcorp/work/<t>` off `origin/main`, branch
   `suggest/<bot>/<t>`.
2. `scripts/debrand-lint.py` (names, emails, Windows user-profile paths,
   token-shaped strings, and any per-bot extra terms in that bot's own
   gitignored `debrand-terms.txt`) plus `scripts/secret-scan.sh` run before
   anything is pushed.
3. `gh pr create` with labels `suggest` and `bot:<name>`, and a `Bot: <name>`
   trailer on the commit.

Commits use the repo's noreply identity, the same as every other commit in
this repo (`docs/engine-contract.md` / `.githooks/pre-commit`).

## 2. Cross-review

On a daily review tick, each bot lists open `suggest` PRs it did **not**
author and has **not** already reviewed
(`gh pr list --label suggest --json number,author,labels` plus its own
review presence via `gh api .../reviews`), and for each one posts a single
review comment from its own perspective — "as a bot that runs X, this
would/wouldn't help because…" — ending with a verdict line
`VERDICT: approve|request-changes|neutral` and a `Bot: <name>` trailer, via
`gh pr review --comment`.

**Loop guards**, so two bots reviewing each other's work cannot spiral:

- never its own PR (checked by author + branch-prefix)
- never twice on the same PR (a `Bot: <name>` review already present, or a
  `reviewed:<name>` label, means skip)
- at most `max_reviews_per_week` per bot (default 6)
- no reviews on a PR older than 30 days
- a bot never edits a PR it has reviewed

## 3. The operator alone merges

Branch protection on `main`: PR required, required status checks
(`ci.yml`: `validate`, `pytest`, `hooks-syntax`, `node-check`,
`debrand-lint`, `secret-scan`, `pwsh-parse`), `enforce_admins` on. No bot has
write access to `main` and no automation calls `gh pr merge` on a `suggest/*`
branch — merging is a human action, every time.

## 4. One weekly digest, never per-PR pings

A Sunday digest tick builds a single review page (the `review-artifact`
pattern) listing every open `suggest` PR: its diff summary, CI state, and
every bot's review inline, each with Yes / No / Don't-know plus a comment
field. The operator's answers write back to
`~/.botcorp/state/digest-<week>.json`, and the next tick acts on them:

- **Yes** → `gh pr merge` is still **not** automatic — the tick posts
  "approved in digest, merge when ready" as a PR comment (or the operator
  merges straight from the PR link).
- **No** → the PR is closed with the operator's comment attached.
- **Don't know** → the PR stays open for next week's digest.

One Telegram message with the digest link — sent through whichever bot
`suggest.digest_bot` names (one machine-wide setting) — and only when at
least one `suggest` PR is open. No per-PR notification ever reaches chat.

The same digest also lists any pending harness **releases** the hourly
update check has recorded (`~/.botcorp/state/updates.json`), each with its
own plain-language **What changed / Why / Value to you** notes and
**Apply** / **Skip** buttons — this is the same What/Why/Value shown in the
cockpit's Releases panel. A release is not a `suggest` PR and carries no
Yes/No/Don't-know: **Apply** is the one admin action, queuing that release
for each bot's next safe restart behind the existing smoke test and
automatic rollback on failure; nothing here ever applies a harness update by
itself.

## 5. Shared lessons

`harness/lessons/*.md` (the same memory-lesson format as a bot's own
`memory/`), with `harness/lessons/INDEX.md` injected at `SessionStart` for
every bot with `harness.modules.lessons: true`. A lesson is promoted into it
via `--lesson <path>` on a suggest PR; personal, bot-specific memory always
stays in `bots/<name>/memory/` and that bot's own config home — it is never
what a suggest PR carries.
