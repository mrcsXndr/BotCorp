---
name: subagent-verified-is-not-verified
description: A subagent's own "verified, looks good, N/N checks passing" is a claim, not evidence — its verification is scoped to the failure modes it thought to check, and the orchestrator must independently confirm anything with a real-world surface before it ships
metadata:
  type: lesson
---

# A subagent's "verified" is a claim, not a check you ran

A subagent reporting **"done and verified — checks clean, N/N passing"** has
told you its own checks passed. It has not told you the thing is actually
right, because whatever it failed to think to check is exactly what it will
not report. This is not dishonesty — an honest, well-written report can still
miss a defect the agent never looked for.

**Why.** Automated checks (structural assertions, lint, console-error scans,
a fixed set of unit tests) catch the failure modes someone anticipated and
are blind to everything else. A subagent building a visual feature, a data
pipeline, or an integration can pass every check it wrote and still ship a
defect that only shows up when a human — or the orchestrator — actually looks
at the output. In one instance, an agent shipped a visual feature with a
genuinely honest report that even volunteered several weak spots
unprompted — and still didn't mention the actual visible defect, a rendering
artifact, because it had never rendered and looked at the result itself.

**How to apply.**
- Whenever a subagent's output has a real-world surface — visual, a live
  write, an external API call, generated content a person will read — the
  orchestrator inspects the actual output before relaying it, not just the
  subagent's summary of it. For visual work: render it and look, at more than
  one viewport/scroll position, not one whole-page capture; crop into dense
  or transformed regions, since a defect that reads as texture at page scale
  can read as an obvious flaw at full zoom.
- Treat the subagent's green checks as *necessary*, never *sufficient*.
- Pick the verification metric that would actually catch the failure you're
  worried about — an aggregate mean can dilute a small, real defect to
  invisibility while a localized measure catches it.
- If you've already rejected one questionable result on this task, a second
  one landing unverified is not a coincidence — tighten the check before it
  becomes a third.

Related: [[one-agent-one-thread]] · [[prove-the-guard-catches-the-real-defect]] ·
[[unrequested-field-reads-as-empty]]
