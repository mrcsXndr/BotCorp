"""v0.1.13: the reference host's reboot test.

A. The bg session died every ~63 min: Claude Code's supervisor retires an
   unpinned idle background worker 60 min after its last activity (the roster
   row ends `done`), then the next 3-min tick cold-started it. The fix pins it
   (<config>/jobs/pins.json, the file the fleet view's ctrl+t writes).
B. The tick logged poller=UNKNOWN all night while `status` said OWNED: it
   probed getUpdates with a token it never has. It now measures like status.
C. After a reboot nothing visible happened: the first daemon cold-start of a
   boot seeds ONE prompt (bot.yaml harness.boot_prompt), once per boot.

Locked behaviour:
- Set-BgPin adds the short id, is idempotent, drops only the previous id it is
  told to replace, keeps every other pin, never overwrites a non-array file;
- Test-BootKickDue: only when the previous launch predates the boot (or a
  pending kick of this boot did not come up), never twice per boot, never for a
  bot launched for the first time;
- Get-PollerVerdict: bot.pid alive under claude = OWNED, outside = DEAD, no
  bot.pid = DEAD, no claude pid = UNKNOWN, FOREIGN / NONE kept;
- the tick's own code path (-ProbeOnly) logs that verdict, not UNKNOWN;
- a real tick pins a live unpinned session (keeping other pins) and logs,
  once, the BLOCKED line for a job waiting on a login;
- Get-BgBlock / bgBlockVerdict: waiting for the next prompt is not blocked,
  a login or a dialog is;
- a daemon cold-start after a boot passes the boot prompt to claude (launch
  -DryRun), a manual start does not;
- bot.yaml harness.boot_prompt: null = the default for a telegram bot, '' = off.
"""
from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
COMMON = ASSEMBLY / "daemon" / "_common.ps1"
LIB = (ASSEMBLY / "cli" / "_lib.mjs").as_uri()
BOTYAML = ASSEMBLY / "daemon" / "botyaml.mjs"

needs_pwsh = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None, reason="Windows with pwsh on PATH")
needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")


def _ps(body: str, env: dict | None = None) -> str:
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", f". '{COMMON}'\n{body}"],
                       capture_output=True, text=True, timeout=180, cwd=str(ASSEMBLY), env=env)
    assert r.returncode == 0, r.stderr + r.stdout
    lines = [ln for ln in r.stdout.splitlines() if ln.strip()]
    assert lines, r.stderr
    return lines[-1]


def _node(expr: str) -> object:
    script = f"const m = await import({json.dumps(LIB)}); console.log(JSON.stringify({expr}));"
    r = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, timeout=120, cwd=str(ASSEMBLY))
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout.strip().splitlines()[-1])


# --- A: pins ------------------------------------------------------------------------
@needs_pwsh
def test_set_bg_pin_adds_is_idempotent_replaces_only_its_own_and_keeps_the_rest(tmp_path):
    cfg = tmp_path / "cfg"
    pins = cfg / "jobs" / "pins.json"
    q = f"'{cfg}'"
    assert _ps(f"Set-BgPin -ConfigDir {q} -BgId 'aaaa1111'") == "pinned"
    assert json.loads(pins.read_text(encoding="utf-8")) == ["aaaa1111"]
    assert _ps(f"Set-BgPin -ConfigDir {q} -BgId 'aaaa1111'") == "already"
    pins.write_text(json.dumps(["aaaa1111", "0perat0r"]), encoding="utf-8")   # a pin the operator made
    assert _ps(f"Set-BgPin -ConfigDir {q} -BgId 'bbbb2222' -Replace 'aaaa1111'") == "pinned"
    assert json.loads(pins.read_text(encoding="utf-8")) == ["0perat0r", "bbbb2222"]
    assert _ps(f"(@(Get-BgPins -ConfigDir {q}) -join ',')") == "0perat0r,bbbb2222"
    pins.write_text('{"not": "an array"}', encoding="utf-8")
    assert _ps(f"Set-BgPin -ConfigDir {q} -BgId 'cccc3333'").startswith("failed: jobs/pins.json is not a JSON array")
    assert json.loads(pins.read_text(encoding="utf-8")) == {"not": "an array"}
    assert _ps(f"Set-BgPin -ConfigDir {q} -BgId 'not-an-id!'").startswith("failed:")
    pins.write_text("[]", encoding="utf-8")
    assert _ps(f"Set-BgPin -ConfigDir {q} -BgId 'dddd4444'") == "pinned"
    assert json.loads(pins.read_text(encoding="utf-8")) == ["dddd4444"]


