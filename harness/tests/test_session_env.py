"""v0.1.7: which env (so which OAuth / Telegram token) a running session got.

Claude Code strips CLAUDE_CODE_OAUTH_TOKEN from its hooks' env, so the session
reports BOT_LAUNCHER_PID + the Telegram token's last 4
(<config>/botcorp/session-env.json, hooks/session-env.sh ->
tools/v2/session_env.py) and each launch records what it injected, last 4 only
(<config>/botcorp/launch-env.json, Add-LaunchEnvRecord).

Locked behaviour:
- the hook records last 4 only, keyed by session id, newest KEEP kept, and is
  a silent no-op without CLAUDE_CONFIG_DIR or a session id;
- Add-LaunchEnvRecord keeps the newest N launches by `at`;
- Get-SessionEnvRecord only considers rows written since the launch, prefers
  the launcher's session id, else the newest (pwsh 7 and 5.1 parse `at`
  differently);
- Get-SessionEnvCheck: OK (this launch) | STALE (an earlier launch) |
  FOREIGN (no BOT_LAUNCHER_PID) | UNKNOWN (no record);
- sessionEnvVerdict FAILs a session whose OAuth came from the environment or
  differs from the vault, one with no/other Telegram token when --channels was
  passed, and one not from a BotCorp launch.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

import session_env

ASSEMBLY = Path(__file__).resolve().parents[2]
HARNESS = ASSEMBLY / "harness"
COMMON = ASSEMBLY / "daemon" / "_common.ps1"
LIB = (ASSEMBLY / "cli" / "_lib.mjs").as_uri()
WINPS = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"

needs_pwsh = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None,
                                reason="Windows with pwsh on PATH")
needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")

OAUTH = "dummy-oauth-for-tests-only-Q7w3"
TG = "123456789:AAdummyTokenForTestsOnlyXyZ9"


def _ps(body: str, exe: str = "pwsh") -> str:
    r = subprocess.run([exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", f". '{COMMON}'\n{body}"],
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


def test_record_is_last4_only_and_merge_keeps_the_newest():
    rec = session_env.build_record({"CLAUDE_CODE_OAUTH_TOKEN": OAUTH, "TELEGRAM_BOT_TOKEN": TG, "BOT_LAUNCHER_PID": "4242", "BOT_NAME": "alpha"}, "s1", "2026-09-25T00:00:01Z")
    assert rec == {"session_id": "s1", "at": "2026-09-25T00:00:01Z", "oauth_last4": "Q7w3", "telegram_last4": "XyZ9", "launcher_pid": 4242, "bot": "alpha"}
    bare = session_env.build_record({"BOT_LAUNCHER_PID": "not-a-pid"}, "s2", "2026-09-25T00:00:02Z")
    assert bare["oauth_last4"] is None and bare["telegram_last4"] is None and bare["launcher_pid"] is None
    merged = {}
    for i in range(5):
        merged = session_env.merge(merged, session_env.build_record({}, f"s{i}", f"2026-09-25T00:00:0{i}Z"), keep=3)
    assert sorted(merged["sessions"]) == ["s2", "s3", "s4"]


def test_hook_writes_the_session_row_and_never_a_full_token(tmp_path):
    home = tmp_path / "bot"
    home.mkdir()
    cfg = tmp_path / "cfg"
    env = dict(os.environ)
    env.update({"CLAUDE_PLUGIN_ROOT": str(HARNESS), "BOT_HOME": str(home), "BOT_NAME": "bot", "CLAUDE_CONFIG_DIR": str(cfg),
                "BOT_LAUNCHER_PID": "4242", "TELEGRAM_BOT_TOKEN": TG, "CLAUDE_CODE_OAUTH_TOKEN": OAUTH, "PYTHONIOENCODING": "utf-8"})
    r = subprocess.run(["bash", str(HARNESS / "hooks" / "session-env.sh")], input=json.dumps({"session_id": "t1"}),
                       capture_output=True, text=True, env=env, timeout=60)
    assert r.returncode == 0 and r.stdout == "", r.stderr
    text = (cfg / "botcorp" / "session-env.json").read_text(encoding="utf-8")
    row = json.loads(text)["sessions"]["t1"]
    assert (row["launcher_pid"], row["telegram_last4"], row["oauth_last4"]) == (4242, "XyZ9", "Q7w3")
    assert TG not in text and OAUTH not in text
    # no session id / no config home: nothing written, still exit 0
    env2 = dict(env, CLAUDE_CONFIG_DIR=str(tmp_path / "cfg2"))
    assert subprocess.run(["bash", str(HARNESS / "hooks" / "session-env.sh")], input="{}", capture_output=True, text=True, env=env2, timeout=60).returncode == 0
    assert not (tmp_path / "cfg2" / "botcorp" / "session-env.json").exists()


@needs_pwsh
def test_launch_env_record_keeps_the_newest_launches(tmp_path):
    cfg = tmp_path / "cfg"
    body = "; ".join(f"[void](Add-LaunchEnvRecord -ConfigDir '{cfg}' -LauncherPid {100 + i} -OauthLast4 'Q7w3' -OauthSource 'vault' -TelegramLast4 '' -At '2026-09-25T00:00:0{i}Z' -Keep 3)" for i in range(5))
    _ps(body + "; 'ok'")
    launches = json.loads((cfg / "botcorp" / "launch-env.json").read_text(encoding="utf-8"))["launches"]
    assert sorted(launches) == ["102", "103", "104"]
    assert launches["104"]["oauth_last4"] == "Q7w3" and launches["104"]["oauth_source"] == "vault" and launches["104"]["telegram_last4"] is None


@needs_pwsh
@pytest.mark.parametrize("exe", ["pwsh", "winps"])
def test_session_env_record_since_the_launch_and_the_check(tmp_path, exe):
    if exe == "winps":
        if not WINPS.is_file():
            pytest.skip("no Windows PowerShell 5.1")
        exe = str(WINPS)
    cfg = tmp_path / "cfg"
    (cfg / "botcorp").mkdir(parents=True)
    rows = {
        "old": {"session_id": "old", "at": "2026-09-24T23:00:00Z", "launcher_pid": 111, "telegram_last4": "XyZ9"},
        "mine": {"session_id": "mine", "at": "2026-09-25T00:00:05Z", "launcher_pid": 222, "telegram_last4": "XyZ9"},
        "copy": {"session_id": "copy", "at": "2026-09-25T00:00:09Z", "launcher_pid": None, "telegram_last4": None},
    }
    (cfg / "botcorp" / "session-env.json").write_text(json.dumps({"sessions": rows}), encoding="utf-8")
    since = "([DateTimeOffset]::Parse('2026-09-25T00:00:00Z')).UtcDateTime"
    got = _ps(f"$a = Get-SessionEnvRecord -ConfigDir '{cfg}' -SessionId 'mine' -Since {since};"
              f" $b = Get-SessionEnvRecord -ConfigDir '{cfg}' -SessionId 'old' -Since {since};"
              f" $c = Get-SessionEnvRecord -ConfigDir '{cfg}' -SessionId 'x' -Since ([DateTimeOffset]::Parse('2026-09-25T01:00:00Z')).UtcDateTime;"
              " \"$($a.session_id) $($b.session_id) $($null -eq $c)"
              " $((Get-SessionEnvCheck -Record $a -LauncherPid 222).Verdict) $((Get-SessionEnvCheck -Record $a -LauncherPid 333).Verdict)"
              " $((Get-SessionEnvCheck -Record $b -LauncherPid 222).Verdict) $((Get-SessionEnvCheck -Record $null -LauncherPid 222).Verdict)\"", exe=exe)
    # 'old' predates the launch, so the newest since then ('copy', no launcher pid) stands in for it
    assert got == "mine copy True OK STALE FOREIGN UNKNOWN"


@needs_node
def test_pick_session_env_record():
    rows = {"old": {"session_id": "old", "at": "2026-09-24T23:00:00Z"}, "a": {"session_id": "a", "at": "2026-09-25T00:00:05Z"},
            "b": {"session_id": "b", "at": "2026-09-25T00:00:09Z"}}
    got = _node(f"[m.pickSessionEnvRecord({json.dumps(rows)}, 'a', '2026-09-25T02:00:00+02:00'),"
                f" m.pickSessionEnvRecord({json.dumps(rows)}, 'old', '2026-09-25T02:00:00+02:00'),"
                f" m.pickSessionEnvRecord({json.dumps(rows)}, 'a', '2026-09-25T03:00:00+02:00'), m.pickSessionEnvRecord(null, 'a', null)]")
    assert [g and g["session_id"] for g in got] == ["a", "b", None, None]


@needs_node
def test_session_env_verdict_truth_table():
    rec = {"session_id": "s", "launcher_pid": 222, "telegram_last4": "XyZ9"}
    vault_launch = {"at": "2026-09-25T00:00:00Z", "oauth_last4": "Q7w3", "oauth_source": "vault"}
    vault = {"oauth": "Q7w3", "telegram": "XyZ9"}
    cases = [
        ({"running": False}, ("INFO", None)),
        ({"running": True}, ("WARN", "UNKNOWN")),
        ({"running": True, "rec": dict(rec, launcher_pid=None), "machineOauth": "Mw99"}, ("FAIL", "FOREIGN")),
        ({"running": True, "rec": rec}, ("WARN", "UNKNOWN")),
        ({"running": True, "rec": rec, "launch": vault_launch, "lastLauncherPid": 222, "vault": vault, "expectTg": True}, ("PASS", "OK")),
        # an earlier launch's env with this bot's tokens is harmless
        ({"running": True, "rec": rec, "launch": vault_launch, "lastLauncherPid": 999, "vault": vault, "expectTg": True}, ("PASS", "OK")),
        ({"running": True, "rec": rec, "launch": dict(vault_launch, oauth_last4="Mw99", oauth_source="inherited"), "lastLauncherPid": 222}, ("FAIL", "MISMATCH")),
        ({"running": True, "rec": rec, "launch": vault_launch, "lastLauncherPid": 222, "vault": {"oauth": "New1"}}, ("FAIL", "MISMATCH")),
        ({"running": True, "rec": dict(rec, telegram_last4=None), "launch": vault_launch, "lastLauncherPid": 222, "expectTg": True}, ("FAIL", "MISMATCH")),
        ({"running": True, "rec": dict(rec, telegram_last4=None), "launch": vault_launch, "lastLauncherPid": 222, "expectTg": False}, ("PASS", "OK")),
        ({"running": True, "rec": rec, "launch": vault_launch, "lastLauncherPid": 222, "vault": {"telegram": "Othr"}, "expectTg": True}, ("FAIL", "MISMATCH")),
        ({"running": True, "rec": rec, "launch": dict(vault_launch, oauth_last4=None, oauth_source="none"), "lastLauncherPid": 222, "vault": {"oauth": ""}}, ("PASS", "OK")),
    ]
    got = _node(f"{json.dumps([c for c, _ in cases])}.map((c) => {{ const v = m.sessionEnvVerdict(c); return [v.level, v.env, v.detail]; }})")
    assert [(g[0], g[1]) for g in got] == [want for _, want in cases]
    assert "Mw99" in got[2][2] and "****Q7w3 (vault)" in got[4][2] and "earlier launch" in got[5][2]
