---
name: unrequested-field-reads-as-empty
description: A field a query never asked for comes back absent, and absence read as "empty" can authorize a destructive overwrite — check the projection before concluding a record is blank, especially right before a write that discards it
metadata:
  type: lesson
---

# Absent is not evidence of empty

Before concluding a record is EMPTY, confirm the read actually **asked for
that field**. A query with a narrow projection returns absence for anything
it didn't select, and absence is not evidence of emptiness — it is evidence
of nothing at all.

**Why.** In one incident, a list-items query for a kanban-style board
selected only a title field — no body. Every card therefore came back with
`body` absent, always. Reading one card, seeing no body, and concluding "this
card's body is empty" led to overwriting it with new content. It was not
empty — every card on that board had a body; that only became visible after
adding the field to the query, which was after the destructive write. The
platform kept no version history for that record type, so the prior content
was genuinely gone and had to be reconstructed from other evidence, which is
not the same as not having lost it.

The tell, in hindsight: the conclusion came from a function whose source had
not been read. One search for the query text would have shown the field was
never selected.

**How to apply.**
- **A destructive write needs its own read, not a cached or assumed one.**
  Fetch the exact field you are about to replace, in the same call that
  replaces it, and refuse to proceed when it is non-empty unless explicitly
  forced.
- **"Absent" and "empty" are different answers.** If the API/store can return
  both, keep them distinguishable (missing vs. empty string/array) and never
  let the ambiguous one authorize an irreversible action.
- **Ask what the durable copy is before the write, not after.** Records with
  no version history (draft issues, chat messages, in-memory state) should be
  mirrored somewhere durable before anything overwrites them, not
  reconstructed after the fact.
- This is distinct from a value an upstream *deliberately* emitted (e.g. an
  empty list as a real declaration) — here nothing was emitted at all, the
  query simply never asked. Diagnose which one you're looking at before
  trusting either.

Related: [[subagent-verified-is-not-verified]] · [[prove-the-guard-catches-the-real-defect]]