@needs_node
def test_doctor_pin_and_block_verdicts():
    got = _node("[m.bgPinVerdict({running: true, bgId: 'aaaa1111', pins: ['aaaa1111']}), m.bgPinVerdict({running: true, bgId: 'aaaa1111', pins: []}),"
                " m.bgPinVerdict({running: true, bgId: 'aaaa1111', pins: null}), m.bgPinVerdict({running: false}), m.bgPinVerdict({running: true})]")
    assert [g["level"] for g in got] == ["PASS", "FAIL", "FAIL", "INFO", "WARN"]
    assert "retires it after 60 min idle" in got[1]["detail"]
    blk = _node("[m.bgBlockVerdict({running: true, bgId: 'a1b2c3d4', job: {tempo: 'blocked', needs: 'send a prompt to start'}}),"
                " m.bgBlockVerdict({running: true, bgId: 'a1b2c3d4', job: {tempo: 'blocked', needs: 'login required - run /login'}}),"
                " m.bgBlockVerdict({running: true, bgId: 'a1b2c3d4', job: {tempo: 'active', state: 'working'}}),"
                " m.bgBlockVerdict({running: true, bgId: 'a1b2c3d4', job: null})]")
    assert [b["level"] for b in blk] == ["PASS", "FAIL", "PASS", "INFO"]
    assert "login required" in blk[1]["detail"] and "claude attach a1b2c3d4" in blk[1]["detail"]


@needs_pwsh
def test_get_bg_block_reads_the_job_record(tmp_path):
    cfg = tmp_path / "cfg"
    job = cfg / "jobs" / "a1b2c3d4"
    job.mkdir(parents=True)
    q = f"'{cfg}'"
    (job / "state.json").write_text(json.dumps({"state": "working", "tempo": "blocked", "needs": "send a prompt to start"}), encoding="utf-8")
    assert _ps(f"'[' + (Get-BgBlock -ConfigDir {q} -BgId 'a1b2c3d4') + ']'") == "[]"
    (job / "state.json").write_text(json.dumps({"state": "blocked", "tempo": "blocked", "needs": "login required - run /login"}), encoding="utf-8")
    assert _ps(f"Get-BgBlock -ConfigDir {q} -BgId 'a1b2c3d4'") == "login required - run /login"
    assert _ps(f"'[' + (Get-BgBlock -ConfigDir {q} -BgId 'ffff0000') + ']'") == "[]"


# --- C: boot kick-off -------------------------------------------------------------------
@needs_pwsh
def test_boot_kick_fires_once_per_boot_and_only_after_one():
    boot = "2026-09-25T02:00:00Z"
    cases = {
        "before boot": (f"'{boot}' '2026-09-24T23:00:00.0000000+00:00' '' ''", "True"),
        "after boot (routine relaunch)": (f"'{boot}' '2026-09-25T04:06:00.0000000+00:00' '' ''", "False"),
        "already kicked this boot": (f"'{boot}' '2026-09-24T23:00:00.0000000+00:00' '{boot}' ''", "False"),
        "pending, launch did not come up": (f"'{boot}' '2026-09-25T04:06:00.0000000+00:00' '' '{boot}'", "True"),
        "never launched": (f"'{boot}' '' '' ''", "False"),
        "boot unreadable": (f"'' '2026-09-24T23:00:00.0000000+00:00' '' ''", "False"),
        "kicked last boot, rebooted": (f"'{boot}' '2026-09-24T23:00:00.0000000+00:00' '2026-09-20T01:00:00Z' ''", "True"),
    }
    for name, (args, want) in cases.items():
        b, prev, last, pend = [a.strip("'") for a in args.split(" ")]
        got = _ps(f"Test-BootKickDue -BootKey '{b}' -PrevStartedAt $(if ('{prev}') {{ '{prev}' }} else {{ $null }}) -LastKickBoot '{last}' -PendingBoot '{pend}'")
        assert got == want, name
    # a parsed JSON value (pwsh 7 turns ISO text into [datetime]) works the same
    assert _ps(f"Test-BootKickDue -BootKey '{boot}' -PrevStartedAt ('{{\"t\":\"2026-09-24T23:00:00+00:00\"}}' | ConvertFrom-Json).t") == "True"


