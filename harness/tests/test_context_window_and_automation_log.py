"""v0.1.14: harness.context_window, and an automation's WHOLE output in its log.

Locked behaviour:
- bot.yaml harness.context_window: default '70%' of the model's window (1M for
  the Opus 5 / Fable 5 family, 200k for Haiku, unknown = 1M); an integer
  100000-1000000; 'auto'; anything else, or a result outside 100000-1000000,
  is a validation error;
- `botcorp config set <bot> harness.context_window 50%` works from pwsh and bash
  (the % survives both) and stores the string;
- sync merges autoCompactWindow into the config home's settings.json and keeps
  every other key; a launch puts CLAUDE_CODE_AUTO_COMPACT_WINDOW in the session
  env, over an inherited machine-wide one ('auto' drops it);
- doctor's `<bot>: context window` verdict: the value, the machine-wide
  override, a stale settings.json, a running session started with another one;
- an automation `a & b` logs a's output too (cmd /c "(<cmd>) > log").
"""
from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
BOTYAML = ASSEMBLY / "daemon" / "botyaml.mjs"
CLI = ASSEMBLY / "cli" / "botcorp.mjs"
LIB = (ASSEMBLY / "cli" / "_lib.mjs").as_uri()

needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")
needs_win = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None or shutil.which("node") is None,
                               reason="Windows with pwsh and node on PATH")


def _cfg(tmp_path: Path, text: str) -> dict:
    f = tmp_path / "bot.yaml"
    f.write_text(text, encoding="utf-8")
    r = subprocess.run(["node", str(BOTYAML), str(f)], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


@needs_node
def test_context_window_resolution_and_validation(tmp_path):
    def cw(extra: str, model: str = "claude-opus-5-5"):
        c = _cfg(tmp_path, f"name: b\nmodel: {model}\nharness:\n{extra}")
        return c["_context_window"], c["_errors"]
    assert cw("  modules: {}\n") == (700000, [])                                    # default 70%
    assert cw("  context_window: 50%\n") == (500000, [])
    assert cw("  context_window: '50%'\n", "claude-fable-5-1") == (500000, [])
    assert cw("  context_window: 400000\n") == (400000, [])
    assert cw("  context_window: auto\n") == (None, [])
    assert cw("  context_window: 70%\n", "claude-haiku-4-5-20251001") == (140000, [])  # 200k model
    assert cw("  context_window: 70%\n", "some-future-model")[0] == 700000             # unknown = 1M
    for bad in ("5%", "150%", "50", "lots", "99999", "2000000", "0.5"):
        assert cw(f"  context_window: {bad}\n")[1], bad
    assert cw("  context_window: 40%\n", "claude-haiku-4-5-20251001")[1]              # 80000 < 100000


@needs_node
def test_context_window_doctor_verdict():
    script = ("const m = await import(" + json.dumps(LIB) + ");"
              "const R = {tokens: 500000, source: '50% of 1000000 (claude-opus-5-5)', error: ''};"
              "console.log(JSON.stringify(["
              " m.contextWindowVerdict({resolved: R, settingsValue: 500000, machineEnv: '500000'}),"
              " m.contextWindowVerdict({resolved: {...R, tokens: 700000}, settingsValue: 700000, machineEnv: '500000'}),"
              " m.contextWindowVerdict({resolved: R, settingsValue: 700000}),"
              " m.contextWindowVerdict({resolved: R, settingsValue: 500000, running: true, launch: {auto_compact_window: 700000}}),"
              " m.contextWindowVerdict({resolved: R, settingsValue: 500000, running: true, launch: {launcher_pid: 1}}),"
              " m.contextWindowVerdict({resolved: {tokens: null, source: 'auto', error: ''}, settingsValue: null, machineEnv: '500000'}),"
              " m.contextWindowVerdict({resolved: {tokens: null, error: 'nope'}})]));")
    r = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, timeout=60, cwd=str(ASSEMBLY))
    assert r.returncode == 0, r.stderr
    same, over, stale, old_session, no_record, auto, bad = json.loads(r.stdout.strip().splitlines()[-1])
    assert same["level"] == "PASS" and same["detail"].startswith("500000 tokens") and "overrides" not in same["detail"]
    assert over["level"] == "PASS" and "overrides the machine-wide 500000" in over["detail"]
    assert stale["level"] == "WARN" and "botcorp sync" in stale["detail"]
    assert old_session["level"] == "WARN" and "started with 700000" in old_session["detail"]
    assert no_record["level"] == "PASS"                                            # a pre-v0.1.14 launch record: nothing to compare
    assert auto["level"] == "INFO" and "drop the machine-wide" in auto["detail"]
    assert bad["level"] == "FAIL"


