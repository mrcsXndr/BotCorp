#!/usr/bin/env python3
"""Per-session cost meter — v2, reads the OTel telemetry store.

Computes the real USD cost of ONE Claude Code session and appends a single
row to memory/metrics/sessions.csv, plus a daily per-agent-type rollup to
memory/metrics/subagents.csv.

Why the rewrite
----------------
The original version priced a session by re-parsing its transcript JSONL and
guessing a per-model price table. daemon/otel-sink.mjs now receives real
per-request cost/token/agent data straight from Claude Code's OpenTelemetry
export (~/.botcorp/state/<bot>/telemetry.db) — actual `cost_usd`, not a
guessed price, and `agent_id`/`query_source` so subagent activity is counted
from the source instead of grepping tool_use blocks out of a transcript.

Transcript parsing is kept ONLY as an opt-in fallback (module
`legacy_transcript_parse`) for a session that predates telemetry or ran with
it disabled; every row it produces is flagged in `model_mix` with
`|source=transcript` so it is never silently mistaken for a metered figure.

Output (memory/metrics/sessions.csv), header written if absent:
  session_id,ts_start,ts_end,project,input_tok,output_tok,
  cache_read_tok,cache_creation_tok,subagent_count,model_mix,usd_est

Output (memory/metrics/subagents.csv), append/upsert per (date,bot,session_id,
agent_type,model):
  date,bot,session_id,agent_type,model,n_requests,in_tok,out_tok,cache_tok,usd

Usage
-----
  cost_meter.py <session_id>       # meter one session by id
  cost_meter.py --stdin            # read Stop-hook JSON payload from stdin
  cost_meter.py --rollup           # refresh subagents.csv for the last 2 days

Design: fail-open. Any error prints a diagnostic to stderr and exits 0,
because this runs on the Stop hook of a LIVE session and must NEVER block
session end.
"""
from __future__ import annotations

import csv
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import instance_root, config_home, runtime_root, bot_name, module_enabled  # noqa: E402

# Pricing per MILLION tokens (USD). Only used by the legacy transcript-parse
# fallback — a metered (telemetry) row carries CC's own `cost_usd`.
PRICING = {
    "opus": {"input": 15.0, "cache_write": 3.75, "cache_read": 1.50, "output": 75.0},
    "sonnet": {"input": 3.0, "cache_write": 0.75, "cache_read": 0.30, "output": 15.0},
    "haiku": {"input": 0.8, "cache_write": 0.20, "cache_read": 0.08, "output": 4.0},
}

REPO_ROOT = instance_root()
METRICS_DIR = REPO_ROOT / "memory" / "metrics"
CSV_PATH = METRICS_DIR / "sessions.csv"
SUBAGENTS_CSV_PATH = METRICS_DIR / "subagents.csv"

# Default project slug for this repo, derived exactly as Claude Code derives
# its project directory name from the cwd (every non-alphanumeric -> '-').
# Only used to locate a transcript for the legacy fallback.
DEFAULT_PROJECT_SLUG = re.sub(r"[^A-Za-z0-9]", "-", str(REPO_ROOT))

CSV_HEADER = [
    "session_id",
    "ts_start",
    "ts_end",
    "project",
    "input_tok",
    "output_tok",
    "cache_read_tok",
    "cache_creation_tok",
    "subagent_count",
    "model_mix",
    "usd_est",
]

SUBAGENTS_CSV_HEADER = [
    "date", "bot", "session_id", "agent_type", "model",
    "n_requests", "in_tok", "out_tok", "cache_tok", "usd",
]

# Event names the OTel sink records for a priced API call (see
# daemon/otel-sink.mjs / docs/observability.md).
API_REQUEST_NAMES = ("api_request", "claude_code.api_request")


def _tier(model: str | None) -> str:
    # Legacy-fallback bucketing only (see module docstring). A metered row
    # uses the real model string from telemetry, not this tier name.
    m = (model or "").lower()
    if "sonnet" in m:
        return "sonnet"
    if "haiku" in m:
        return "haiku"
    if "fable" in m:
        return "fable"
    if "opus" in m:
        return "opus"
    return m.split("-")[1] if m.startswith("claude-") and "-" in m[7:] else (m or "unknown")


