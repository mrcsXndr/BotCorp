#!/usr/bin/env python3
"""Sanitize a memory chunk before it is injected into the session prompt.

Thin gate over tools/infra/sanitize.py (does NOT reimplement sanitization). Reads a
chunk from stdin, runs sanitize.scan + sanitize.full_sanitize, and decides:

  - HIGH / CRITICAL risk  -> emit a [BLOCKED: ...] marker instead of the chunk
                             (Hermes block-on-poison) — UNLESS --no-block is
                             passed (curated MEMORY.md: clean but don't block).
  - otherwise             -> emit the cleaned chunk (invisible-unicode stripped,
                             HIGH/CRITICAL patterns neutralised, NOT framed).

Usage (stdin -> stdout):
  sanitize_chunk.py <source-label> [--no-block]

STRICTLY FAIL-OPEN: if sanitize.py can't be imported/run, this prints the raw
chunk unchanged and a one-line note to stderr, exiting 0. The SessionStart hook
must never break.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import harness_root

# tools/infra/sanitize.py lives at ../infra relative to tools/v2/
sys.path.insert(0, str(harness_root() / "tools" / "infra"))


def main(argv: list[str]) -> int:
    source = argv[1] if len(argv) > 1 else "memory"
    no_block = "--no-block" in argv[2:]
    raw = sys.stdin.read()

    if not raw.strip():
        # nothing to do; preserve emptiness so the hook omits the block
        sys.stdout.write(raw)
        return 0

    try:
        import sanitize  # tools/infra/sanitize.py
        findings = sanitize.scan(raw)
        risk = sanitize.get_risk_level(findings)
        if risk in ("HIGH", "CRITICAL") and not no_block:
            sys.stdout.write(
                f"[BLOCKED: high-risk content in {source} — risk={risk}, "
                f"not injected. Review manually.]"
            )
            return 0
        cleaned, _f, _r = sanitize.full_sanitize(raw, source=source, frame=False)
        sys.stdout.write(cleaned)
        return 0
    except Exception as e:  # absolute fail-safe — inject raw, never break
        sys.stderr.write(f"[sanitize_chunk] fail-open ({source}): {e!r}\n")
        sys.stdout.write(raw)
        return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
