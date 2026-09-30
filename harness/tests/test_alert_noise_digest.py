"""QA pack B 6: alert-triage NOISE is kept for the standup, not dropped.

Locked behaviour (tools/v2/alert_triage.py):
- a scan that moves its cursor past NOISE lines appends them verbatim to
  memory/metrics/alerts_noise.log; a deferred scan (cursor not moved) writes
  nothing, so a later pass never keeps the same line twice;
- `digest` prints the kept lines grouped by fingerprint and ends with
  `DIGEST_BYTES <n>`; `digest --clear <n>` drops exactly those bytes and keeps
  anything appended after the read;
- the standup skill names both commands.
"""
from __future__ import annotations

from datetime import datetime
from pathlib import Path

import pytest

import alert_triage as at

NOW = datetime(2026, 9, 30, 12, 0, 0)
INFO_A = "2026-09-30T08:00:00\t🗂️ status digest | 3 open"
INFO_B = "2026-09-30T09:00:00\t🗂️ status digest | 5 open"   # same fingerprint: digits are stripped
INFO_C = "2026-09-30T10:00:00\tHUMAN: renew the example cert this week"
ACTION = "2026-09-30T11:00:00\texample-backup FAIL exited 1"


@pytest.fixture
def paths(tmp_path, monkeypatch):
    p = {"ALERTS_LOG": tmp_path / "alerts.log", "STATE_FILE": tmp_path / "st.json", "TRIAGE_LOG": tmp_path / "tri.log",
         "RUNS_DIR": tmp_path / "runs", "LOCK_FILE": tmp_path / ".lock", "PROMPT_FILE": tmp_path / ".prompt",
         "NOISE_LOG": tmp_path / "alerts_noise.log"}
    for k, v in p.items():
        monkeypatch.setattr(at, k, v, raising=False)
    return p


def _log(p, *lines):
    with p["ALERTS_LOG"].open("a", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


def test_noise_is_kept_once_and_digested(paths, capsys):
    _log(paths, INFO_A, INFO_B, INFO_C)
    at.scan(now=NOW, spawn=lambda *_: 1)
    kept = Path(paths["NOISE_LOG"]).read_text(encoding="utf-8").splitlines()
    assert kept == [INFO_A, INFO_B, INFO_C]
    at.scan(now=NOW, spawn=lambda *_: 1)          # nothing new: nothing kept twice
    assert Path(paths["NOISE_LOG"]).read_text(encoding="utf-8").splitlines() == kept

    capsys.readouterr()
    at.digest()
    out = capsys.readouterr().out.splitlines()
    assert out[0].startswith("x2 ") and "status digest" in out[0]
    assert any(l.startswith("x1 ") and "HUMAN: renew" in l for l in out)
    n = int(out[-1].split()[1])
    assert out[-1].startswith("DIGEST_BYTES ") and n == paths["NOISE_LOG"].stat().st_size

    # a line kept after the read survives the clear
    with paths["NOISE_LOG"].open("a", encoding="utf-8") as fh:
        fh.write("2026-09-30T12:30:00\t🗂️ later digest\n")
    at.digest(clear=n)
    assert paths["NOISE_LOG"].read_text(encoding="utf-8").splitlines() == ["2026-09-30T12:30:00\t🗂️ later digest"]


def test_a_deferred_scan_keeps_nothing(paths):
    _log(paths, INFO_A, ACTION)
    paths["LOCK_FILE"].write_text(f"999 {NOW.isoformat(timespec='seconds')}\n", encoding="utf-8")   # a run in flight
    s = at.scan(now=NOW, spawn=lambda *_: 1)
    assert s.get("deferred") == "in-flight"
    assert not paths["NOISE_LOG"].exists()
    paths["LOCK_FILE"].unlink()
    at.scan(now=NOW, spawn=lambda *_: 1)
    assert paths["NOISE_LOG"].read_text(encoding="utf-8").splitlines() == [INFO_A]


def test_the_standup_skill_folds_the_digest_in():
    skill = (Path(at.__file__).resolve().parents[2] / "skills" / "standup" / "SKILL.md").read_text(encoding="utf-8")
    assert "alert_triage.py digest" in skill and "digest --clear" in skill
