"""The one status-line convention, identical in the TG footer and the terminal statusline:

  mybot (main*) · Opus 5.5 high · ctx 361K/500K (72%) · 🟢 5h 12% · wk 62% ↻02:50 · acct ⇄backup
"""
from __future__ import annotations

import json
import shutil
import subprocess
import time
from datetime import datetime
from pathlib import Path

import pytest

import status_footer

STATUSLINE = Path(__file__).resolve().parents[1] / "tools" / "infra" / "statusline.js"
RESET = "2026-09-30T00:50:00Z"
HHMM = datetime.fromisoformat(RESET.replace("Z", "+00:00")).astimezone().strftime("%H:%M")
CTX = {"context_window_size": 1_000_000,
       "current_usage": {"input_tokens": 358_000, "cache_read_input_tokens": 2000,
                         "cache_creation_input_tokens": 1000}}
RATE = {"five_hour": {"used_percentage": 12, "resets_at": RESET},
        "seven_day": {"used_percentage": 62, "resets_at": RESET}}
USAGE = f"🟢 5h 12% · wk 62% ↻{HHMM}"


def launch_env(cfg: Path, account: str, reason: str) -> None:
    (cfg / "botcorp").mkdir(parents=True, exist_ok=True)
    (cfg / "botcorp" / "launch-env.json").write_text(json.dumps(
        {"launches": {"a": {"at": "2026-09-30T01:00:00Z", "account": account, "account_reason": reason}}}),
        encoding="utf-8")


@pytest.fixture
def footer(tmp_path, monkeypatch):
    for v in ("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "CLAUDE_CODE_EFFORT_LEVEL"):
        monkeypatch.delenv(v, raising=False)
    monkeypatch.setenv("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "500000")
    root = tmp_path / "mybot"
    root.mkdir()
    cfg = tmp_path / "cfg"
    cfg.mkdir()
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(cfg))
    monkeypatch.setattr(status_footer, "REPO_ROOT", root)
    monkeypatch.setattr(status_footer, "STATUS_JSON", cfg / "status.json")
    monkeypatch.setattr(status_footer, "LAUNCH_ENV_JSON", cfg / "botcorp" / "launch-env.json")
    monkeypatch.setattr(status_footer, "_git_status", lambda: "(main*)")

    def write(**extra) -> None:
        st = {"ts": time.time(), "model": {"id": "claude-opus-5-5", "display_name": "Claude Opus 5.5"},
              "context_window": CTX, "rate_limits": RATE, "effort": {"level": "High"}}
        st.update(extra)
        (cfg / "status.json").write_text(json.dumps(st), encoding="utf-8")
    write.cfg = cfg
    return write


def test_footer_line(footer):
    footer()
    line = status_footer.build_footer()
    assert line == f"mybot (main*) · Opus 5.5 high · ctx 361K/500K (72%) · {USAGE}"
    assert status_footer.build_footer(short=True) == "mybot (main*) · Opus 5.5 high · ctx 361K/500K (72%)"


def test_footer_account_own_hidden_failover_marked(footer):
    footer()
    launch_env(footer.cfg, "", "primary")
    assert "acct" not in status_footer.build_footer()
    launch_env(footer.cfg, "backup", "failover")
    assert status_footer.build_footer().endswith(f"{USAGE} · acct ⇄backup")
    launch_env(footer.cfg, "spare", "primary")
    assert status_footer.build_footer().endswith(f"{USAGE} · acct spare")


def test_footer_effort_order_and_id_derived_model(footer, monkeypatch):
    # No display_name: derived from the id; no effort in status.json: env, then settings.
    footer(model={"id": "claude-haiku-4-5-20251001"}, effort=None)
    (footer.cfg / "settings.json").write_text(json.dumps({"effortLevel": "Low"}), encoding="utf-8")
    assert "Haiku 4.5 low ·" in status_footer.build_footer()
    monkeypatch.setenv("CLAUDE_CODE_EFFORT_LEVEL", "MEDIUM")
    assert "Haiku 4.5 medium ·" in status_footer.build_footer()
    footer(model={"id": "claude-haiku-4-5-20251001"})  # status.json effort wins over env
    assert "Haiku 4.5 high ·" in status_footer.build_footer()


def test_footer_json_keeps_keys_and_adds_new(footer):
    footer()
    d = json.loads(status_footer.build_footer(as_json=True))
    for k in ("bot_name", "git", "session_id", "journal_entries", "context_used", "context_max",
              "context_pct_used", "model", "usage", "account", "account_reason", "tg", "harness_version"):
        assert k in d
    assert d["folder"] == "mybot" and d["effort"] == "high" and d["model"] == "Opus 5.5"


def run_statusline(cwd: Path, cfg: Path, payload: dict, *extra_args: str, **env) -> str:
    node = shutil.which("node")
    if not node:
        pytest.skip("node not on PATH")
    import os
    e = {k: v for k, v in os.environ.items()
         if k not in ("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "CLAUDE_CODE_EFFORT_LEVEL")}
    e["CLAUDE_CONFIG_DIR"] = str(cfg)
    e.update(env)
    r = subprocess.run([node, str(STATUSLINE), *extra_args], input=json.dumps(payload), env=e,
                       capture_output=True, text=True, encoding="utf-8", timeout=30)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


def test_statusline_line(tmp_path):
    cwd = tmp_path / "mybot"  # not a git repo: no branch segment
    cwd.mkdir()
    cfg = tmp_path / "cfg"
    payload = {"model": {"display_name": "Claude Opus 5.5"}, "effort": {"level": "High"},
               "workspace": {"current_dir": str(cwd)}, "context_window": CTX, "rate_limits": RATE,
               "session_id": "abc", "cost": {"total_cost_usd": 1.5}}
    env = {"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "500000"}
    line = run_statusline(cwd, cfg, payload, **env)
    assert line == f"mybot · Opus 5.5 high · ctx 361K/500K (72%) · {USAGE}"
    assert run_statusline(cwd, cfg, payload, "--short", **env) == "mybot · Opus 5.5 high · ctx 361K/500K (72%)"

    launch_env(cfg, "backup", "failback")
    assert run_statusline(cwd, cfg, payload, **env).endswith(f"{USAGE} · acct ⇄backup")
    launch_env(cfg, "", "primary")
    assert "acct" not in run_statusline(cwd, cfg, payload, **env)


def test_statusline_effort_falls_back_to_env_then_settings(tmp_path):
    cwd = tmp_path / "bot"
    cwd.mkdir()
    cfg = tmp_path / "cfg"
    cfg.mkdir()
    (cfg / "settings.json").write_text(json.dumps({"effortLevel": "xhigh"}), encoding="utf-8")
    payload = {"model": {"display_name": "Sonnet 5.5"}, "workspace": {"current_dir": str(cwd)},
               "context_window": CTX}
    assert run_statusline(cwd, cfg, payload).startswith("bot · Sonnet 5.5 xhigh · ctx ")
    assert run_statusline(cwd, cfg, payload, CLAUDE_CODE_EFFORT_LEVEL="Medium").startswith("bot · Sonnet 5.5 medium · ")
