"""v0.1.8: bun on the session's PATH, and a bg resume that never starts a copy.

Reference host: the Telegram plugin's .mcp.json runs a bare `bun`, which a
bg / session-0 launch's PATH lacked ("'bun' is not recognized" -> no poller);
and `claude --bg --resume <id>` WITH flags of a session the roster holds
"started a copy" that never came up while launch.ps1 exited 0.

Locked behaviour (daemon/_common.ps1 under pwsh, cli/_lib.mjs under node):
- Resolve-BunExe: harness.bun_path (a file) > PATH > <UserProfile>\\.bun\\bin;
  Add-PathDir puts that folder first, once;
- resolvePluginCommand / pluginCommandVerdict (doctor): nothing resolves =
  FAIL, this shell's PATH only = WARN, override / install folder = PASS;
- Get-BgResumePlan: roster + same flags = bare, roster + changed flags or an
  explicit --debug = refuse (a person's start) / fresh (unattended), not in
  the roster = flags, no id = fresh; the bare argv carries no flag;
  Get-BgFlagsKey ignores --bg, the resume id and --debug-file <path>;
- Get-BgLaunchResult: exit 0 with claude_pid 0 (or a dead pid) is exit 3;
- sessionAliveVerdict: a state that says running with no claude, or a failed
  last launch, is FAIL;
- bot.yaml harness.bun_path defaults to '' and must be a string.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
COMMON = ASSEMBLY / "daemon" / "_common.ps1"
LIB = (ASSEMBLY / "cli" / "_lib.mjs").as_uri()

needs_pwsh = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None,
                                reason="Windows with pwsh on PATH")
needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")


def _ps(body: str) -> str:
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", f". '{COMMON}'\n{body}"],
                       capture_output=True, text=True, timeout=120, cwd=str(ASSEMBLY))
    assert r.returncode == 0, r.stderr + r.stdout
    lines = [ln for ln in r.stdout.splitlines() if ln.strip()]
    assert lines, r.stderr
    return lines[-1]


def _node(expr: str) -> object:
    script = f"const m = await import({json.dumps(LIB)}); console.log(JSON.stringify({expr}));"
    r = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, timeout=120, cwd=str(ASSEMBLY))
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout.strip().splitlines()[-1])


@pytest.fixture
def fake_home(tmp_path):
    """A profile with bun where its installer puts it, and a PATH without it."""
    home = tmp_path / "home"
    (home / ".bun" / "bin").mkdir(parents=True)
    (home / ".bun" / "bin" / "bun.exe").write_bytes(b"")
    nobun = tmp_path / "nobun"
    nobun.mkdir()
    return home, nobun


@needs_pwsh
def test_resolve_bun_without_it_on_path_and_prepend(tmp_path, fake_home):
    home, nobun = fake_home
    other = tmp_path / "other"
    (other).mkdir()
    (other / "bun.exe").write_bytes(b"")
    ov = tmp_path / "pinned" / "bun.exe"
    ov.parent.mkdir()
    ov.write_bytes(b"")
    got = _ps(f"$a = Resolve-BunExe -Override '' -PathEnv '{nobun}' -UserProfile '{home}';"
              f" $b = Resolve-BunExe -Override '' -PathEnv '{nobun};{other}' -UserProfile '{home}';"
              f" $c = Resolve-BunExe -Override '{ov}' -PathEnv '{other}' -UserProfile '{home}';"
              f" $d = Resolve-BunExe -Override '{tmp_path / 'missing.exe'}' -PathEnv '{nobun}' -UserProfile '{nobun}';"
              " \"$($a.Source)|$($a.Path)|$($b.Source)|$($c.Source)|[$($d.Path)]\"")
    a_src, a_path, b_src, c_src, d = got.split("|")
    assert (a_src, Path(a_path), b_src, c_src, d) == ("~/.bun/bin", home / ".bun" / "bin" / "bun.exe", "PATH", "harness.bun_path", "[]")
    bindir = home / ".bun" / "bin"
    got = _ps(f"Add-PathDir -PathEnv 'C:\\a;{bindir}\\;C:\\b' -Dir '{bindir}'")
    assert got.split(";") == [str(bindir), "C:\\a", "C:\\b"]


@needs_node
def test_doctor_fails_when_the_plugin_command_resolves_nowhere(tmp_path, fake_home):
    home, nobun = fake_home
    other = tmp_path / "other"
    other.mkdir()
    (other / "bun.exe").write_bytes(b"")
    base = {"command": "bun", "platform": "win32"}
    cases = [
        dict(base, pathEnv=str(nobun), userProfile=str(nobun)),                      # nowhere -> FAIL
        dict(base, pathEnv=str(nobun), userProfile=str(home)),                       # install folder -> PASS
        dict(base, pathEnv=f"{nobun};{other}", userProfile=str(nobun)),              # this shell's PATH only -> WARN
        dict(base, pathEnv=str(nobun), userProfile=str(nobun), override=str(other / "bun.exe")),   # pinned -> PASS
    ]
    got = _node(f"{json.dumps(cases)}.map((c) => {{ const r = m.resolvePluginCommand(c); const v = m.pluginCommandVerdict(c.command, r); return [r.source, v.level, v.detail]; }})")
    assert [(g[0], g[1]) for g in got] == [("", "FAIL"), ("~/.bun/bin", "PASS"), ("PATH", "WARN"), ("harness.bun_path", "PASS")]
    assert "is not recognized" in got[0][2] and "harness.bun_path" in got[0][2]


@needs_pwsh
def test_resume_plan_and_the_bare_argv_has_no_flags():
    got = _ps("@((Get-BgResumePlan -ResumeId '' -InRoster $true -SavedFlags 'a' -Flags 'b' -Interactive $true),"
              " (Get-BgResumePlan -ResumeId 's' -InRoster $false -SavedFlags 'a' -Flags 'b' -Interactive $true),"
              " (Get-BgResumePlan -ResumeId 's' -InRoster $true -SavedFlags 'a' -Flags 'a' -Interactive $true),"
              " (Get-BgResumePlan -ResumeId 's' -InRoster $true -SavedFlags '' -Flags 'a' -Interactive $true),"
              " (Get-BgResumePlan -ResumeId 's' -InRoster $true -SavedFlags 'a' -Flags 'b' -Interactive $true),"
              " (Get-BgResumePlan -ResumeId 's' -InRoster $true -SavedFlags 'a' -Flags 'b' -Interactive $false),"
              " (Get-BgResumePlan -ResumeId 's' -InRoster $true -SavedFlags 'a' -Flags 'a' -Interactive $true -DebugRequested $true),"
              " (Get-BgResumePlan -ResumeId 's' -InRoster $false -SavedFlags 'a' -Flags 'a' -Interactive $true -DebugRequested $true)) -join ','")
    # `start --debug` of a roster session cannot add the flag without a copy: refuse; not in the roster, flags apply
    assert got == "fresh,flags,bare,bare,refuse,fresh,refuse,flags"
    argv = json.loads(_ps("ConvertTo-Json -Compress @(Get-BgBareResumeArgv -ResumeId 'sid-1' -Seed @('continue from the TDL'))"))
    assert argv == ["--bg", "--resume", "sid-1", "continue from the TDL"]
    assert not [a for a in argv if a.startswith("--") and a not in ("--bg", "--resume")]


@needs_pwsh
def test_flags_key_is_what_the_session_saved():
    base = "'--bg','--dangerously-skip-permissions','--plugin-dir','C:\\h','--resume','sid-1'"
    got = _ps(f"$a = Get-BgFlagsKey -Argv @({base},'--channels','plugin:telegram@claude-plugins-official');"
              f" $b = Get-BgFlagsKey -Argv @('--bg','--dangerously-skip-permissions','--plugin-dir','C:\\h','--channels','plugin:telegram@claude-plugins-official');"
              f" $c = Get-BgFlagsKey -Argv @({base},'--debug-file','C:\\d\\1.txt');"
              f" $d = Get-BgFlagsKey -Argv @({base},'--debug-file','C:\\d\\2.txt');"
              f" $e = Get-BgFlagsKey -Argv @({base});"
              f" $f = Get-BgFlagsKey -Argv @({base},'--channels','plugin:telegram@claude-plugins-official','--settings','C:\\t.json');"
              " \"$($a -eq $b)|$($c -eq $d)|$($c -eq $e)|$($a -eq $f)|$a\"")
    same, debug_same, debug_ignored, settings_differ, key = got.split("|")
    # a session started with --debug must not read as "changed" on its next unattended resume
    assert (same, debug_same, debug_ignored, settings_differ) == ("True", "True", "True", "False")
    assert "sid-1" not in key and "--bg" not in key.split()


@needs_pwsh
def test_launch_with_no_live_claude_is_exit_3():
    got = _ps("@((Get-BgLaunchResult -ExitCode 0 -ClaudePid 0 -Alive $false).Code, (Get-BgLaunchResult -ExitCode 0 -ClaudePid 4242 -Alive $false).Code,"
              " (Get-BgLaunchResult -ExitCode 7 -ClaudePid 0 -Alive $false).Code, (Get-BgLaunchResult -ExitCode 0 -ClaudePid 4242 -Alive $true).Code) -join ','")
    assert got == "3,3,7,0"


@needs_node
def test_session_alive_verdict():
    cases = [
        ({"running": True, "state": {"claude_pid": 5, "session_id": "s"}}, "PASS"),
        ({"running": False, "state": {"status": "running", "session_id": "s", "bg_id": "b"}}, "FAIL"),
        ({"running": False, "state": {"status": "exited", "exit_code": 3}}, "FAIL"),
        ({"running": False, "state": {"status": "exited", "exit_code": 0}}, "INFO"),
        ({"running": False, "state": {"status": "running"}, "paused": True}, "INFO"),
        ({"running": False, "state": {"status": "stopped"}}, "INFO"),
        ({"running": False, "state": None}, "INFO"),
    ]
    got = _node(f"{json.dumps([c for c, _ in cases])}.map((c) => m.sessionAliveVerdict(c).level)")
    assert got == [want for _, want in cases]


@needs_node
def test_harness_bun_path_defaults_empty_and_must_be_a_string(tmp_path):
    botyaml = ASSEMBLY / "daemon" / "botyaml.mjs"

    def effective(text: str) -> dict:
        f = tmp_path / "bot.yaml"
        f.write_text(text, encoding="utf-8")
        r = subprocess.run(["node", str(botyaml), str(f)], capture_output=True, text=True, timeout=60)
        assert r.returncode == 0, r.stderr
        return json.loads(r.stdout)

    cfg = effective("name: alpha\n")
    assert cfg["harness"]["bun_path"] == "" and cfg["_errors"] == []
    assert effective("name: alpha\nharness:\n  bun_path: 'D:\\\\tools\\\\bun.exe'\n")["_errors"] == []
    assert any(e.startswith("harness.bun_path") for e in effective("name: alpha\nharness:\n  bun_path: 3\n")["_errors"])
