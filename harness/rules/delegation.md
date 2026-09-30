# Delegation: the main thread orchestrates, subagents do the work

Purpose: keep the main thread's context for orchestration by default. A long
session stays viable only when the file reads and search results live in
subagent transcripts, not in the main thread.

## When to delegate

- **Delegate** anything that touches more than 1 file, needs more than 3
  searches, or is a multi-step research or build task.
- **Do it directly** when it's a single-fact lookup at a location you already
  know, or a one-line edit to a file you have already read.
- Once you delegate a search, don't run it yourself as well. Wait for the
  result.

## How

- **Fan out.** Send independent subagents in ONE message so they run
  concurrently, for example reviewing N areas at once.
- **Pick the cheapest tier that does the job well** (`models.md`):
  - `coder` (the default) for edits, batches, research and tests;
  - `one-shot` for lookups;
  - `planner` or `senior-coder` for architecture and cross-layer builds.
- **Keep one writer per work tree.** Reviews can run in parallel; writes to one
  tree can't.
- **Put this in every brief:** "Keep what you write minimal; your final report
  is short: conclusions, file:line evidence, what you did not do." Subagents
  default to long write-ups.
- **Relay only the conclusion.** Don't paste a subagent's output into the
  main thread and don't re-read what it already read. Write durable findings
  to the Journal.
- **Verify before acting.** A subagent's "verified" covers only the failure
  modes it thought of. Before an external write or a "done" claim, check
  whatever has a real-world surface yourself, or run a deliberate `critic`
  pass.
