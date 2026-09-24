---
name: weekly
description: Weekly review across the operator's domains — what shipped, what slipped, what's next.
allowed-tools: Bash, Read, Glob, Grep, Write, Edit
---

# /weekly — Weekly Review

Run on Friday afternoon (or Sunday evening — whatever rhythm fits) to close the loop on the week.

## Steps

1. **Per-domain summary** — for each domain listed in `CLAUDE.md` (work / side-project / personal):
   - Recent commits / merged PRs across the relevant repos (`git log --since="7 days ago"`)
   - Tickets closed (GitHub / GitLab / Linear)
   - Tasks marked done in Google Tasks or the task-board sheet
   - Notable decisions captured in memory or context docs

2. **Meeting recap** — summarise this week's standup / one-to-one / weekly meeting notes from wherever you save them (`meetings/dev/`, `meetings/mgmt/`, etc.).

3. **Tracker reconciliation** — for each tracker the operator keeps, list items currently in flight, blocked, or overdue (check `memory/` project notes and the commitments store: `python tools/v2/commitments.py list --open`).

4. **Ask the operator to fill in the gaps:**
   - Energy this week (1–5)
   - Biggest blocker
   - One thing to drop next week
   - Top three priorities for next week

5. **Save** to `meetings/weekly/YYYY-Www.md` (ISO week number — `date +%G-W%V`). Future-you will appreciate the consistent naming.

## Optional: highlight reel

If the operator wants a short version to share (in Slack, with their manager, on a personal blog), generate a 4-line bullet list at the top: shipped, learned, blocked, next.
