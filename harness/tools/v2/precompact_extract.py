#!/usr/bin/env python3
"""PreCompact extraction (hermes idea #5) — salvage durable memory before
Claude Code compacts and discards session context.

Wired as a PreCompact hook (see .claude/settings.json). On compaction, this
scans the CURRENT session's journal.md for `decision` and `finding` entries,
filters to the durable ones, and PROMOTES them into a long-term store
(memory/longterm/salvaged.md) so they survive the context window being
distilled away.

Contract / uncertainty
-----------------------
The PreCompact hook event is supported in current Claude Code builds; its
stdin payload is JSON like {"session_id": "...", "trigger": "auto|manual",
...}. We treat the payload defensively: if session_id is absent we fall back
to .claude/.current_session_id (written by session-start-v2.sh). If the
event name/contract differs in this build, the hook simply finds no session
and exits 0 — it can never block or fail compaction.

STRICTLY FAIL-OPEN. Any error -> print a status line and exit 0.

Durability heuristic (cheap, transparent)
------------------------------------------
- ALL `decision` entries are durable (chosen-path commitments).
- `finding` entries are durable EXCEPT transient bookkeeping lines
  (e.g. auto-generated "critic-pass: ..." summaries) which carry no
  cross-session value.
Dedupe: an entry already present in salvaged.md (by its text body) is
skipped, so repeated compactions in one session don't duplicate.

CLI
---
  precompact_extract.py --stdin                 # hook mode (reads JSON payload)
  precompact_extract.py --session <id>          # explicit session
  precompact_extract.py --session <id> --dry-run  # show what WOULD promote
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import instance_root  # noqa: E402

REPO_ROOT = instance_root()
SESSIONS_DIR = REPO_ROOT / "memory" / "sessions"
LONGTERM_DIR = REPO_ROOT / "memory" / "longterm"
SALVAGE_FILE = LONGTERM_DIR / "salvaged.md"
CURRENT_SESSION_FILE = REPO_ROOT / ".claude" / ".current_session_id"

# Section header -> kind (mirrors journal.py KINDS).
SECTION_TO_KIND = {
    "Findings": "finding",
    "Decisions": "decision",
    "Observations": "observation",
    "Open Questions": "question",
    "Hypotheses": "hypothesis",
    "Actions": "action",
}
DURABLE_KINDS = {"decision", "finding"}

ENTRY_RE = re.compile(r"^-\s+\[(\d{2}:\d{2}:\d{2})\]\s+(.*)$")
SECTION_RE = re.compile(r"^##\s+(.+?)\s*$")
PLACEHOLDER = "_(none yet)_"

# finding lines that are transient bookkeeping, not durable knowledge.
_TRANSIENT_FINDING_RE = re.compile(r"^critic-pass:", re.IGNORECASE)


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _resolve_session(explicit: str | None, stdin_mode: bool) -> str:
    if explicit:
        return explicit
    if stdin_mode and not sys.stdin.isatty():
        try:
            payload = sys.stdin.read()
            d = json.loads(payload or "{}")
            sid = d.get("session_id") or ""
            if sid:
                return sid
        except Exception:
            pass
    if CURRENT_SESSION_FILE.exists():
        try:
            return CURRENT_SESSION_FILE.read_text(encoding="utf-8").strip()
        except Exception:
            pass
    return ""


def _is_durable(kind: str, text: str) -> bool:
    if kind == "decision":
        return True
    if kind == "finding":
        return not _TRANSIENT_FINDING_RE.match(text.strip())
    return False


def _parse_durable(journal_text: str) -> list[dict]:
    out: list[dict] = []
    current_kind: str | None = None
    for line in journal_text.splitlines():
        m_sec = SECTION_RE.match(line)
        if m_sec:
            current_kind = SECTION_TO_KIND.get(m_sec.group(1).strip())
            continue
        if current_kind not in DURABLE_KINDS:
            continue
        m_e = ENTRY_RE.match(line.strip())
        if not m_e:
            continue
        body = m_e.group(2).strip()
        if not body or body == PLACEHOLDER:
            continue
        if _is_durable(current_kind, body):
            out.append({"kind": current_kind, "ts": m_e.group(1), "text": body})
    return out


def _already_salvaged() -> set[str]:
    if not SALVAGE_FILE.exists():
        return set()
    seen: set[str] = set()
    try:
        for line in SALVAGE_FILE.read_text(encoding="utf-8").splitlines():
            s = line.strip()
            # stored as "- [kind] text" — strip the "- [kind] " prefix for dedupe
            m = re.match(r"^-\s+\[[a-z]+\]\s+(.*)$", s)
            if m:
                seen.add(m.group(1).strip())
    except Exception:
        pass
    return seen


def run(session_id: str, dry_run: bool) -> dict:
    journal = SESSIONS_DIR / session_id / "journal.md"
    if not journal.exists():
        return {"status": "no-journal", "session_id": session_id, "promoted": 0}

    text = journal.read_text(encoding="utf-8", errors="replace")
    durable = _parse_durable(text)
    already = _already_salvaged()
    new_items = [d for d in durable if d["text"] not in already]

    if dry_run:
        return {
            "status": "dry-run",
            "session_id": session_id,
            "durable_found": len(durable),
            "already_salvaged": len(durable) - len(new_items),
            "would_promote": len(new_items),
            "items": [f"[{d['kind']}] {d['text']}" for d in new_items],
        }

    if not new_items:
        return {"status": "nothing-new", "session_id": session_id, "promoted": 0}

    # Build one block and append atomically via safe_write.
    block_lines = [
        "",
        f"## salvaged {_now_iso()} — session {session_id}",
        "",
    ]
    for d in new_items:
        block_lines.append(f"- [{d['kind']}] {d['text']}")
    block = "\n".join(block_lines)

    try:
        from safe_write import safe_append
        if not SALVAGE_FILE.exists():
            LONGTERM_DIR.mkdir(parents=True, exist_ok=True)
            safe_append(SALVAGE_FILE,
                        "# Salvaged long-term memory\n\n"
                        "> Durable decisions + findings promoted out of session "
                        "journals by precompact_extract.py BEFORE compaction.\n")
        res = safe_append(SALVAGE_FILE, block)
    except Exception as e:  # fail-open
        return {"status": "error", "session_id": session_id, "error": repr(e), "promoted": 0}

    return {
        "status": "promoted" if res.get("status") in ("written", "noop") else res.get("status", "error"),
        "session_id": session_id,
        "promoted": len(new_items),
        "salvage_file": str(SALVAGE_FILE),
    }


USAGE = """\
precompact_extract — salvage durable decisions/findings before compaction

Usage:
  precompact_extract.py --stdin                  hook mode (PreCompact JSON on stdin)
  precompact_extract.py --session <id>           run for an explicit session
  precompact_extract.py --session <id> --dry-run preview only (no write)
"""


def main(argv: list[str]) -> int:
    args = argv[1:]
    if "-h" in args or "--help" in args:
        print(USAGE)
        return 0
    stdin_mode = "--stdin" in args
    dry_run = "--dry-run" in args
    explicit = None
    if "--session" in args:
        i = args.index("--session")
        if i + 1 < len(args):
            explicit = args[i + 1]

    try:
        session_id = _resolve_session(explicit, stdin_mode)
        if not session_id:
            print(json.dumps({"status": "no-session", "promoted": 0}))
            return 0
        result = run(session_id, dry_run)
        print(json.dumps(result, indent=2 if dry_run else None))
    except Exception as e:  # absolute fail-open
        print(json.dumps({"status": "error", "error": repr(e), "promoted": 0}))
    return 0  # NEVER non-zero — must not block compaction


if __name__ == "__main__":
    sys.exit(main(sys.argv))
