#!/usr/bin/env python3
"""Critic's timeline — chronological distilled narrative.

Phase 2: LLM-distilled by default (Opus 4.8 via claude CLI). Falls back
to structural extraction with `--structural` flag.

Storage
-------
memory/sessions/<session_id>/timeline.md
memory/timelines/<since>.md   (cross-session distill)

CLI
---
timeline build <session_id>                # LLM-distilled (default, Opus)
timeline build <session_id> --structural   # cheap structural extraction
timeline read <session_id>
timeline distill <since>                   # cross-session, e.g. "2026-W18"
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _session import resolve_session_id  # noqa: E402
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import instance_root  # noqa: E402

REPO_ROOT = instance_root()
SESSIONS_DIR = REPO_ROOT / "memory" / "sessions"
TIMELINES_DIR = REPO_ROOT / "memory" / "timelines"

DISTILL_MODEL = os.environ.get("BOT_DISTILL_MODEL", "claude-opus-4-8")
DISTILL_TIMEOUT = int(os.environ.get("BOT_DISTILL_TIMEOUT", "180"))

# When this script runs DETACHED (precompact_timeline.py spawns it with no
# console), the inner claude.exe would otherwise get a NEW visible console
# window (2026-07-13: "2 empty claude windows" incident). CREATE_NO_WINDOW
# keeps the headless run silent; harmless when a console exists.
_NO_WINDOW = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _journal_path(session_id: str) -> Path:
    return SESSIONS_DIR / session_id / "journal.md"


def _timeline_path(session_id: str) -> Path:
    return SESSIONS_DIR / session_id / "timeline.md"


def _parse_journal_sections(text: str) -> dict[str, list[str]]:
    sections: dict[str, list[str]] = {}
    current: str | None = None
    for line in text.splitlines():
        m = re.match(r"^##\s+(.+)$", line)
        if m:
            current = m.group(1).strip()
            sections.setdefault(current, [])
            continue
        if current is None:
            continue
        s = line.strip()
        if s.startswith("- [") and "]" in s:
            sections[current].append(s)
    return sections


def _structural_build(session_id: str) -> int:
    jp = _journal_path(session_id)
    if not jp.exists():
        print(f"ERROR: no journal at {jp}", file=sys.stderr)
        return 1
    sections = _parse_journal_sections(jp.read_text(encoding="utf-8"))

    decisions = sections.get("Decisions", [])
    findings = sections.get("Findings", [])
    observations = sections.get("Observations", [])
    questions = sections.get("Open Questions", [])
    actions = sections.get("Actions", [])

    out = [
        "---",
        f"session_id: {session_id}",
        f"built_at: {_now_iso()}",
        "channel: critic-timeline",
        "phase: 1-structural",
        "---",
        "",
        "# Critic's Timeline (structural)",
        "",
        "## Key Decisions",
        "",
    ]
    out.extend(decisions[:10] or ["_(none recorded)_"])
    out.extend(["", "## Top Findings", ""])
    out.extend(findings[:10] or ["_(none recorded)_"])
    out.extend(["", "## Notable Observations", ""])
    out.extend(observations[:15] or ["_(none recorded)_"])
    out.extend(["", "## Open Questions", ""])
    out.extend(questions or ["_(none recorded)_"])
    out.extend(["", "## Actions Taken", ""])
    out.extend(actions[:20] or ["_(none recorded)_"])
    out.append("")

    tp = _timeline_path(session_id)
    tp.parent.mkdir(parents=True, exist_ok=True)
    tp.write_text("\n".join(out) + "\n", encoding="utf-8")
    print(json.dumps({
        "status": "built-structural",
        "path": str(tp),
        "decisions": len(decisions),
        "findings": len(findings),
        "observations": len(observations),
        "questions": len(questions),
    }))
    return 0


DISTILL_PROMPT_TEMPLATE = """You are the Critic distilling a chronological timeline for a long-running agent session. Output Markdown only — no preamble, no surrounding code fence.