@needs_node
def test_boot_prompt_default_off_and_custom(tmp_path):
    def eff(yaml_text: str):
        f = tmp_path / "bot.yaml"
        f.write_text(yaml_text, encoding="utf-8")
        r = subprocess.run(["node", str(BOTYAML), str(f)], capture_output=True, text=True, timeout=60)
        assert r.returncode == 0, r.stderr
        j = json.loads(r.stdout)
        return j["_boot_prompt"], j["_errors"]
    tg = "name: b\nharness:\n  modules:\n    telegram: true\n"
    p, errs = eff(tg)
    assert not errs and "tools/tg/tg_send.py" in p and "{now}" in p and "back online after reboot" in p
    assert eff("name: b\n")[0] == ""                                  # no telegram: nothing to say it with
    assert eff(tg + "  boot_prompt: ''\n")[0] == ""                   # off
    assert eff("name: b\nharness:\n  boot_prompt: 'check in at {now}'\n")[0] == "check in at {now}"
    assert eff("name: b\nharness:\n  boot_prompt: 5\n")[1]


# --- B + C through the real scripts ---------------------------------------------------------
@pytest.fixture
def repo_bot(tmp_path):
    """A throwaway bot in the checkout's bots/ (the tick and the launcher only
    look there) with an isolated runtime home; removed afterwards."""
    name = f"zz-t{secrets.token_hex(3)}"
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


@pytest.fixture
def fake_claude(tmp_path):
    """A live process NAMED claude.exe (a copy of cmd.exe) with a child: the
    child stands in for the plugin's bun server (bot.pid)."""
    exe = tmp_path / "claude.exe"
    shutil.copy2(Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe", exe)
    p = subprocess.Popen([str(exe), "/c", "ping -n 120 127.0.0.1 >nul"], creationflags=subprocess.CREATE_NO_WINDOW)
    child = 0
    for _ in range(50):
        out = subprocess.run(["pwsh", "-NoProfile", "-Command", f"(Get-CimInstance Win32_Process -Filter 'ParentProcessId={p.pid}' | Where-Object Name -eq 'PING.EXE').ProcessId"],
                             capture_output=True, text=True, timeout=60).stdout.strip()
        if out.isdigit():
            child = int(out)
            break
        time.sleep(0.2)
    assert child, "fake poller child did not start"
    try:
        yield p.pid, child
    finally:
        subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True)


@needs_pwsh
def test_poller_verdict_measures_bot_pid_under_claude(tmp_path, fake_claude):
    claude_pid, child = fake_claude
    f = tmp_path / "bot.pid"
    q = f"'{f}'"
    f.write_text(f"{child}\n", encoding="utf-8")
    assert _ps(f"Get-PollerVerdict -BotPidFile {q} -ClaudePid {claude_pid}") == "OWNED"
    f.write_text(f"{os.getpid()}\n", encoding="utf-8")             # alive, but not under this claude
    assert _ps(f"Get-PollerVerdict -BotPidFile {q} -ClaudePid {claude_pid}") == "DEAD"
    f.unlink()
    assert _ps(f"Get-PollerVerdict -BotPidFile {q} -ClaudePid {claude_pid}") == "DEAD"
    f.write_text(f"{child}\n", encoding="utf-8")
    assert _ps(f"Get-PollerVerdict -BotPidFile {q} -ClaudePid 0") == "UNKNOWN"
    assert _ps(f"Get-PollerVerdict -BotPidFile {q} -ClaudePid {claude_pid} -Recorded FOREIGN") == "FOREIGN"


@needs_pwsh
@needs_node
def test_the_tick_logs_the_measured_poller(repo_bot, fake_claude):
    name, home, rt, env = repo_bot
    claude_pid, child = fake_claude
    (home / "bot.yaml").write_text(f"name: {name}\nharness:\n  service: manual\n  modules:\n    telegram: true\n", encoding="utf-8")
    tg = home / f".claude-{name}" / "channels" / "telegram"
    tg.mkdir(parents=True)
    (tg / "bot.pid").write_text(f"{child}\n", encoding="utf-8")
    (rt / "state" / f"{name}.json").write_text(json.dumps({"bot": name, "claude_pid": claude_pid, "status": "running", "poller": "OWNED", "service": "bg", "bg_id": ""}), encoding="utf-8")
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ASSEMBLY / "daemon" / "tick.ps1"), "-ProbeOnly"],
                       capture_output=True, text=True, timeout=300, cwd=str(ASSEMBLY), env=env)
    assert r.returncode == 0, r.stderr
    log = (rt / "daemon.log").read_text(encoding="utf-8")
    line = next((ln for ln in log.splitlines() if f"[{name}] state:" in ln), "")
    assert "alive=True" in line and "poller=OWNED" in line, log[-2000:]


