"""cli/botcorp.mjs `secrets audit` contract, driven through node, plus a
direct unit test of cockpit/vault.mjs's `auditTail` (the cockpit's own read
path — no CLI hop).

Both read `<BOTCORP_HOME>/state/secret-access.jsonl` (the append-only record
`daemon/vault.ps1` writes on every decrypt) directly, so every case here
points `BOTCORP_HOME` at a throwaway `tmp_path` — it never touches the real
machine runtime.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
CLI = ASSEMBLY / "cli" / "botcorp.mjs"
VAULT_MJS = ASSEMBLY / "cockpit" / "vault.mjs"

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")

LINES = [
    {"ts": "2026-09-24T10:00:00.000Z", "bot": "demo", "key": "api_key",
     "reason": "cli", "pid": 100, "ppid": 1, "ok": True},
    {"ts": "2026-09-24T10:05:00.000Z", "bot": "other", "key": "telegram_token",
     "reason": "launch", "pid": 200, "ppid": 1, "ok": True},
    {"ts": "2026-09-24T10:10:00.000Z", "bot": "demo", "key": "telegram_token",
     "reason": "automation", "pid": 300, "ppid": 1, "ok": False},
]


def _write_log(home: Path) -> None:
    state = home / "state"
    state.mkdir(parents=True, exist_ok=True)
    (state / "secret-access.jsonl").write_text(
        "\n".join(json.dumps(r) for r in LINES) + "\n", encoding="utf-8"
    )


def _node(home: Path, *args: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "BOTCORP_HOME": str(home)}
    return subprocess.run(["node", str(CLI), *args], capture_output=True, text=True,
                          cwd=str(ASSEMBLY), env=env, timeout=60)


def test_audit_json_all_rows(tmp_path):
    _write_log(tmp_path)
    r = _node(tmp_path, "secrets", "audit", "--json")
    assert r.returncode == 0, r.stderr
    rows = json.loads(r.stdout)
    assert len(rows) == 3


def test_audit_bot_filter(tmp_path):
    _write_log(tmp_path)
    r = _node(tmp_path, "secrets", "audit", "demo", "--json")
    assert r.returncode == 0, r.stderr
    rows = json.loads(r.stdout)
    assert len(rows) == 2
    assert all(row["bot"] == "demo" for row in rows)


def test_audit_tail_returns_newest_only(tmp_path):
    _write_log(tmp_path)
    r = _node(tmp_path, "secrets", "audit", "--tail", "1", "--json")
    assert r.returncode == 0, r.stderr
    rows = json.loads(r.stdout)
    assert len(rows) == 1
    assert rows[0]["ts"] == LINES[-1]["ts"]


def test_audit_missing_file_is_not_an_error(tmp_path):
    r = _node(tmp_path, "secrets", "audit")
    assert r.returncode == 0, r.stderr
    assert "no secret access recorded yet" in r.stdout


def test_audit_tail_via_vault_mjs(tmp_path):
    """cockpit/vault.mjs#auditTail must agree with the CLI on newest-first
    ordering and bot filtering — it is what the cockpit's audit routes call
    directly, without going through `botcorp secrets audit`."""
    _write_log(tmp_path)
    script = (
        "const m = await import(process.argv[1]);"
        "const all = await m.auditTail();"
        "const demo = await m.auditTail('demo');"
        "console.log(JSON.stringify({"
        "all: all.length, demo: demo.length,"
        "firstTs: all[0] && all[0].ts, firstOk: all[0] && all[0].ok,"
        "}));"
    )
    env = {**os.environ, "BOTCORP_HOME": str(tmp_path)}
    r = subprocess.run(
        ["node", "--input-type=module", "-e", script, VAULT_MJS.resolve().as_uri()],
        capture_output=True, text=True, cwd=str(ASSEMBLY), env=env, timeout=60,
    )
    assert r.returncode == 0, r.stderr
    data = json.loads(r.stdout)
    assert data["all"] == 3
    assert data["demo"] == 2
    assert data["firstTs"] == LINES[-1]["ts"]
    assert data["firstOk"] is False
