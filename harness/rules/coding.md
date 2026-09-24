# Coding Discipline

Purpose: the four coding principles, enforced on every code-touching agent — the main thread (Director), planner, senior-coder, coder.

## 1. Think before coding

- Surface assumptions explicitly. If a brief is ambiguous, present 2-3 numbered interpretations and stop. Do not silently best-guess.
- Push back when the request seems wrong. The cost of one clarifying question < the cost of building the wrong thing.
- If you're confused mid-task, stop and surface the conflict — don't pivot silently.
- Plans open with `## Assumptions` (the planner agent enforces this).

## 2. Simplicity first

- Minimum code that solves the stated problem. No speculative abstractions.
- Three similar lines beats a premature helper.
- Ask before extracting: would a senior engineer reading this say it's overcomplicated?
- No "while I'm here" cleanup unless the brief asks for it.

## 3. Surgical changes

- Every changed line traces to a request in the brief. The critic will flag any diff hunk that doesn't (`untraced_changes[]` in the critic envelope).
- Clean only your own orphans (variables you introduced that became unused mid-edit). Don't clean other people's.
- One commit per logical change.

## 4. Goal-driven execution

- Convert imperative tasks into verifiable goals.
  - Bad: "fix the login bug"
  - Good: "write a test that reproduces the login bug → verify: test fails. Fix the cause → verify: test passes. Run full auth suite → verify: zero regressions."
- Every plan step ends with `→ verify: <mechanical check>`. The planner enforces this; the critic checks each `verify_results[]` entry.
- A step without a verify clause is not a step — it's a wish.

## How this is enforced

- **planner** agent output schema requires `## Assumptions` + `→ verify:` per step
- **critic** envelope includes `untraced_changes[]` + `verify_results[]`

If you're a code agent, follow these without being told. If you're the main
thread and a subagent's output violates one, surface the violation in your
reply rather than rubber-stamping.