def _telemetry_db_path() -> Path:
    return runtime_root() / "state" / bot_name() / "telemetry.db"


def _ts_to_iso(ts) -> str:
    try:
        return datetime.fromtimestamp(float(ts), tz=timezone.utc).isoformat()
    except Exception:
        return ""


def _query_session(db_path: Path, session_id: str) -> dict | None:
    """Sum priced events for one session from telemetry.db. None if the DB
    is absent or the session has no rows (caller decides the fallback)."""
    if not session_id or not db_path.exists():
        return None
    placeholders = ",".join("?" for _ in API_REQUEST_NAMES)
    try:
        con = sqlite3.connect(str(db_path))
        con.row_factory = sqlite3.Row
        rows = con.execute(
            f"SELECT * FROM events WHERE session_id = ? AND name IN ({placeholders}) ORDER BY ts ASC",
            (session_id, *API_REQUEST_NAMES),
        ).fetchall()
        # Exact subagent count: CC 2.1.281 emits one subagent_completed per
        # Agent() call, while its api_request rows carry no agent_id (only
        # query_source=agent:<source>:<type> + agent.name), see docs/cc-compat.md.
        completed = con.execute(
            "SELECT COUNT(*) FROM events WHERE session_id = ? AND name IN ('subagent_completed', 'claude_code.subagent_completed')",
            (session_id,),
        ).fetchone()[0]
        con.close()
    except Exception as e:
        print(f"[cost_meter] telemetry query failed: {e!r}", file=sys.stderr)
        return None
    if not rows:
        return None

    totals = {
        "input": 0, "output": 0, "cache_read": 0, "cache_creation": 0, "usd": 0.0,
        "ts_start": None, "ts_end": None, "models": {}, "agent_ids": set(),
    }
    for r in rows:
        if r["ts"] is not None:
            iso = _ts_to_iso(r["ts"])
            if iso:
                if totals["ts_start"] is None or iso < totals["ts_start"]:
                    totals["ts_start"] = iso
                if totals["ts_end"] is None or iso > totals["ts_end"]:
                    totals["ts_end"] = iso
        totals["input"] += int(r["input_tok"] or 0)
        totals["output"] += int(r["output_tok"] or 0)
        totals["cache_read"] += int(r["cache_read_tok"] or 0)
        totals["cache_creation"] += int(r["cache_creation_tok"] or 0)
        totals["usd"] += float(r["cost_usd"] or 0.0)
        model = r["model"] or "unknown"
        totals["models"][model] = totals["models"].get(model, 0) + 1
        qs = r["query_source"] or ""
        if (qs == "subagent" or qs.startswith("agent:") or r["parent_agent_id"]) and r["agent_id"]:
            totals["agent_ids"].add(r["agent_id"])
    totals["subagent_count"] = int(completed or 0) or len(totals["agent_ids"])
    return totals


def _model_mix(models: dict) -> str:
    if not models:
        return ""
    return "|".join(f"{k}:{v}" for k, v in sorted(models.items()))


def _upsert_csv(path: Path, header: list[str], row: list, key_cols: int) -> None:
    """Rewrite `path` with `row` replacing any existing row whose first
    `key_cols` columns match (or appended if new). Atomic temp-file +
    os.replace so a crash mid-write can't truncate the existing CSV."""
    path.parent.mkdir(parents=True, exist_ok=True)
    rows: list[list[str]] = []
    if path.exists() and path.stat().st_size > 0:
        with path.open("r", newline="", encoding="utf-8") as fh:
            rows = list(csv.reader(fh))

    existing_header: list[str] | None = None
    data: list[list[str]] = []
    for i, r in enumerate(rows):
        if i == 0 and r[:1] == header[:1]:
            existing_header = r
        else:
            data.append(r)
    out_header = existing_header or header

    str_row = [str(c) for c in row]
    key = str_row[:key_cols]
    replaced = False
    for i, r in enumerate(data):
        if r[:key_cols] == key:
            data[i] = str_row
            replaced = True
            break
    if not replaced:
        data.append(str_row)

    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(out_header)
        for r in data:
            w.writerow(r)
    os.replace(tmp, path)


