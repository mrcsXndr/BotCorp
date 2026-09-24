"""tools/v2/cost_meter.py: metering from the OTel telemetry store.

Replaces the old transcript-JSONL pricing test — a session's cost now comes
from daemon/otel-sink.mjs's telemetry.db (real per-request cost_usd from
Claude Code's own OTel export), not a guessed price table.

Module-level path constants (CSV_PATH, SUBAGENTS_CSV_PATH) are computed from
instance_root() at IMPORT time, so this test monkeypatches them directly
rather than relying on BOT_HOME alone — conftest's isolated_bot_env is
defense in depth, not a substitute (see its docstring).
"""
from __future__ import annotations

import csv
import io
import json
import sqlite3
from pathlib import Path

import pytest

import cost_meter as cm

SCHEMA = """
CREATE TABLE events (
  id INTEGER PRIMARY KEY, ts REAL, name TEXT, session_id TEXT, agent_id TEXT,
  parent_agent_id TEXT, query_source TEXT, agent_name TEXT, model TEXT,
  input_tok INTEGER, output_tok INTEGER, cache_read_tok INTEGER,
  cache_creation_tok INTEGER, cost_usd REAL, duration_ms REAL, attrs_json TEXT
);
CREATE TABLE rollup_hourly (
  hour TEXT, session_id TEXT, agent_type TEXT, model TEXT,
  n_requests INTEGER, in_tok INTEGER, out_tok INTEGER, cache_tok INTEGER, usd REAL,
  PRIMARY KEY (hour, session_id, agent_type, model)
);
"""

INSERT = (
    "INSERT INTO events (ts, name, session_id, agent_id, parent_agent_id, query_source, "
    "agent_name, model, input_tok, output_tok, cache_read_tok, cache_creation_tok, cost_usd, "
    "duration_ms, attrs_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
)


def _make_db(path: Path, rows: list[tuple]) -> None:
    con = sqlite3.connect(str(path))
    con.executescript(SCHEMA)
    if rows:
        con.executemany(INSERT, rows)
    con.commit()
    con.close()


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(cm, "CSV_PATH", tmp_path / "sessions.csv")
    monkeypatch.setattr(cm, "SUBAGENTS_CSV_PATH", tmp_path / "subagents.csv")
    monkeypatch.setenv("BOTCORP_HOME", str(tmp_path / "botcorp_home"))
    monkeypatch.setenv("BOT_NAME", "tmpotel")
    db_path = tmp_path / "botcorp_home" / "state" / "tmpotel" / "telemetry.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    return db_path


def test_meters_session_from_telemetry_and_upserts(isolated):
    db_path = isolated
    rows = [
        # 3 main-agent requests
        (1700000000.0, "api_request", "s1", None, None, "main", None, "claude-sonnet-5",
         100, 50, 0, 0, 0.01, 500.0, "{}"),
        (1700000010.0, "api_request", "s1", None, None, "main", None, "claude-sonnet-5",
         100, 50, 0, 0, 0.01, 500.0, "{}"),
        (1700000020.0, "api_request", "s1", None, None, "main", None, "claude-sonnet-5",
         100, 50, 0, 0, 0.01, 500.0, "{}"),
        # 2 subagent requests, same agent_id -> subagent_count must be 1 (distinct ids)
        (1700000030.0, "api_request", "s1", "a1", "main", "subagent", "coder", "claude-sonnet-5",
         200, 100, 0, 0, 0.02, 800.0, "{}"),
        (1700000040.0, "api_request", "s1", "a1", "main", "subagent", "coder", "claude-sonnet-5",
         200, 100, 0, 0, 0.02, 800.0, "{}"),
    ]
    _make_db(db_path, rows)
    expected_usd = sum(r[12] for r in rows)

    assert cm.main(["cost_meter.py", "s1"]) == 0

    with cm.CSV_PATH.open(newline="", encoding="utf-8") as fh:
        data_rows = list(csv.DictReader(fh))
    assert len(data_rows) == 1
    row = data_rows[0]
    assert row["session_id"] == "s1"
    assert abs(float(row["usd_est"]) - expected_usd) <= expected_usd * 0.01
    assert row["subagent_count"] == "1"
    assert "|source=transcript" not in row["model_mix"]

    # A second meter run must rewrite the existing row, not duplicate it.
    assert cm.main(["cost_meter.py", "s1"]) == 0
    with cm.CSV_PATH.open(newline="", encoding="utf-8") as fh:
        data_rows2 = list(csv.DictReader(fh))
    assert len(data_rows2) == 1


def test_stdin_mode_reads_session_id_and_meters(isolated, monkeypatch):
    db_path = isolated
    _make_db(db_path, [
        (1700000000.0, "claude_code.api_request", "s2", None, None, "main", None, "claude-opus-5",
         10, 5, 0, 0, 0.005, 100.0, "{}"),
    ])
    monkeypatch.setattr(cm.sys, "stdin", io.StringIO(json.dumps({"session_id": "s2"})))

    assert cm.main(["cost_meter.py", "--stdin"]) == 0

    with cm.CSV_PATH.open(newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    assert any(r["session_id"] == "s2" for r in rows)


def test_no_rows_for_session_and_legacy_off_writes_nothing(isolated, monkeypatch):
    # telemetry.db exists but has no rows for this session; legacy transcript
    # fallback is explicitly OFF (BOT_MODULES excludes legacy_transcript_parse).
    _make_db(isolated, [])
    monkeypatch.setenv("BOT_MODULES", "cost_meter,telemetry")

    assert cm.main(["cost_meter.py", "s-nonexistent"]) == 0
    assert not cm.CSV_PATH.exists()


def test_no_db_at_all_and_legacy_off_writes_nothing(isolated, monkeypatch):
    # No telemetry.db file present at all (isolated only created the parent dir).
    monkeypatch.setenv("BOT_MODULES", "cost_meter,telemetry")

    assert cm.main(["cost_meter.py", "s-none"]) == 0
    assert not cm.CSV_PATH.exists()


def test_rollup_mode_writes_subagents_csv_from_rollup_hourly(isolated):
    db_path = isolated
    con = sqlite3.connect(str(db_path))
    con.executescript(SCHEMA)
    from datetime import datetime, timezone
    hour = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H")
    con.execute(
        "INSERT INTO rollup_hourly (hour, session_id, agent_type, model, n_requests, in_tok, "
        "out_tok, cache_tok, usd) VALUES (?,?,?,?,?,?,?,?,?)",
        (hour, "s3", "subagent", "claude-sonnet-5", 2, 300, 150, 0, 0.04),
    )
    con.commit()
    con.close()

    assert cm.main(["cost_meter.py", "--rollup"]) == 0
    assert cm.SUBAGENTS_CSV_PATH.exists()
    with cm.SUBAGENTS_CSV_PATH.open(newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    assert any(r["session_id"] == "s3" and r["agent_type"] == "subagent" for r in rows)
