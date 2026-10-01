# The improvement cycle

Bots propose upgrades to the shared harness; other bots review them; the
operator alone merges. No bot has a path to `main`.

The cycle is **manual and on demand**. Nothing in the daemon, no automation
and no scheduled job runs any step of it. The operator or a bot's Director runs it
when there is something worth proposing: a lesson a bot has re-learned, a
fix it made locally that every bot would want, a harness gap it hit in real
work. The `suggest:` block in `bot.yaml` (`weekly`, `max_prs_per_week`,
`digest_bot`) is read by nothing; it schedules nothing.

## 1. Suggest

When the Director has a **generic** harness upgrade (nothing bot-specific),
it runs `botcorp suggest <bot> --topic <t> [--lesson <path>]`:

1. A fresh worktree at `~/.botcorp/work/<t>` off `origin/main`, branch
   `suggest/<bot>/<t>`.
2. `scripts/debrand-lint.py` (names, emails, Windows user-profile paths,
   token-shaped strings, and any per-bot extra terms in that bot's own
   gitignored `debrand-terms.txt`) plus `scripts/secret-scan.sh` run before
   anything is pushed.
3. It prints the `git push` and `gh pr create` commands (labels `suggest` and
   `bot:<name>`, a `Bot: <name>` trailer on the commit) and runs neither; the
   Director runs them once the change is in the worktree.

Keep it to one or two PRs at a time; a queue of open suggestions nobody
reviews is noise.

Commits use the repo's noreply identity, the same as every other commit in
this repo (`docs/engine-contract.md` / `.githooks/pre-commit`).

## 2. Cross-review

When the operator asks for reviews, or a Director has time between tasks, a
bot lists open `suggest` PRs it did **not** author and has **not** already
reviewed (`gh pr list --label suggest --json number,author,labels` plus its
own review presence via `gh api .../reviews`), and for each one posts a
single review comment from its own perspective — "as a bot that runs X, this
would/wouldn't help because…" — ending with a verdict line
`VERDICT: approve|request-changes|neutral` and a `Bot: <name>` trailer, via
`gh pr review --comment`.

**Loop guards**, so two bots reviewing each other's work cannot spiral:

- never its own PR (checked by author + branch-prefix)
- never twice on the same PR (a `Bot: <name>` review already present, or a
  `reviewed:<name>` label, means skip)
- no reviews on a PR older than 30 days
- a bot never edits a PR it has reviewed

## 3. The operator alone merges

Branch protection on `main`: PR required, required status checks
(`ci.yml`: `validate`, `pytest`, `hooks-syntax`, `node-check`,
`debrand-lint`, `secret-scan`, `pwsh-parse`), `enforce_admins` on. No bot has
write access to `main` and no automation calls `gh pr merge` on a `suggest/*`
branch — merging is a human action, every time.

## 4. Asking the operator: one review page, never per-PR pings

When open `suggest` PRs are waiting on the operator, the Director builds one
review page (the `review-artifact` pattern) listing them: each PR's diff
summary, CI state and every bot's review inline, each with Yes / No /
Don't-know plus a comment field. It acts on the answers that come back:

- **Yes** → `gh pr merge` is still **not** automatic — the Director posts
  "approved, merge when ready" as a PR comment (or the operator merges
  straight from the PR link).
- **No** → the PR is closed with the operator's comment attached.
- **Don't know** → the PR stays open for the next time.

One Telegram message with the page link, and only when at least one
`suggest` PR is open. No per-PR notification ever reaches chat.

Pending harness **releases** are not part of this page: the hourly update
check records them (`~/.botcorp/state/updates.json`) and the cockpit's
Releases panel shows each with its **What changed / Why / Value to you**
notes and **Apply** / **Skip**. Nothing ever applies a harness update by
itself.

## 5. Shared lessons

`harness/lessons/*.md` (the same memory-lesson format as a bot's own
`memory/`), with `harness/lessons/INDEX.md` injected at `SessionStart` for
every bot with `harness.modules.lessons: true`. A lesson is promoted into it
via `--lesson <path>` on a suggest PR; personal, bot-specific memory always
stays in `bots/<name>/memory/` and that bot's own config home — it is never
what a suggest PR carries.
