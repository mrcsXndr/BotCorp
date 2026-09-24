# /critic — manual credibility-pass

Use this slash command when you want a deliberate credibility check on a
subagent result (or something you wrote yourself) before acting on it. The
harness ships no automatic per-subagent scoring — `SubagentStart`/`SubagentStop`
only append one line each to the activity log — so this is the only source of
a credibility grade.

## Usage

`/critic <path-to-result-file>` — scores the file's content against any cited
evidence and writes a JSON envelope to `memory/sessions/<id>/critic-<ts>.json`.

If no path is given, score the most recent subagent result in the current
session.

## Implementation

1. Resolve the result file: argument OR most recent in `memory/sessions/<session-id>/`.
2. Read the result file content.
3. Invoke `Agent(subagent_type="critic", prompt="Score this result for credibility:\n\n<content>")`.
4. Parse the JSON the critic returns.
5. Write to `memory/sessions/<session-id>/critic-<timestamp>.json`.
6. Echo the overall_score + top red_flags inline.