Inputs:
- Director's Journal (live working memory, six entry types)
- Latest Critic Review (credibility-graded findings, JSON)
- Previous Timeline (prior distillation, may be empty)

Rules (Slack three-channel pattern):
- Include only credible findings (citations or clear evidence). Down-weight speculative claims.
- Deduplicate identical events. Resolve timestamp conflicts via evidence strength.
- Maintain chronological order.
- Mark the top-3 evidence gaps at the end.
- Apply the 5-band credibility rubric: 0.9-1.0 trustworthy, 0.7-0.89 highly-plausible, 0.5-0.69 plausible, 0.3-0.49 speculative, 0.0-0.29 misguided.
- THREADS use the bookend+window shape (Hermes): each distinct workstream is one line of GOAL -> WHAT HAPPENED -> RESOLUTION, so a future session can reconstruct context from the Threads alone without re-reading the journal or transcript. An open thread has resolution "OPEN: <next step / blocker>".

Output structure (verbatim sections, in this order):
---
session_id: {session_id}
built_at: {built_at}
channel: critic-timeline
phase: 2-distilled
distill_model: {model}
confidence_score: <0.0-1.0>
---

# Critic's Timeline (distilled)

## Narrative
<3-5 sentence summary>

## Threads (goal -> what happened -> resolution)
- <goal/intent> -> <what was done> -> <how it resolved, or "OPEN: <next step>">
- ...

## Chronology
- [HH:MM] event description
- [HH:MM] event description
...

## Evidence Gaps (top 3)
1. <gap description> — band: <speculative|...>
2. ...
3. ...

=== Director's Journal ===
{journal}

=== Latest Critic Review ===
{review}

=== Previous Timeline ===
{previous}
"""


def _llm_distill(session_id: str) -> int:
    jp = _journal_path(session_id)
    if not jp.exists():
        print(f"ERROR: no journal at {jp}", file=sys.stderr)
        return 1
    journal_text = jp.read_text(encoding="utf-8")

    sess_dir = SESSIONS_DIR / session_id
    critic_files = sorted(sess_dir.glob("critic-*.json"))
    latest_review = critic_files[-1].read_text(encoding="utf-8") if critic_files else "(no critic review yet)"

    tp = _timeline_path(session_id)
    previous_timeline = tp.read_text(encoding="utf-8") if tp.exists() else "(no previous timeline)"

    prompt = DISTILL_PROMPT_TEMPLATE.format(
        session_id=session_id,
        built_at=_now_iso(),
        model=DISTILL_MODEL,
        journal=journal_text,
        review=latest_review,
        previous=previous_timeline,
    )

    try:
        result = subprocess.run(
            # --setting-sources user: skip PROJECT settings so this headless
            # run can't load the repo-local telegram plugin and steal the
            # poller slot from the live bot (2026-07-13 incident).
            ["claude", "--print", "--model", DISTILL_MODEL,
             "--setting-sources", "user"],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=DISTILL_TIMEOUT,
            encoding="utf-8",
            errors="replace",
            **_NO_WINDOW,
        )
    except FileNotFoundError:
        print("ERROR: claude CLI not on PATH; falling back to structural", file=sys.stderr)
        return _structural_build(session_id)
    except subprocess.TimeoutExpired:
        print(f"ERROR: distill timed out after {DISTILL_TIMEOUT}s; falling back to structural", file=sys.stderr)
        return _structural_build(session_id)
    except Exception as e:
        print(f"ERROR: distill subprocess failed: {e!r}; falling back to structural", file=sys.stderr)
        return _structural_build(session_id)

    if result.returncode != 0:
        print(f"ERROR: claude exit {result.returncode}: {result.stderr[:500]}; falling back to structural", file=sys.stderr)
        return _structural_build(session_id)

    distilled = (result.stdout or "").strip()
    if not distilled or len(distilled) < 50:
        print("ERROR: distill output suspiciously short; falling back to structural", file=sys.stderr)
        return _structural_build(session_id)

    tp.parent.mkdir(parents=True, exist_ok=True)
    tp.write_text(distilled + ("\n" if not distilled.endswith("\n") else ""), encoding="utf-8")
    print(json.dumps({
        "status": "distilled",
        "path": str(tp),
        "model": DISTILL_MODEL,
        "size_chars": len(distilled),
    }))
    return 0


def cmd_build(session_id: str, structural_only: bool = False) -> int:
    if structural_only:
        return _structural_build(session_id)
    return _llm_distill(session_id)


def cmd_read(session_id: str) -> int:
    tp = _timeline_path(session_id)
    if not tp.exists():
        print(f"ERROR: no timeline at {tp}", file=sys.stderr)
        return 1
    sys.stdout.write(tp.read_text(encoding="utf-8"))
    return 0


def cmd_distill(since: str) -> int:
    """Cross-session distill — glob session timelines whose mtime >= since,
    concatenate, send to LLM, write memory/timelines/<since>.md.

    Phase 2: LLM-powered. Falls back to concatenation on error.
    """
    TIMELINES_DIR.mkdir(parents=True, exist_ok=True)
    target = TIMELINES_DIR / f"{since}.md"

    timelines: list[tuple[str, str]] = []
    for sd in sorted(SESSIONS_DIR.glob("*/timeline.md")):
        try:
            timelines.append((sd.parent.name, sd.read_text(encoding="utf-8")))
        except Exception:
            continue

    if not timelines:
        print(json.dumps({"status": "no-timelines", "since": since}))
        return 0

    bundled = "\n\n".join(f"=== Session {sid} ===\n{body}" for sid, body in timelines)

    prompt = f"""You are the Critic doing a cross-session distillation across {len(timelines)} session timelines from period {since}.

