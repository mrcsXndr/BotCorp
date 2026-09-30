"""QA pack A item 1: ab.sh's Chrome logon-lockout guard.

On start-up Chrome on Windows calls LogonUser with an EMPTY password to test
for a blank OS password, unless the profile's Local State caches
`os_password_last_changed`. agent-browser's default fresh temp profile per
launch made every launch one failed logon, and a burst of launches locked the
operator's Windows account.

Locked behaviour:
- every ab.sh call runs agent-browser with a persistent profile inside the
  bot's own agent-browser dir (~/.agent-browser/botcorp/<bot>/profile), so the
  janitor still recognises its Chrome as the bot's;
- that profile's Local State is (re)seeded with os_password_last_changed =
  INT64_MAX before every call, because Chrome rewrites it while running;
- `--auth-server-allowlist=none.invalid` is appended to AGENT_BROWSER_ARGS
  (no ambient Windows auth to any server), keeping any caller args;
- a failed seed is fail-closed: agent-browser never starts.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
AB = ASSEMBLY / "harness" / "tools" / "browser" / "ab.sh"
NEVER = "9223372036854775807"

pytestmark = pytest.mark.skipif(shutil.which("bash") is None, reason="bash on PATH")


def _setup(tmp_path: Path) -> tuple[dict, Path, Path]:
    npm_root = tmp_path / "npmroot"
    (npm_root / "agent-browser" / "bin").mkdir(parents=True)
    ran = tmp_path / "ran.txt"
    # a stand-in agent-browser: records that it ran and the env it got
    (npm_root / "agent-browser" / "bin" / "agent-browser.js").write_text(
        "require('fs').writeFileSync(" + json.dumps(str(ran)) + ", 'x');\n"
        "console.log([process.env.AGENT_BROWSER_PROFILE || '', process.env.AGENT_BROWSER_ARGS || ''].join('|'))\n",
        encoding="utf-8")
    shim = tmp_path / "bin"
    shim.mkdir()
    (shim / "npm").write_text(f'#!/usr/bin/env bash\necho "{npm_root.as_posix()}"\n', encoding="utf-8")
    (shim / "npm").chmod(0o755)  # Linux runs it from PATH only when executable
    home = tmp_path / "home"
    home.mkdir()
    env = {k: v for k, v in os.environ.items() if not k.startswith(("BOT_", "AGENT_BROWSER"))}
    env.update({"HOME": str(home), "USERPROFILE": str(home), "BOT_PYTHON": sys.executable,
                "PATH": f"{shim.as_posix()}{os.pathsep}{env['PATH']}"})
    return env, home, ran


def _run(env: dict) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", str(AB), "get", "url"], capture_output=True, text=True, timeout=120, env=env)


def test_every_call_uses_a_seeded_persistent_profile(tmp_path):
    env, home, ran = _setup(tmp_path)
    env["BOT_NAME"] = "alpha"
    r = _run(env)
    assert r.returncode == 0, r.stderr
    profile, args = r.stdout.strip().splitlines()[-1].split("|")
    want = home / ".agent-browser" / "botcorp" / "alpha" / "profile"
    norm = lambda s: s.replace("\\", "/").lower().split(":", 1)[-1]  # noqa: E731
    assert norm(profile) == norm(want.as_posix()), profile
    assert "--auth-server-allowlist=none.invalid" in args.split(","), args

    local_state = json.loads((want / "Local State").read_text(encoding="utf-8"))
    assert local_state["password_manager"]["os_password_last_changed"] == NEVER
    assert local_state["password_manager"]["os_password_blank"] is False
    prefs = json.loads((want / "Default" / "Preferences").read_text(encoding="utf-8"))
    assert prefs["credentials_enable_service"] is False
    assert prefs["profile"]["password_manager_enabled"] is False

    # Chrome rewrites the cached value with the real timestamp while it runs;
    # the next call must put the guard back, keeping Chrome's other state
    local_state["password_manager"]["os_password_last_changed"] = "13370000000000000"
    local_state["browser"] = {"kept": True}
    (want / "Local State").write_text(json.dumps(local_state), encoding="utf-8")
    r = _run(env)
    assert r.returncode == 0, r.stderr
    again = json.loads((want / "Local State").read_text(encoding="utf-8"))
    assert again["password_manager"]["os_password_last_changed"] == NEVER
    assert again["browser"] == {"kept": True}


def test_caller_args_are_kept_and_no_bot_gets_the_shared_dir(tmp_path):
    env, home, _ = _setup(tmp_path)
    env["AGENT_BROWSER_ARGS"] = "--lang=en"
    r = _run(env)
    assert r.returncode == 0, r.stderr
    profile, args = r.stdout.strip().splitlines()[-1].split("|")
    assert args.split(",") == ["--lang=en", "--auth-server-allowlist=none.invalid"]
    assert (home / ".agent-browser" / "profile" / "Local State").is_file(), profile


def test_a_failed_seed_never_starts_chrome(tmp_path):
    env, _, ran = _setup(tmp_path)
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("x", encoding="utf-8")
    env["AGENT_BROWSER_PROFILE"] = str(blocker / "profile")  # makedirs under a file fails
    r = _run(env)
    assert r.returncode != 0
    assert "refusing to launch Chrome" in r.stderr
    assert not ran.exists()
