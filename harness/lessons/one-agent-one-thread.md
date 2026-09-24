---
name: one-agent-one-thread
description: Review can be a team activity but a git working tree can only have one writer at a time — a second writer, or the orchestrator "helping" inside someone else's tree, manufactures convincing-looking wrong results
metadata:
  type: lesson
---

# One writer per working tree — review with a team, execute solo

Before a non-trivial change to a production system, a review pass (multiple
independent agents, distinct angles: adversarial diff review, system audit,
monitoring/blind-spot audit) catches things a single author-and-only-reader
misses. Fan out the *looking*; keep the *doing* — anything that mutates a
live system — to one agent that holds the authorization for it.

**Why.** Fanning work out across many executing agents multiplies the number
of places a mistake can hide and makes "who owns this change" ambiguous.
Worse, once a single writer is established, contaminating its tree from
outside is easy to do by accident and hard to detect:

- **A second checkout silently moves the tree.** If a reviewer is reading a
  specific commit and a second agent checks out its own branch in the *same*
  working copy, the reviewer's plain-path reads and any gate it runs now
  belong to a different commit than the one it thinks it's reviewing. A green
  review of the wrong tree is worse than no review — it *feels* like
  evidence.
- **"Helping" inside someone else's tree corrupts the experiment.** Editing a
  file to test something (e.g. temporarily disabling a fix to prove a test
  isn't vacuous) while the tree's actual owner is still working means it can
  restore its own line mid-run. The test then "passes with the fix disabled"
  — manufacturing a false accusation, not revealing one.
- **Pinging an idle agent is itself a write.** Asking a quiet agent "are you
  done?" can wake it and restart its work; verifying against the same commit
  from outside its tree while it resumes produces a mutation-test result that
  indicts the wrong party.
- **Re-invoking an agent by name does not redirect it — it spawns a new
  one.** Sending a follow-up through a fresh "start agent" call with the same
  display name creates a second writer on the same tree instead of
  continuing the first. Only a genuine "send message to the running agent"
  mechanism continues it; starting always starts something new.

**How to apply.**
- Before dispatching a second agent into a repo, ask what the first one is
  doing with the tree. One writer, always.
- Brief reviewers to read through version-control refs (`git show <sha>:<path>`,
  a diff between two commits), never plain paths in a shared tree. If a real
  checkout is needed, use an isolated worktree — never check out over a tree
  someone else is using.
- To verify something yourself, do it on a tree you own (after taking
  ownership, or on an isolated checkout of the same commit) — never inside
  the live tree of an agent still working.
- To send a running agent a correction, use whatever mechanism actually
  continues an existing agent, not the mechanism that starts one. Read the
  identifier a spawn call returns — a *new* identifier means you now have two
  writers, not one redirected.
- If a mutation-test or verification result surprises you — a change killed
  by tests with no causal path to it, a fix that "doesn't take" — suspect a
  race in your own setup before concluding the other party's work is wrong.

Related: [[edit-tool-not-scripts]] · [[subagent-verified-is-not-verified]] ·
[[prove-the-guard-catches-the-real-defect]]
