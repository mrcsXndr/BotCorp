#!/usr/bin/env python3
"""cost_report.py — aggregate memory/metrics/sessions.csv into a readable rollup.

The Stop-hook cost meter (tools/v2/cost_meter.py) appends one row per session:
  session_id,ts_start,ts_end,project,input_tok,output_tok,cache_read_tok,
  cache_creation_tok,subagent_count,model_mix,usd_est
This reads that CSV and rolls it up. No dependencies, no LLM — pure arithmetic.

CLI
  cost_report.py                 full rollup (all sessions)
  cost_report.py --days 7        only sessions ending within the last N days
  cost_report.py --tg            compact markdown for a Telegram /costs reply

USD→EUR mirrors statusline.js (0.92). Wired to TG via tg_commands.py `/costs`.
"""
from __future__ import annotations

import argparse
import csv
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import instance_root  # noqa: E402

REPO_ROOT = instance_root()
CSV_PATH = REPO_ROOT / "memory" / "metrics" / "sessions.csv"
USD_TO_EUR = 0.92


def _short_project(p: str) -> str:
    """Strip Claude Code's '<drive>--Users-<name>-Code-' project-slug prefix,
    leaving just the repo name."""
    if not p:
        return "(unknown)"
    marker = "-Code-"
    i = p.find(marker)
    return p[i + len(marker):] if i >= 0 else p


def _parse_ts(s: str) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def _parse_mix(mix: str) -> dict[str, int]:
    """'opus:15091,sonnet:30' -> {'opus':15091,'sonnet':30}."""
    out: dict[str, int] = {}
    for part in (mix or "").split(","):
        part = part.strip()
        if ":" not in part:
            continue
        tier, _, n = part.partition(":")
        try:
            out[tier.strip()] = out.get(tier.strip(), 0) + int(n)
        except ValueError:
            continue
    return out


def _f(row: dict, key: str) -> float:
    try:
        return float(row.get(key) or 0)
    except ValueError:
        return 0.0


def _eur(usd: float) -> str:
    e = usd * USD_TO_EUR
    return f"€{e/1000:.1f}k" if e >= 1000 else f"€{e:.2f}"


def load_rows(days: int | None) -> list[dict]:
    if not CSV_PATH.exists():
        return []
    with CSV_PATH.open(encoding="utf-8", newline="") as fh:
        rows = list(csv.DictReader(fh))
    if days is None:
        return rows
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    kept = []
    for r in rows:
        ts = _parse_ts(r.get("ts_end") or "")
        if ts is not None and ts >= cutoff:
            kept.append(r)
    return kept


def build_report(days: int | None, tg: bool) -> str:
    rows = load_rows(days)
    scope = f"last {days}d" if days else "all time"
    if not rows:
        return f"**Cost rollup** ({scope}): no session data in {CSV_PATH.name}."

    total_usd = sum(_f(r, "usd_est") for r in rows)
    total_sub = sum(int(_f(r, "subagent_count")) for r in rows)
    by_project: dict[str, float] = defaultdict(float)
    by_tier: dict[str, int] = defaultdict(int)
    for r in rows:
        by_project[_short_project(r.get("project", ""))] += _f(r, "usd_est")
        for tier, n in _parse_mix(r.get("model_mix", "")).items():
            by_tier[tier] += n

    proj_lines = [
        f"• {name}: {_eur(usd)}"
        for name, usd in sorted(by_project.items(), key=lambda kv: -kv[1])
    ]
    tier_str = ", ".join(
        f"{t}:{n}" for t, n in sorted(by_tier.items(), key=lambda kv: -kv[1])
    ) or "—"
    top = sorted(rows, key=lambda r: -_f(r, "usd_est"))[:3]
    top_lines = [
        f"• {r.get('session_id','?')[:8]} {_eur(_f(r,'usd_est'))} "
        f"({int(_f(r,'subagent_count'))} sub)"
        for r in top
    ]

    out = [
        f"**Cost rollup** ({scope})",
        f"Total: {_eur(total_usd)} over {len(rows)} session(s), {total_sub} subagent call(s)",
        "",
        "*By project:*",
        *proj_lines,
        "",
        f"*Model-call mix:* {tier_str}",
        "",
        "*Top sessions:*",
        *top_lines,
    ]
    return "\n".join(out)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Roll up per-session cost CSV.")
    ap.add_argument("--days", type=int, default=None,
                    help="only sessions ending within the last N days")
    ap.add_argument("--tg", action="store_true",
                    help="compact markdown (same output; reserved for formatting tweaks)")
    args = ap.parse_args(argv[1:])
    print(build_report(args.days, args.tg))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
