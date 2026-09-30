"""v0.8.6 R11 + review 2026-09-30 findings 10/11: the janitor touches only its own bot.

Locked behaviour:
- ab.sh gives a BotCorp bot (BOT_NAME set) its own agent-browser directory,
  ~/.agent-browser/botcorp/<bot>: the daemon's socket dir, the temp dir its
  Chrome profiles are made in, and the activity heartbeat; without BOT_NAME
  it keeps the shared default;
- Test-OwnedProc: a process is the bot's when its command line names one of
  the bot's own directories (with a path boundary, so bots/alpha is not
  bots/alphabot) or its parent chain reaches the bot's claude pid; nothing
  else is, and only the bot's own processes are ever reaped;
- Test-PrunableSessionDir: a transcript subdirectory is pruned only when the
  NEWEST file anywhere under it is older than the cut (a directory's own mtime
  does not move when a nested file is written), never `memory`, never the
  bot's current session;
- the daemon runs the janitor with -Tg, so what it finds goes through
  tg_send.py --alert (alerts.log; pushed only when CRITICAL).
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

from test_resource_monitor_bridge import MONITOR, _extract_fn, _ps_str, _run_ps, needs_pwsh

ASSEMBLY = Path(__file__).resolve().parents[2]
AB = ASSEMBLY / "harness" / "tools" / "browser" / "ab.sh"
COMMON = ASSEMBLY / "daemon" / "_common.ps1"


def _fn(name: str) -> str:
    fn = _extract_fn(name)
    assert fn, f"resource_monitor.ps1 no longer defines {name}"
    return fn


def _proc(cmd: str, pid: int, ppid: int) -> str:
    return f"[pscustomobject]@{{ ProcessId = {pid}; ParentProcessId = {ppid}; CommandLine = {_ps_str(cmd)} }}"


@needs_pwsh
def test_owned_proc_by_directory_or_by_the_bots_claude():
    fn = _fn("Test-OwnedProc")
    needles = "@('D:\\prof\\.agent-browser\\botcorp\\alpha', 'C:\\bots\\alpha')"
    parents = "@{ 10 = 5; 11 = 10; 20 = 7; 7 = 3 }"   # 11 -> 10 -> 5 (the claude pid)
    cases = [
        (_proc(r"chrome.exe --user-data-dir=D:\prof\.agent-browser\botcorp\alpha\tmp\agent-browser-chrome-1", 30, 1), True),
        (_proc(r"chrome.exe --user-data-dir=D:/prof/.agent-browser/botcorp/alpha/tmp/p", 31, 1), True),
        (_proc(r"chrome.exe --user-data-dir=D:\prof\.agent-browser\botcorp\alphabot\tmp\p", 32, 1), False),   # another bot
        (_proc(r"chrome.exe --user-data-dir=D:\prof\AppData\Local\Temp\agent-browser-chrome-2", 33, 1), False),  # shared default
        (_proc(r"node --test C:\bots\alpha\tests\a.test.mjs", 34, 1), True),
        (_proc(r"node --test C:\bots\alpha-mirror\tests\a.test.mjs", 35, 1), False),
        (_proc(r"node node_modules\vite\bin\vite.js", 11, 10), True),     # descends from the claude pid
        (_proc(r"node node_modules\vite\bin\vite.js", 20, 7), False),
        (_proc("", 36, 1), False),
    ]
    body = "$o = @(); " + "; ".join(f"$o += (Test-OwnedProc -Proc ({p}) -Parents {parents} -ClaudePid 5 -Needles {needles})" for p, _ in cases) + "; $o -join ','"
    assert _run_ps(f"{fn}\n{body}") == ",".join(str(w) for _, w in cases)
    # no claude pid and no needles: nothing is ours
    assert _run_ps(f"{fn}\nTest-OwnedProc -Proc ({cases[6][0]}) -Parents {parents} -ClaudePid 0 -Needles @()") == "False"


@needs_pwsh
def test_a_session_dir_is_aged_by_its_newest_file(tmp_path):
    fn = _fn("Test-PrunableSessionDir")
    old = time.time() - 30 * 86400
    live = tmp_path / "aaaa-live"          # an old dir whose nested file is fresh (a long-running session)
    (live / "subagents").mkdir(parents=True)
    (live / "subagents" / "a.jsonl").write_text("x", encoding="utf-8")
    dead = tmp_path / "bbbb-dead"
    (dead / "tool-results").mkdir(parents=True)
    (dead / "tool-results" / "t.txt").write_text("x", encoding="utf-8")
    current = tmp_path / "cccc-current"
    current.mkdir()
    (current / "x.txt").write_text("x", encoding="utf-8")
    mem = tmp_path / "memory"
    mem.mkdir()
    (mem / "m.md").write_text("x", encoding="utf-8")
    for d in (live, live / "subagents", dead, dead / "tool-results", current, mem):
        os.utime(d, (old, old))
    for f in (dead / "tool-results" / "t.txt", current / "x.txt", mem / "m.md"):
        os.utime(f, (old, old))
    cut = "(Get-Date).AddDays(-7)"
    got = [_run_ps(f"{fn}\nTest-PrunableSessionDir -Dir (Get-Item {_ps_str(str(d))}) -Cut {cut} -Keep @('cccc-current')")
           for d in (live, dead, current, mem)]
    assert got == ["False", "True", "False", "False"]


@needs_pwsh
def test_the_daemon_runs_the_janitor_with_its_alert_path():
    body = ("$c = Get-JanitorArgs -Script 'x.ps1' -Mode clean; $r = Get-JanitorArgs -Script 'x.ps1' -Mode report; "
            "\"$($c -contains '-Tg')|$($r -contains '-Tg')|$($r -contains '-Clean')\"")
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", f". '{COMMON}'\n{body}"],
                       capture_output=True, text=True, timeout=120, cwd=str(ASSEMBLY))
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip().splitlines()[-1] == "True|True|False"


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash on PATH")
def test_ab_sh_gives_a_bot_its_own_browser_dir(tmp_path):
    # a stand-in agent-browser that prints the env it was started with
    npm_root = tmp_path / "npmroot"
    (npm_root / "agent-browser" / "bin").mkdir(parents=True)
    (npm_root / "agent-browser" / "bin" / "agent-browser.js").write_text(
        "console.log([process.env.AGENT_BROWSER_SOCKET_DIR || '', process.env.TEMP || '', process.env.TMP || ''].join('|'))\n", encoding="utf-8")
    shim = tmp_path / "bin"
    shim.mkdir()
    (shim / "npm").write_text(f'#!/usr/bin/env bash\necho "{npm_root.as_posix()}"\n', encoding="utf-8")
    home = tmp_path / "home"
    home.mkdir()
    base = {k: v for k, v in os.environ.items() if not k.startswith(("BOT_", "AGENT_BROWSER"))}
    base.update({"HOME": str(home), "USERPROFILE": str(home), "PATH": f"{shim.as_posix()}{os.pathsep}{base['PATH']}"})

    r = subprocess.run(["bash", str(AB), "get", "url"], capture_output=True, text=True, timeout=120, env={**base, "BOT_NAME": "alpha"})
    assert r.returncode == 0, r.stderr
    sock, temp, tmp = r.stdout.strip().splitlines()[-1].split("|")
    want = (home / ".agent-browser" / "botcorp" / "alpha").as_posix().lower()
    norm = lambda s: s.replace("\\", "/").lower()  # noqa: E731
    assert norm(sock).endswith(want.split(":", 1)[-1]), sock
    assert norm(temp).startswith(norm(sock)) and norm(tmp) == norm(temp), (sock, temp)
    assert (home / ".agent-browser" / "botcorp" / "alpha" / ".botcorp_activity").is_file()

    r = subprocess.run(["bash", str(AB), "get", "url"], capture_output=True, text=True, timeout=120, env=base)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip().splitlines()[-1].split("|")[0] == ""       # no bot: the shared default
    assert (home / ".agent-browser" / ".botcorp_activity").is_file()


@needs_pwsh
def test_a_report_run_splits_its_own_browser_procs_from_others(tmp_path):
    # the monitor still runs end to end (report mode only: never -Clean on a live box)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("BOT_", "CLAUDE"))}
    env.update({"BOT_NAME": "zz-janitor-test", "BOT_HOME": str(tmp_path / "bots" / "zz-janitor-test"),
                "BOTCORP_HOME": str(tmp_path / "rt"), "CLAUDE_CONFIG_DIR": str(tmp_path / "cfg")})
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(MONITOR)],
                       capture_output=True, text=True, timeout=120, env=env)
    assert r.returncode == 0, r.stderr
    import json
    out = json.loads(r.stdout.strip().splitlines()[-1])
    assert out["agent_browser_chrome"] == 0          # this test bot has no browser of its own
    assert "agent_browser_chrome_others" in out
    assert not out["actions"]
