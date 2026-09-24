#!/usr/bin/env python3
"""Critic — credibility-pass on subagent output.

The actual scoring lives in `.claude/agents/critic.md` (model: sonnet) and
is invoked via Claude Code's native subagent dispatch — NOT the Anthropic
Python SDK.

AUTO CRITIC-PASS: RETIRED 2026-06-10
------------------------------------
The automatic post-subagent envelope path (PostToolUse matcher `Agent|Task`
and the `SubagentStop` hook -> this script) is RETIRED. It produced ZERO
graded reviews ever (0 critic-*.json files) and is no longer wired in
`.claude/settings.json`.

WHAT REMAINS: the MANUAL, gated critic — invoke deliberately when a
credibility check is wanted:

  1. From the main thread: `Agent(subagent_type="critic", prompt=...)`
     — Claude Code routes it to the sonnet-tier agent definition.
  2. Via the `/critic <result-file>` slash command (.claude/commands/critic.md).

The `score` command below remains only as a backwards-compatible envelope
writer for any caller still passing task/result files. It does NOT score —
scoring is the agent's job. A gated, on-demand critic is the defensible
version; the auto-fire-on-every-return version was not.

Output contract (unchanged for backwards compatibility):
{
  "status": "deferred-to-agent-layer",
  "phase": 2,
  "task_file": "...",
  "result_file": "...",
  "claims": [],          # populated by the critic agent when invoked
  "overall_score": null, # ditto
  "red_flags": [],
  "note": "invoke via Agent(subagent_type='critic', ...) for actual scoring"
}

CLI
---
critic score <task_file> <result_file>
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def cmd_score(task_file: str, result_file: str) -> int:
    tp = Path(task_file)
    rp = Path(result_file)
    if not rp.exists():
        print(f"ERROR: result file not found: {rp}", file=sys.stderr)
        return 1
    if not tp.exists():
        print(f"WARN: task file not found: {tp}", file=sys.stderr)

    payload = {
        "status": "manual-only",
        "task_file": str(tp),
        "result_file": str(rp),
        "claims": [],
        "overall_score": None,
        "red_flags": [],
        "note": (
            "Auto critic-pass retired 2026-06-10. Critic scoring is performed "
            "by the Claude Code subagent (.claude/agents/critic.md, "
            "model=sonnet) only when invoked deliberately — via "
            "Agent(subagent_type='critic', prompt=...) or the /critic "
            "slash command."
        ),
    }
    print(json.dumps(payload, indent=2))
    return 0


USAGE = """\
critic — credibility-pass envelope writer (auto-pass RETIRED 2026-06-10)

Usage:
  critic.py score <task_file> <result_file>

Returns a backwards-compatible JSON envelope. The auto post-subagent hook
is retired. Actual credibility scoring is performed by the Claude Code
subagent (.claude/agents/critic.md, model=sonnet) ONLY when invoked
deliberately — via Agent(subagent_type="critic", ...) or /critic.
"""


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(USAGE, file=sys.stderr)
        return 2
    cmd = argv[1]
    if cmd in ("-h", "--help", "help"):
        print(USAGE)
        return 0
    if cmd == "score" and len(argv) >= 4:
        return cmd_score(argv[2], argv[3])
    print(USAGE, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
