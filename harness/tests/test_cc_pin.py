"""R3: bots run a BotCorp-owned copy of Claude Code, named by one pin.

Claude Code's own supervisor watches the binary it was started from and
self-restarts onto whatever lands there, so a bot started from the shared
~/.local/bin/claude.exe rides every global update untested. BotCorp keeps its
own copy at <BOTCORP_HOME>/cc/<version>/claude.exe and records which one bots
run in <BOTCORP_HOME>/state/cc.json `pinned.exe`.

Locked behaviour (one order in every resolver):
- env BOTCORP_CLAUDE_EXE (when that file exists), then the pin (when its exe
  exists), then ~/.local/bin/claude.exe, then PATH;
- no cc.json: the order is what it always was (native, then PATH);
- a pin whose exe is missing falls back to the native install, never fails;
- the launch env (Get-ClaudeEnv) and the tool env (Get-BotEnv) carry
  BOTCORP_CLAUDE_EXE, and a bot session never runs Claude Code's background
  updater (DISABLE_AUTOUPDATER=1; never DISABLE_UPDATES, which would block
  `claude update` for every other user of the box);
- the python resolvers take BOTCORP_CLAUDE_EXE first;
- hooks append `<iso> <HookName>` to memory/metrics/hook-trace.log only when
  BOT_HOOK_TRACE=1 (the gate's check 3).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
COMMON = ASSEMBLY / "daemon" / "_common.ps1"
LIB = (ASSEMBLY / "cli" / "_lib.mjs").as_uri()

needs_pwsh = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None, reason="Windows with pwsh on PATH")
needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")


def _box(tmp_path: Path, *, native: bool = True, pin: str | None = "2.1.900", pin_exists: bool = True, on_path: bool = False) -> dict:
    """A temp runtime + profile. Returns the env and the interesting paths."""
    rt = tmp_path / "rt"
    (rt / "state").mkdir(parents=True)
    profile = tmp_path / "profile"
    (profile / ".local" / "bin").mkdir(parents=True)
    native_exe = profile / ".local" / "bin" / "claude.exe"
    if native:
        native_exe.write_bytes(b"native")
    pinned_exe = rt / "cc" / (pin or "none") / "claude.exe"
    if pin:
        if pin_exists:
            pinned_exe.parent.mkdir(parents=True)
            pinned_exe.write_bytes(b"pinned")
        (rt / "state" / "cc.json").write_text(json.dumps({"schema": 1, "pinned": {"version": pin, "exe": str(pinned_exe), "sha256": "x", "by": "bootstrap"}, "previous": [], "rejected": []}), encoding="utf-8")
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    path_exe = fake_bin / "claude.cmd"
    if on_path:
        path_exe.write_text("@echo off\r\nexit /b 0\r\n", encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if k not in ("BOTCORP_CLAUDE_EXE",)}
    env.update({"BOTCORP_HOME": str(rt), "USERPROFILE": str(profile), "HOME": str(profile), "BOT_TG_MUTE": "1",
                "PATH": f"{fake_bin}{os.pathsep}{env.get('PATH', '')}"})
    return {"env": env, "rt": rt, "native": native_exe, "pinned": pinned_exe, "path_exe": path_exe}


def _ps(body: str, env: dict) -> str:
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", f". '{COMMON}'\n{body}"],
                       capture_output=True, text=True, timeout=180, cwd=str(ASSEMBLY), env=env)
    assert r.returncode == 0, r.stderr + r.stdout
    lines = [ln for ln in r.stdout.splitlines() if ln.strip()]
    assert lines, r.stderr
    return lines[-1]


def _node(expr: str, env: dict) -> object:
    script = f"const m = await import({json.dumps(LIB)}); console.log(JSON.stringify({expr}));"
    r = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, timeout=120, cwd=str(ASSEMBLY), env=env)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout.strip().splitlines()[-1])


def _same(a: object, b: Path) -> bool:
    return os.path.normcase(os.path.abspath(str(a))) == os.path.normcase(os.path.abspath(str(b)))


# --- Resolve-ClaudeExe (daemon) --------------------------------------------------------
@needs_pwsh
def test_resolve_uses_pinned_exe(tmp_path):
    b = _box(tmp_path)
    assert _same(_ps("Resolve-ClaudeExe", b["env"]), b["pinned"])


@needs_pwsh
def test_env_override_wins(tmp_path):
    b = _box(tmp_path)
    cand = tmp_path / "cand" / "claude.exe"
    cand.parent.mkdir()
    cand.write_bytes(b"candidate")
    assert _same(_ps("Resolve-ClaudeExe", {**b["env"], "BOTCORP_CLAUDE_EXE": str(cand)}), cand)
    # an override naming a file that is not there is ignored: the pin still wins
    assert _same(_ps("Resolve-ClaudeExe", {**b["env"], "BOTCORP_CLAUDE_EXE": str(tmp_path / "gone.exe")}), b["pinned"])


@needs_pwsh
def test_no_pin_keeps_native_then_path(tmp_path):
    b = _box(tmp_path / "a", pin=None)
    assert _same(_ps("Resolve-ClaudeExe", b["env"]), b["native"])
    b = _box(tmp_path / "b", pin=None, native=False, on_path=True)
    assert _same(_ps("Resolve-ClaudeExe", b["env"]), b["path_exe"])


@needs_pwsh
def test_missing_pinned_exe_falls_back(tmp_path):
    b = _box(tmp_path, pin_exists=False)
    assert _same(_ps("Resolve-ClaudeExe", b["env"]), b["native"])


@needs_pwsh
def test_claude_env_carries_pin_and_autoupdater(tmp_path):
    b = _box(tmp_path)
    got = json.loads(_ps("(Get-ClaudeEnv -ConfigDir 'C:\\cfg' -Secrets @{}) | ConvertTo-Json -Compress", b["env"]))
    assert _same(got["BOTCORP_CLAUDE_EXE"], b["pinned"])
    assert got["DISABLE_AUTOUPDATER"] == "1"
    assert "DISABLE_UPDATES" not in got
    assert got["CLAUDE_CONFIG_DIR"] == "C:\\cfg"
    tool = json.loads(_ps("(Get-BotEnv -Bot 'alpha') | ConvertTo-Json -Compress", b["env"]))
    assert _same(tool["BOTCORP_CLAUDE_EXE"], b["pinned"])


# --- resolveClaude (cli/_lib.mjs) --------------------------------------------------------
@needs_node
def test_lib_resolve_uses_pinned_exe(tmp_path):
    b = _box(tmp_path)
    assert _same(_node("m.resolveClaude()", b["env"]), b["pinned"])


@needs_node
def test_lib_env_override_wins(tmp_path):
    b = _box(tmp_path)
    cand = tmp_path / "cand.exe"
    cand.write_bytes(b"candidate")
    assert _same(_node("m.resolveClaude()", {**b["env"], "BOTCORP_CLAUDE_EXE": str(cand)}), cand)
    assert _same(_node("m.resolveClaude()", {**b["env"], "BOTCORP_CLAUDE_EXE": str(tmp_path / "gone.exe")}), b["pinned"])


@needs_node
def test_lib_no_pin_keeps_native_then_path(tmp_path):
    b = _box(tmp_path / "a", pin=None)
    assert _same(_node("m.resolveClaude()", b["env"]), b["native"])
    b = _box(tmp_path / "b", pin=None, native=False, on_path=True)
    assert _same(_node("m.resolveClaude()", b["env"]), b["path_exe"])


@needs_node
def test_lib_missing_pinned_exe_falls_back(tmp_path):
    b = _box(tmp_path, pin_exists=False)
    assert _same(_node("m.resolveClaude()", b["env"]), b["native"])


# --- hook trace (the gate's check 3) ---------------------------------------------------------
@pytest.mark.skipif(shutil.which("bash") is None, reason="bash not on PATH")
def test_hook_trace_opt_in(tmp_path):
    home = tmp_path / "bot"
    home.mkdir()
    env = {**os.environ, "BOT_HOME": str(home), "BOT_MODULES": "", "BOT_TG_MUTE": "1", "CLAUDE_PLUGIN_ROOT": str(ASSEMBLY / "harness")}
    env.pop("BOT_HOOK_TRACE", None)
    hook = str(ASSEMBLY / "harness" / "hooks" / "play-sound.sh")   # module-gated off here: the trace still records that it fired
    trace = home / "memory" / "metrics" / "hook-trace.log"
    r = subprocess.run(["bash", hook], input="{}", capture_output=True, text=True, env=env, timeout=30)
    assert r.returncode == 0, r.stderr
    assert not trace.exists()
    r = subprocess.run(["bash", hook], input="{}", capture_output=True, text=True, env={**env, "BOT_HOOK_TRACE": "1"}, timeout=30)
    assert r.returncode == 0, r.stderr
    lines = trace.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1 and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ play-sound", lines[0]), lines


# --- the python resolvers ------------------------------------------------------------------
def test_python_resolvers_take_the_env_exe_first(tmp_path, monkeypatch):
    import alert_triage
    import update_restart
    cand = tmp_path / "cand.exe"
    cand.write_bytes(b"candidate")
    monkeypatch.setenv("BOTCORP_CLAUDE_EXE", str(cand))
    monkeypatch.setenv("CLAUDE_CODE_EXECPATH", str(tmp_path))   # exists, but the pin wins over it
    assert _same(alert_triage._claude_exe(), cand)
    assert _same(update_restart._claude_exe(), cand)
