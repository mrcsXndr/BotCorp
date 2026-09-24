# Task Board — GitHub Projects v2

Purpose: an optional durable kanban board — the place to hand decisions off instead of burying them in chat.

Optional. When configured, a **GitHub Project (v2)** is the single source of
truth for what the bot is working on. It's a real kanban board — drag-drop,
mobile, shareable — so the operator can move a card from a phone and the bot
sees the change on its next poll.

- **Client:** `tools/v2/gh_projects.py` (GraphQL over `gh api graphql`)
- **Telegram:** `/board` (see `tools/v2/tg_commands.py` → `cmd_board`)

## Setup / portability

1. Create a Project on GitHub (user or org) and note its number from the URL
   (`https://github.com/users/<login>/projects/<N>`).
2. Add the fields you want to drive. This client understands **Status**
   (single-select — the columns), **Priority**, and **Size**; unknown fields
   are read but not written.
3. Put the config in `.env` (real environment variables override the file):

   ```
   GH_PROJECT_OWNER=<github-login>
   GH_PROJECT_NUMBER=<N>
   GH_PROJECT_TYPE=user        # or: org
   # GH_PROJECTS_TOKEN=<PAT>   # optional; see below
   ```

4. Give it Projects read/write access, either:
   - `gh auth refresh -s project` — add the scope to the machine's `gh` login, or
   - `GH_PROJECTS_TOKEN` — a PAT with the **project** scope. It overrides the
     gh login, which is what you want for a headless/service account.
5. `python tools/v2/gh_projects.py init` — introspects the board and caches
   the field/option IDs to `memory/tasks/gh_project.json`, so later calls are
   a single GraphQL round-trip. That cache and the poll snapshot are
   gitignored: they describe *your* board, not the template's.

Nothing board-related runs until `GH_PROJECT_OWNER` and `GH_PROJECT_NUMBER`
are set — `/board` replies with a setup hint instead of failing.

## Lifecycle

```
Backlog → Ready (queue) → In progress → In review → Done
```

- **Backlog** — captured, not yet scoped.
- **Ready** — queued for work. This is the bot's inbox: a card here is work to
  pick up without being asked. `poll` reports a card entering it as `queued`
  (rather than a plain `moved`) precisely so a daemon can alert on it.
- **In progress** — actively being worked.
- **In review** — awaiting review / QA / operator approval. **This column
  means "parked on the operator."**
- **Done** — shipped.

Keep the columns coarse. A fuller per-task flow (discovery → plan → execution
→ review → deploy) belongs **inside the card** — its body and comments — not
as extra Status columns.

## Hand decisions off through the BOARD, not chat

When the bot needs a decision, an approval, or a review, it should **create a
card**, not send a chat message. A message scrolls away and dies with the
session; a board card is durable, actionable from a phone, and survives
context compaction.

- Create it: `gh_projects.py add "<title>" --body-file <path>`, then
  `set <title> Priority P<n>` and `move <title> "In review"`.
- Title convention: prefix `DECISION:` / `REVIEW:` / `APPROVAL:` so the column
  scans at a glance.
- **Put the whole decision IN the card** — what was found, the evidence
  (`file:line`, live output), what was already done, what was deliberately
  NOT done and why, and the concrete options with their consequences. The
  operator should be able to answer without asking a follow-up.
- Still send a one-line nudge on Telegram — the card is the durable record,
  the message is the ping. Don't paste the card into chat; point at it.

## Command reference (`tools/v2/gh_projects.py`)

```
gh_projects.py init                    # introspect the board, cache field/option IDs
gh_projects.py render                  # board grouped by Status (Telegram markdown)
gh_projects.py move  <item> "<status>" # set the Status (column)
gh_projects.py set   <item> <field> "<value>"    # e.g. set Priority P0 / Size L
gh_projects.py add   "title" ["body"] | "title" --body-file <path>
gh_projects.py edit  <item> --body-file <path> [--title "<t>"] [--force]
gh_projects.py sync                    # seed from memory/tasks/board.json
gh_projects.py poll                    # diff vs snapshot -> {"changes":[…]} JSON
gh_projects.py fields                  # dump discovered fields + options
```

`<item>` = a unique title-substring or the item id.

**Always pass a card body via `--body-file`.** A card body is full of
backticks and `$`, and as an argv string the shell command-substitutes them
before the tool ever sees them — that silently eats `file:line` references
and code snippets.

**A body rewrite is destructive and GitHub keeps NO history for a draft
issue.** `edit` therefore REFUSES to replace a non-empty body without
`--force`. **Read the card, merge your new text into what is already there,
then pass `--force`** — never reach for the flag just to skip the read; that
is how a decision gets silently overwritten. This also requires the client to
actually fetch the `body` field: a query that omits it reads back as empty
and would make a real card look safe to discard.

**Correct a card in place with `edit`** — don't add a replacement and retire
the original; that habit is how a board accumulates "SUPERSEDED: …" pairs.
`edit` works on **draft cards only** — a real issue's body lives in the issue.

`poll` rewrites `memory/tasks/gh_project.snapshot.json` so each change is
reported exactly once. When the bot changes a Status itself, the client acks
that change into the snapshot so the next poll doesn't alert the operator
about the bot's own action — narrowly, only the item just touched, so a
concurrent operator move isn't swallowed too.

## Caveat — the API can't manage views

GitHub's GraphQL API can read/write **items and field values**, but it
**cannot create, delete, or rename project VIEWS** (the saved column/table
layouts). Those are UI-only. `move`/`set` change a card's Status field (which
drives the board grouping); reorganising the *view layout itself* must be
done in the GitHub web UI.