def _upsert_row(row: list) -> None:
    _upsert_csv(CSV_PATH, CSV_HEADER, row, key_cols=1)


def _upsert_subagents_row(row: list) -> None:
    _upsert_csv(SUBAGENTS_CSV_PATH, SUBAGENTS_CSV_HEADER, row, key_cols=5)


# ---- legacy transcript-parse fallback (module: legacy_transcript_parse) ----

def _projects_dir() -> Path:
    return config_home() / "projects"


def _find_jsonl(session_id: str, project_slug: str) -> Path | None:
    proj = _projects_dir() / project_slug
    direct = proj / f"{session_id}.jsonl"
    if direct.exists():
        return direct
    if not proj.exists():
        return None
    for f in proj.glob("*.jsonl"):
        try:
            with f.open(encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    if not line.strip():
                        continue
                    try:
                        if json.loads(line).get("sessionId") == session_id:
                            return f
                    except Exception:
                        continue
                    break
        except Exception:
            continue
    return None


def _price_jsonl(path: Path) -> dict:
    totals = {
        "input": 0, "output": 0, "cache_read": 0, "cache_creation": 0, "usd": 0.0,
        "subagent_count": 0, "ts_start": None, "ts_end": None, "models": {},
    }
    with path.open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
            except Exception:
                continue

            ts = entry.get("timestamp")
            if ts:
                if totals["ts_start"] is None or ts < totals["ts_start"]:
                    totals["ts_start"] = ts
                if totals["ts_end"] is None or ts > totals["ts_end"]:
                    totals["ts_end"] = ts

            if entry.get("type") != "assistant":
                continue
            msg = entry.get("message") or {}
            usage = msg.get("usage") or {}
            tier = _tier(msg.get("model"))
            price = PRICING[tier] if tier in PRICING else PRICING["sonnet"]

            inp = int(usage.get("input_tokens") or 0)
            out = int(usage.get("output_tokens") or 0)
            cr = int(usage.get("cache_read_input_tokens") or 0)
            cc = int(usage.get("cache_creation_input_tokens") or 0)

            totals["input"] += inp
            totals["output"] += out
            totals["cache_read"] += cr
            totals["cache_creation"] += cc
            totals["usd"] += (
                inp * price["input"] + cc * price["cache_write"]
                + cr * price["cache_read"] + out * price["output"]
            ) / 1e6
            totals["models"][tier] = totals["models"].get(tier, 0) + 1

            content = msg.get("content")
            if isinstance(content, list):
                for blk in content:
                    if isinstance(blk, dict) and blk.get("type") == "tool_use" and blk.get("name") in ("Agent", "Task"):
                        totals["subagent_count"] += 1
    return totals


def _legacy_meter(session_id: str) -> dict | None:
    if not session_id:
        return None
    path = _find_jsonl(session_id, DEFAULT_PROJECT_SLUG)
    if path is None or not path.exists():
        return None
    return _price_jsonl(path)


# ---- rollup: telemetry.db rollup_hourly -> memory/metrics/subagents.csv ----

def _write_session_rollup(session_id: str, db_path: Path) -> None:
    if not session_id or not db_path.exists():
        return
    try:
        con = sqlite3.connect(str(db_path))
        con.row_factory = sqlite3.Row
        rows = con.execute(
            "SELECT agent_type, model, SUM(n_requests) n_requests, SUM(in_tok) in_tok, "
            "SUM(out_tok) out_tok, SUM(cache_tok) cache_tok, SUM(usd) usd, MIN(hour) hour "
            "FROM rollup_hourly WHERE session_id = ? GROUP BY agent_type, model",
            (session_id,),
        ).fetchall()
        con.close()
    except Exception as e:
        print(f"[cost_meter] session rollup query failed: {e!r}", file=sys.stderr)
        return
    bot = bot_name()
    for r in rows:
        rdate = (r["hour"] or "")[:10]
        _upsert_subagents_row([
            rdate, bot, session_id, r["agent_type"] or "", r["model"] or "",
            r["n_requests"] or 0, r["in_tok"] or 0, r["out_tok"] or 0,
            r["cache_tok"] or 0, f"{(r['usd'] or 0):.4f}",
        ])


def rollup_last_days(days: int = 2) -> int:
    db_path = _telemetry_db_path()
    if not db_path.exists():
        print(f"[cost_meter] no telemetry db at {db_path}; nothing to roll up", file=sys.stderr)
        return 0
    cutoff_hour = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H")
    try:
        con = sqlite3.connect(str(db_path))
        con.row_factory = sqlite3.Row
        rows = con.execute(
            "SELECT session_id, agent_type, model, SUM(n_requests) n_requests, SUM(in_tok) in_tok, "
            "SUM(out_tok) out_tok, SUM(cache_tok) cache_tok, SUM(usd) usd, MIN(hour) hour "
            "FROM rollup_hourly WHERE hour >= ? GROUP BY session_id, agent_type, model",
            (cutoff_hour,),
        ).fetchall()
        con.close()
    except Exception as e:
        print(f"[cost_meter] rollup scan failed: {e!r}", file=sys.stderr)
        return 0
    bot = bot_name()
    n = 0
    for r in rows:
        rdate = (r["hour"] or "")[:10]
        _upsert_subagents_row([
            rdate, bot, r["session_id"] or "", r["agent_type"] or "", r["model"] or "",
            r["n_requests"] or 0, r["in_tok"] or 0, r["out_tok"] or 0,
            r["cache_tok"] or 0, f"{(r['usd'] or 0):.4f}",
        ])
        n += 1
    print(json.dumps({"status": "rolled_up", "rows": n, "csv": str(SUBAGENTS_CSV_PATH)}))
    return 0


# ---- main meter path --------------------------------------------------------

def meter(session_id: str) -> int:
    db_path = _telemetry_db_path()
    totals = _query_session(db_path, session_id)
    source_suffix = ""

    if totals is None:
        if module_enabled("legacy_transcript_parse"):
            legacy = _legacy_meter(session_id)
            if legacy is None:
                print(f"cost_meter: no telemetry for session {session_id}", file=sys.stderr)
                return 0
            totals = legacy
            source_suffix = "|source=transcript"
        else:
            print(f"cost_meter: no telemetry for session {session_id}", file=sys.stderr)
            return 0

    row = [
        session_id,
        totals.get("ts_start") or "",
        totals.get("ts_end") or "",
        bot_name(),
        totals["input"],
        totals["output"],
        totals["cache_read"],
        totals["cache_creation"],
        totals["subagent_count"],
        _model_mix(totals["models"]) + source_suffix,
        f"{totals['usd']:.4f}",
    ]
    _upsert_row(row)
    if not source_suffix:
        _write_session_rollup(session_id, db_path)

    print(json.dumps({
        "status": "metered",
        "session_id": session_id,
        "usd_est": round(totals["usd"], 4),
        "subagent_count": totals["subagent_count"],
        "input_tok": totals["input"],
        "output_tok": totals["output"],
        "cache_read_tok": totals["cache_read"],
        "cache_creation_tok": totals["cache_creation"],
        "model_mix": _model_mix(totals["models"]) + source_suffix,
        "csv": str(CSV_PATH),
    }))
    return 0


def _session_id_from_stdin() -> str:
    raw = ""
    try:
        if not sys.stdin.isatty():
            raw = sys.stdin.read()
    except Exception:
        raw = ""
    if not raw.strip():
        return ""
    try:
        d = json.loads(raw)
        return d.get("session_id") or d.get("sessionId") or ""
    except Exception as e:
        print(f"[cost_meter] stdin parse failed: {e!r}", file=sys.stderr)
        return ""


def main(argv: list[str]) -> int:
    try:
        if len(argv) >= 2 and argv[1] == "--rollup":
            return rollup_last_days()

        if len(argv) >= 2 and argv[1] == "--stdin":
            sid = _session_id_from_stdin()
            if not sid:
                print("[cost_meter] no session_id from stdin; skipping (fail-open)", file=sys.stderr)
                return 0
            return meter(sid)

        if len(argv) < 2:
            print("usage: cost_meter.py <session_id> | --stdin | --rollup", file=sys.stderr)
            return 0  # fail-open even on usage error

        return meter(argv[1])
    except Exception as e:  # absolute fail-open guard
        print(f"[cost_meter] unexpected error (fail-open): {e!r}", file=sys.stderr)
        return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
