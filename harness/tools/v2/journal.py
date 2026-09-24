#!/usr/bin/env python3
"""Director's journal — live structured working memory per session.

Storage works and is the proven, load-bearing piece of the v2 channels.
(The old `compact` subcommand was a never-wired stub returning
not_implemented and was REMOVED 2026-06-10. Journal->Timeline distillation
is done by tools/v2/timeline.py build, which is what TG `/compact` already
calls.)

Storage
-------
memory/sessions/<session_id>/journal.md

Format
------
YAML front-matter (session_id, started_at, last_updated)
followed by ## sections per kind:
  ## Findings
  ## Decisions
  ## Open Questions
  ## Hypotheses
  ## Actions

Each entry is a single line bullet prefixed with `- [HH:MM:SS]`.

CLI
---
journal new <session_id>
journal append <session_id> <kind> <text...>
journal read <session_id>
journal path <session_id>                # prints absolute path

(distillation: use `tools/v2/timeline.py build <session_id>`)
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _session import resolve_session_id  # noqa: E402
from safe_write import safe_replace  # noqa: E402  atomic+locked write substrate
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import instance_root  # noqa: E402

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

REPO_ROOT = instance_root()
SESSIONS_DIR = REPO_ROOT / "memory" / "sessions"

KINDS = {
    "finding": "Findings",
    "decision": "Decisions",
    "observation": "Observations",
    "question": "Open Questions",
    "hypothesis": "Hypotheses",
    "action": "Actions",
}

SECTION_ORDER = ["Findings", "Decisions", "Observations", "Open Questions", "Hypotheses", "Actions"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _now_hms() -> str:
    return datetime.now(timezone.utc).strftime("%H:%M:%S")


def _journal_path(session_id: str) -> Path:
    return SESSIONS_DIR / session_id / "journal.md"


def _initial_template(session_id: str) -> str:
    ts = _now_iso()
    body = [
        "---",
        f"session_id: {session_id}",
        f"started_at: {ts}",
        f"last_updated: {ts}",
        "channel: director-journal",
        "---",
        "",
        "# Director's Journal",
        "",
        "> Live structured working memory. Append entries as the session progresses.",
        "> Idempotent — duplicate appends within the same minute are skipped.",
        "",
    ]
    for section in SECTION_ORDER:
        body.append(f"## {section}")
        body.append("")
        body.append("_(none yet)_")
        body.append("")
    return "\n".join(body) + "\n"


def _ensure_session_dir(session_id: str) -> Path:
    sess = SESSIONS_DIR / session_id
    sess.mkdir(parents=True, exist_ok=True)
    return sess


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_new(session_id: str) -> int:
    _ensure_session_dir(session_id)
    p = _journal_path(session_id)
    if p.exists():
        print(json.dumps({"status": "exists", "path": str(p)}))
        return 0
    p.write_text(_initial_template(session_id), encoding="utf-8")
    print(json.dumps({"status": "created", "path": str(p)}))
    return 0


def _build_appended(content: str, section: str, entry: str, bare: str) -> tuple[str, bool]:
    """Pure transform: insert `entry` into `section` of `content`.

    Returns (new_content, duplicate). If `bare` already appears in the target
    section, duplicate=True and new_content == content (no change). This is
    the exact logic that used to live inline in cmd_append — extracted so it
    can run under safe_replace's lock against the CURRENT on-disk content.
    """
    section_marker = f"## {section}"
    if section_marker not in content:
        # Section missing — append it at end.
        if content and not content.endswith("\n"):
            content += "\n"
        content += f"\n## {section}\n\n_(none yet)_\n"

    lines = content.splitlines()
    out: list[str] = []
    in_section = False
    appended = False
    duplicate = False
    for line in lines:
        if line.strip() == section_marker:
            in_section = True
            out.append(line)
            continue
        if in_section and line.startswith("## ") and line.strip() != section_marker:
            # leaving target section — inject entry before next section header
            if not appended:
                while out and out[-1].strip() in ("", "_(none yet)_"):
                    out.pop()
                out.append("")
                out.append(entry)
                out.append("")
                appended = True
            in_section = False
            out.append(line)
            continue
        if in_section and line.strip().endswith(bare):
            duplicate = True
        out.append(line)
    if in_section and not appended:
        # File ended inside target section
        while out and out[-1].strip() in ("", "_(none yet)_"):
            out.pop()
        out.append("")
        out.append(entry)
        out.append("")
        appended = True

    if duplicate:
        return content, True

    new_content = "\n".join(out)
    if not new_content.endswith("\n"):
        new_content += "\n"
    return _bump_last_updated(new_content), False


def cmd_append(session_id: str, kind: str, text: str) -> int:
    if kind not in KINDS:
        print(f"ERROR: unknown kind '{kind}'. Valid: {', '.join(KINDS)}", file=sys.stderr)
        return 2
    section = KINDS[kind]
    p = _journal_path(session_id)
    if not p.exists():
        cmd_new(session_id)

    bare = text.strip()
    entry = f"- [{_now_hms()}] {bare}"

    # Route the read-modify-write through safe_write.safe_replace so the whole
    # transform runs atomically under an exclusive file lock against the
    # CURRENT on-disk content. This makes concurrent appends (e.g. the Stop
    # cost-meter writing while the Director appends) safe — they serialize
    # instead of clobbering. Public API/output of cmd_append is unchanged.
    captured = {"duplicate": False}

    def _transform(current: str) -> str:
        new_content, dup = _build_appended(current, section, entry, bare)
        captured["duplicate"] = dup
        return new_content  # == current when dup -> safe_replace reports noop

    result = safe_replace(p, _transform, create=True)

    if captured["duplicate"]:
        print(json.dumps({"status": "duplicate-skipped", "path": str(p)}))
        return 0
    if result.get("status") in ("written", "noop"):
        print(json.dumps({"status": "appended", "section": section, "path": str(p)}))
        return 0
    # safe_write reported a non-write status (lock-timeout / drift / error).
    print(json.dumps({"status": result.get("status", "error"),
                      "section": section, "path": str(p),
                      "detail": result.get("error") or result.get("note")}))
    return 1


def _bump_last_updated(content: str) -> str:
    ts = _now_iso()
    out_lines: list[str] = []
    in_fm = False
    fm_count = 0
    for line in content.splitlines():
        if line.strip() == "---":
            fm_count += 1
            in_fm = fm_count == 1
            out_lines.append(line)
            continue
        if in_fm and line.startswith("last_updated:"):
            out_lines.append(f"last_updated: {ts}")
        else:
            out_lines.append(line)
    return "\n".join(out_lines) + ("\n" if content.endswith("\n") else "")


def cmd_read(session_id: str) -> int:
    p = _journal_path(session_id)
    if not p.exists():
        print(f"ERROR: no journal at {p}", file=sys.stderr)
        return 1
    sys.stdout.write(p.read_text(encoding="utf-8"))
    return 0


def cmd_path(session_id: str) -> int:
    print(_journal_path(session_id))
    return 0


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

USAGE = """\
journal — director's journal CRUD

Usage:
  journal.py new <session_id>
  journal.py append <session_id> <kind> <text...>
  journal.py read <session_id>
  journal.py path <session_id>

Kinds: finding, decision, observation, question, hypothesis, action
Distillation: tools/v2/timeline.py build <session_id>
"""


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(USAGE, file=sys.stderr)
        return 2
    cmd = argv[1]
    if cmd in ("-h", "--help", "help"):
        print(USAGE)
        return 0
    if cmd == "new" and len(argv) >= 3:
        return cmd_new(resolve_session_id(argv[2]))
    if cmd == "append" and len(argv) >= 5:
        return cmd_append(resolve_session_id(argv[2]), argv[3], " ".join(argv[4:]))
    if cmd == "read" and len(argv) >= 3:
        return cmd_read(resolve_session_id(argv[2]))
    if cmd == "path" and len(argv) >= 3:
        return cmd_path(resolve_session_id(argv[2]))
    print(USAGE, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