@pytest.fixture
def repo_bot(tmp_path):
    name = f"zz-c{secrets.token_hex(3)}"
    home = ASSEMBLY / "bots" / name
    home.mkdir(parents=True)
    rt = tmp_path / "rt"
    (rt / "state").mkdir(parents=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "TELEGRAM_", "BOT_"))}
    env["BOTCORP_HOME"] = str(rt)
    try:
        yield name, home, rt, env
    finally:
        shutil.rmtree(home, ignore_errors=True)


@needs_win
def test_config_set_percent_from_pwsh_and_bash_then_sync_and_launch(repo_bot):
    name, home, rt, env = repo_bot
    (home / "bot.yaml").write_text(f"name: {name}\nharness:\n  service: manual\n  modules:\n    telegram: false\n", encoding="utf-8")
    cfgdir = home / f".claude-{name}"
    cfgdir.mkdir()
    (cfgdir / "settings.json").write_text(json.dumps({"operatorKey": 1}), encoding="utf-8")
    node = shutil.which("node")
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-Command", f"& '{node}' '{CLI}' config set {name} harness.context_window 50%"],
                       capture_output=True, text=True, timeout=180, cwd=str(ASSEMBLY), env=env)
    assert r.returncode == 0, r.stderr + r.stdout
    parsed =json.loads(subprocess.run(["node", str(BOTYAML), str(home / "bot.yaml")], capture_output=True, text=True, timeout=60).stdout)
    assert parsed["harness"]["context_window"] == "50%" and parsed["_context_window"] == 500000
    settings = json.loads((cfgdir / "settings.json").read_text(encoding="utf-8"))
    assert settings["autoCompactWindow"] == 500000 and settings["operatorKey"] == 1    # merged, not clobbered
    bash = shutil.which("bash")
    if bash:
        r = subprocess.run([bash, "-c", f"'{Path(node).as_posix()}' '{CLI.as_posix()}' config set {name} harness.context_window 60%"],
                           capture_output=True, text=True, timeout=180, cwd=str(ASSEMBLY), env=env)
        assert r.returncode == 0, r.stderr + r.stdout
        assert json.loads((cfgdir / "settings.json").read_text(encoding="utf-8"))["autoCompactWindow"] == 600000
    # the launch env beats an inherited machine-wide value
    env2 = dict(env, CLAUDE_CODE_AUTO_COMPACT_WINDOW="500000")
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ASSEMBLY / "daemon" / "launch.ps1"),
                        "-Bot", name, "-Bg", "-DryRun", "-StartedBy", "cli"], capture_output=True, text=True, timeout=300, cwd=str(ASSEMBLY), env=env2)
    assert r.returncode == 0, r.stderr + r.stdout
    assert "env : CLAUDE_CODE_AUTO_COMPACT_WINDOW=600000" in r.stdout
    assert "overrides the inherited 500000" in r.stdout


@needs_win
def test_a_chained_automation_logs_every_command(repo_bot):
    name, home, rt, env = repo_bot
    (home / "bot.yaml").write_text(
        f"name: {name}\nharness:\n  service: manual\n  modules:\n    telegram: false\n"
        "automations:\n  - name: chain\n    trigger: {interval_min: 600}\n    command: \"echo first-part & echo second-part\"\n"
        "    timeout_min: 0.2\n    idle_gated: false\n", encoding="utf-8")
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ASSEMBLY / "daemon" / "automations.ps1"),
                        "-Bot", name, "-RunNow", "chain"], capture_output=True, text=True, timeout=300, cwd=str(ASSEMBLY), env=env)
    assert r.returncode == 0, r.stderr + r.stdout
    logs = list((rt / "logs" / name / "chain").glob("*.log"))
    assert logs, (rt / "daemon.log").read_text(encoding="utf-8") if (rt / "daemon.log").exists() else r.stdout
    text = logs[0].read_text(encoding="utf-8", errors="replace")
    assert "first-part" in text and "second-part" in text, text