@needs_pwsh
@needs_node
def test_a_real_tick_pins_a_live_unpinned_session_and_logs_blocked(repo_bot, fake_claude, tmp_path):
    name, home, rt, env = repo_bot
    claude_pid, _ = fake_claude
    (home / "bot.yaml").write_text(f"name: {name}\nharness:\n  service: manual\n  modules:\n    telegram: false\n", encoding="utf-8")
    jobs = home / f".claude-{name}" / "jobs"
    (jobs / "abc123").mkdir(parents=True)
    (jobs / "pins.json").write_text('["0ther1"]', encoding="utf-8")
    (jobs / "abc123" / "state.json").write_text(json.dumps({"state": "blocked", "tempo": "blocked", "needs": "login required - run /login"}), encoding="utf-8")
    (rt / "state" / f"{name}.json").write_text(json.dumps({"bot": name, "claude_pid": claude_pid, "status": "running", "service": "bg", "bg_id": "abc123"}), encoding="utf-8")
    # keep the machine steps from spawning anything: cockpit off, update check done, otel sink "alive"
    (rt / "cockpit.json").write_text('{"enabled": false}', encoding="utf-8")
    (rt / "state" / "daemon.json").write_text(json.dumps({"update_check_at": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())}), encoding="utf-8")
    node = tmp_path / "fake-node" / "node.exe"
    node.parent.mkdir()
    shutil.copy2(Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe", node)
    sink = subprocess.Popen([str(node), "/c", "ping -n 120 127.0.0.1 >nul"], creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        (rt / "state" / "otel.json").write_text(json.dumps({"pid": sink.pid}), encoding="utf-8")
        r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ASSEMBLY / "daemon" / "tick.ps1")],
                           capture_output=True, text=True, timeout=300, cwd=str(ASSEMBLY), env=env)
    finally:
        subprocess.run(["taskkill", "/PID", str(sink.pid), "/T", "/F"], capture_output=True)
    assert r.returncode == 0, r.stderr
    log = (rt / "daemon.log").read_text(encoding="utf-8")
    assert "ACTION=OTEL-START" not in log and "ACTION=START" not in log, log[-2000:]
    assert json.loads((jobs / "pins.json").read_text(encoding="utf-8")) == ["0ther1", "abc123"]
    assert "bg session abc123 was not pinned -> pinned" in log
    assert "BLOCKED: session abc123 waits on 'login required - run /login'" in log
    st = json.loads((rt / "state" / f"{name}.json").read_text(encoding="utf-8"))
    assert st["pinned_bg_id"] == "abc123" and st["session_blocked"].startswith("login required")


@needs_pwsh
@needs_node
def test_a_daemon_cold_start_after_a_boot_passes_the_boot_prompt(repo_bot):
    name, home, rt, env = repo_bot
    (home / "bot.yaml").write_text(f"name: {name}\nharness:\n  service: manual\n  boot_prompt: 'BOOTCHECK {{now}}'\n  modules:\n    telegram: false\n", encoding="utf-8")
    state = rt / "state" / f"{name}.json"
    launch = ["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ASSEMBLY / "daemon" / "launch.ps1"), "-Bot", name, "-Bg", "-DryRun"]
    state.write_text(json.dumps({"bot": name, "status": "exited", "started_at": "2000-01-01T00:00:00.0000000+00:00"}), encoding="utf-8")
    cold = subprocess.run(launch + ["-StartedBy", "daemon-cold"], capture_output=True, text=True, timeout=300, cwd=str(ASSEMBLY), env=env)
    assert cold.returncode == 0, cold.stderr
    argv = next(ln for ln in cold.stdout.splitlines() if ln.strip().startswith("argv:"))
    assert "BOOTCHECK 20" in argv and "{now}" not in argv
    assert "seeding the boot prompt" in cold.stdout
    manual = subprocess.run(launch + ["-StartedBy", "cli"], capture_output=True, text=True, timeout=300, cwd=str(ASSEMBLY), env=env)
    assert manual.returncode == 0, manual.stderr
    assert "BOOTCHECK" not in manual.stdout
    # launched since this boot: a routine relaunch seeds nothing
    state.write_text(json.dumps({"bot": name, "status": "exited", "started_at": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())}), encoding="utf-8")
    again = subprocess.run(launch + ["-StartedBy", "daemon-cold"], capture_output=True, text=True, timeout=300, cwd=str(ASSEMBLY), env=env)
    assert again.returncode == 0 and "BOOTCHECK" not in again.stdout
