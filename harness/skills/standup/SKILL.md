---
name: standup
description: Pre-standup prep — pull previous meeting notes, check ticket / repo status, surface action items still open.
allowed-tools: Bash, Read, Glob, Grep, Write
---

# /standup — Dev Meeting Prep

Run before a recurring standup (daily, three-weekly, whatever cadence applies). Pulls together everything you'd otherwise scramble for in the first five minutes.

## Steps

1. **Previous meeting notes** — Look for the most recent meeting recap, in whichever store you keep them:
   - Google Drive folder of meeting notes — `bash tools/google/drive.sh search "meeting notes"`
   - Email digests — `bash tools/google/gmail.sh search "standup notes"`
   - A team Notion / Google Doc — fetch via the relevant tool / MCP
   - Extract: key decisions, action items + owners, unresolved topics carried forward.

2. **Ticket / repo status** — pick whichever tracker(s) the team uses:
   - GitLab / GitHub / Linear / Jira — list open issues filtered to recently updated, unassigned, or blocked
   - Recently merged PRs / MRs since the last standup
   - Open PRs / MRs awaiting review (highlight stale ones)
   - For each ticket carried over from last standup, note current state

3. **Backlog / TDL cross-reference** — if the team maintains a checklist sheet or document:
   - `bash tools/google/sheets.sh read <spreadsheet-id> <range>` (configure the IDs in `context/`)
   - Flag status changes since last standup
   - Highlight blocker items still not started

4. **Output format**:

```
## Standup Prep — [Date]

### Previous Meeting Recap ([date])
- Decisions: [key decisions]
- Action items:
  - [person] — [action] — [status: done / pending / unknown]
- Carried forward: [unresolved topics]

### Open Issues / Tickets
- [tracker]#123 — [title] — [assignee] — [age]

### Open PRs / MRs
- [repo]!42 — [title] — [author] — [age, last activity]

### Backlog Blockers
- [task] — [priority] — [status] — [owner]

### Talking Points for Today
- [suggested topics based on above analysis]
```

5. Save to `meetings/dev/YYYY-MM-DD-prep.md` (or wherever you store meeting notes).

## Configuration

Put project-specific values in `context/` rather than hard-coding them in the skill — IDs, sheet ranges, group / org slugs. That way one skill works across multiple projects and survives a re-org.

## API patterns (examples)

```javascript
// GitLab
const TOKEN = process.env.GITLAB_PERSONAL_ACCESS_TOKEN;
fetch('https://gitlab.com/api/v4/issues?state=opened&scope=assigned_to_me', {
  headers: { 'PRIVATE-TOKEN': TOKEN }
});
```

```bash
# GitHub via gh CLI
gh issue list --assignee @me --state open
gh pr list --search "review-requested:@me"
```
