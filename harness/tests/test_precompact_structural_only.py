"""QA pack C 6: the PreCompact timeline hook builds structurally and spends nothing.

A hook gets no Claude credentials, so the detached `timeline.py build` LLM
distill it used to spawn only ever fell back after costing a process (and on
a /login bot it spent). Locked behaviour:
- precompact_timeline.run builds the structural timeline and spawns no
  `timeline.py build`; its weekly promotion spawns `distill <week> --structural`;
- `timeline.py distill <week> --structural` writes the concatenation and never
  starts claude, even with credentials in the env;
- without the flag, `distill` still tries the LLM when it can (manual use).
"""
from __future__ import annotations

import types

import precompact_timeline as pt
import timeline


def test_the_hook_spawns_no_llm_run(tmp_path, monkeypatch):
    sessions = tmp_path / "sessions"
    (sessions / "s1").mkdir(parents=True)
    (sessions / "s1" / "journal.md").write_text("## Decisions\n- [10:00:00] x\n", encoding="utf-8")
    monkeypatch.setattr(pt, "SESSIONS_DIR", sessions)
    monkeypatch.setattr(pt, "TIMELINES_DIR", tmp_path / "timelines")
    monkeypatch.setattr(pt, "WEEKLY_STAMP", tmp_path / "timelines" / ".last_weekly_distill")
    spawned, ran = [], []
    monkeypatch.setattr(pt, "_spawn_detached", lambda args: spawned.append(args) or True)
    monkeypatch.setattr(pt.subprocess, "run", lambda args, **kw: ran.append(args) or types.SimpleNamespace(returncode=0))
    out = pt.run("s1", dry_run=False)
    assert out["status"] == "ok" and out["structural"] == "ok"
    assert ran and ran[0][2:] == ["build", "s1", "--structural"]
    assert spawned, "the weekly promotion still runs"
    for args in spawned:
        assert args[2] == "distill" and args[-1] == "--structural", args
    assert "distill_spawned" not in out


def _week(tmp_path, monkeypatch):
    sessions = tmp_path / "sessions"
    (sessions / "s1").mkdir(parents=True)
    (sessions / "s1" / "timeline.md").write_text("# t\n", encoding="utf-8")
    monkeypatch.setattr(timeline, "SESSIONS_DIR", sessions)
    monkeypatch.setattr(timeline, "TIMELINES_DIR", tmp_path / "timelines")
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "t")   # credentials present: only the flag stops the LLM
    calls = []
    monkeypatch.setattr(timeline.subprocess, "run", lambda argv, **kw: calls.append(argv) or types.SimpleNamespace(
        returncode=0, stdout="# distilled narrative " * 5, stderr=""))
    return calls


def test_distill_structural_never_starts_claude(tmp_path, monkeypatch, capsys):
    calls = _week(tmp_path, monkeypatch)
    assert timeline.main(["timeline.py", "distill", "2026-W40", "--structural"]) == 0
    assert calls == []
    assert '"concatenated-fallback"' in capsys.readouterr().out
    assert "concatenated fallback" in (tmp_path / "timelines" / "2026-W40.md").read_text(encoding="utf-8")


def test_distill_without_the_flag_still_tries_the_llm(tmp_path, monkeypatch, capsys):
    calls = _week(tmp_path, monkeypatch)
    assert timeline.main(["timeline.py", "distill", "2026-W40"]) == 0
    assert len(calls) == 1 and calls[0][0] == timeline.CLAUDE_EXE
    assert '"distilled"' in capsys.readouterr().out
