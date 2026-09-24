---
name: prove-the-guard-catches-the-real-defect
description: A regression guard is only proven by running it against the actual historical defect from version control, not a hand-written sample — and an unexpected mutation-test result is evidence about your own setup before it's evidence about the code
metadata:
  type: lesson
---

# Mutation-test the guard against the real defect, not a synthetic sample

When a regression guard is written to prevent a specific defect, the only
thing that proves it works is running it against the **real pre-fix code**,
pulled from version control. A self-check built from a hand-written sample
proves the guard handles the sample — nothing about whether it handles the
bug that actually happened.

**Why.** Two safety artifacts can both look complete and both be broken in
the same way: a detector written against an imagined shape of the bug that
doesn't match the shape the bug actually had in the codebase (e.g. scanning
forward for a literal when the real defect was a variable reference to a
literal defined elsewhere), and a test gated behind an environment flag that
appears nowhere except its own file — never wired into the actual test
runner or CI — so "all green" describes zero real executions. Both can be
reported as verification with full confidence, because the person reporting
described the exact failure mode moments earlier and still walked into it,
twice, in the artifacts meant to prevent it.

**How to apply.**
- **Mutation-test the guard, not just the fix.** Pull the pre-fix version of
  the file from version control into a temp location, run the guard over it,
  and require it to FAIL. If it passes, the guard is decorative.
- **Assert a non-zero work count.** A guard that iterates a collection must
  assert the collection isn't empty, or it silently stops guarding the day
  its own discovery mechanism breaks.
- **Search for any test-enabling flag repo-wide.** If it appears only in the
  file that reads it, the test never runs anywhere real.
- **"All green" is a claim about which tests ran.** Before reporting a suite
  as verification, confirm the specific behavior under review is actually
  exercised by it — a skipped test and a passing test look identical in a
  summary count.
- **An unexpected mutation result is evidence about your setup first.**
  Confirm the mutation actually landed (diff before/after — an unchanged diff
  where you expected a change means nothing reverted; some version-control
  commands do nothing to already-committed content), and clear any build or
  transform cache before trusting a "still passes after breaking it" or
  "still fails after fixing it" result. Predict the expected outcome before
  running, so a mismatch reads as your bug, not the code's.

Related: [[one-agent-one-thread]] · [[exit-zero-hides-outages]] ·
[[subagent-verified-is-not-verified]]