Output a single Markdown narrative covering:
- Major decisions made across the period
- Trustworthy findings worth carrying forward
- Open threads / blockers
- Top 3 evidence gaps

Apply the 5-band credibility rubric. Deduplicate.

=== INPUT TIMELINES ===
{bundled}
"""
    try:
        result = subprocess.run(
            # --setting-sources user: skip PROJECT settings so this headless
            # run can't load the repo-local telegram plugin and steal the
            # poller slot from the live bot (2026-07-13 incident).
            ["claude", "--print", "--model", DISTILL_MODEL,
             "--setting-sources", "user"],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=DISTILL_TIMEOUT,
            encoding="utf-8",
            errors="replace",
            **_NO_WINDOW,
        )
        if result.returncode == 0 and len(result.stdout or "") > 50:
            target.write_text(result.stdout, encoding="utf-8")
            print(json.dumps({"status": "distilled", "path": str(target), "sessions": len(timelines)}))
            return 0
    except Exception as e:
        print(f"WARN: cross-session distill failed: {e!r}; writing concatenated fallback", file=sys.stderr)

    target.write_text(f"# Cross-session timelines for {since} (concatenated fallback)\n\n{bundled}\n", encoding="utf-8")
    print(json.dumps({"status": "concatenated-fallback", "path": str(target), "sessions": len(timelines)}))
    return 0


USAGE = """\
timeline — critic's timeline (chronological distilled narrative)

Usage:
  timeline.py build <session_id>                # LLM-distilled (default, Opus)
  timeline.py build <session_id> --structural   # fast structural extraction
  timeline.py read <session_id>
  timeline.py distill <since>                   # cross-session, e.g. "2026-W18"

Env:
  BOT_DISTILL_MODEL    (default: claude-opus-4-8)
  BOT_DISTILL_TIMEOUT  (default: 180s)
"""


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(USAGE, file=sys.stderr)
        return 2
    cmd = argv[1]
    if cmd in ("-h", "--help", "help"):
        print(USAGE)
        return 0
    if cmd == "build" and len(argv) >= 3:
        structural = "--structural" in argv[3:]
        return cmd_build(resolve_session_id(argv[2]), structural_only=structural)
    if cmd == "read" and len(argv) >= 3:
        return cmd_read(resolve_session_id(argv[2]))
    if cmd == "distill" and len(argv) >= 3:
        return cmd_distill(argv[2])
    print(USAGE, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
