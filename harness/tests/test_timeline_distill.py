"""v0.7.6: the timeline distill neither litters transcripts nor spawns a claude that cannot log in.

The distill runs from hooks, and Claude Code strips CLAUDE_CODE_OAUTH_TOKEN
from its hooks' env, so on a token-auth bot the inner `claude --print` exited
"Not logged in" and still left a transcript in the bot's projects/ dir, which
the cockpit chat then showed as the live session. Now: no credentials in the
env means a structural build with no spawn, and a spawn that does happen
passes --no-session-persistence.
"""
from __future__ import annotations

import shutil
import subprocess
import types

import pytest

import timeline


@pytest.fixture
def session(tmp_path, monkeypatch):
    sessions = tmp_path / "sessions"
    sid = "sess-1"
    (sessions / sid).mkdir(parents=True)
    (sessions / sid / "journal.md").write_text(
        "## Decisions\n- [10:00:00] picked the structural path\n", encoding="utf-8")
    monkeypatch.setattr(timeline, "SESSIONS_DIR", sessions)
    monkeypatch.setattr(timeline, "TIMELINES_DIR", tmp_path / "timelines")
    monkeypatch.delenv("CLAUDE_CODE_OAUTH_TOKEN", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    return sessions / sid


def _spy(monkeypatch, stdout="---\nsession_id: sess-1\n---\n\n# Critic's Timeline (distilled)\n\nnarrative " * 3):
    calls = []

    def run(argv, **kw):
        calls.append(argv)
        return types.SimpleNamespace(returncode=0, stdout=stdout, stderr="")

    monkeypatch.setattr(timeline.subprocess, "run", run)
    return calls


def test_no_credentials_builds_structural_without_spawning(session, monkeypatch, capsys):
    calls = _spy(monkeypatch)
    assert timeline.cmd_build("sess-1") == 0
    assert calls == []
    assert "(structural)" in (session / "timeline.md").read_text(encoding="utf-8")
    assert "distill skipped" in capsys.readouterr().err


def test_a_token_in_the_env_spawns_without_session_persistence(session, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "t")
    calls = _spy(monkeypatch)
    assert timeline.cmd_build("sess-1") == 0
    assert len(calls) == 1
    assert calls[0][0] == timeline.CLAUDE_EXE
    assert "--no-session-persistence" in calls[0] and "--print" in calls[0]
    assert "(distilled)" in (session / "timeline.md").read_text(encoding="utf-8")


def test_a_login_in_the_config_dir_counts_as_credentials(tmp_path, monkeypatch):
    monkeypatch.delenv("CLAUDE_CODE_OAUTH_TOKEN", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(timeline.sys, "platform", "win32")
    cfg = tmp_path / "cfg"
    cfg.mkdir()
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(cfg))
    assert timeline._claude_auth_available() is False
    (cfg / ".credentials.json").write_text("{}", encoding="utf-8")
    assert timeline._claude_auth_available() is True


def test_cross_session_distill_without_credentials_concatenates(session, monkeypatch):
    (session / "timeline.md").write_text("# t\n", encoding="utf-8")
    calls = _spy(monkeypatch)
    assert timeline.cmd_distill("2026-W39") == 0
    assert calls == []
    assert "concatenated fallback" in (timeline.TIMELINES_DIR / "2026-W39.md").read_text(encoding="utf-8")


def test_the_installed_claude_knows_the_flag():
    exe = shutil.which("claude")
    if not exe:
        pytest.skip("no claude on PATH")
    out = subprocess.run([exe, "--help"], capture_output=True, text=True, timeout=60,
                         encoding="utf-8", errors="replace")
    assert "--no-session-persistence" in (out.stdout + out.stderr)
