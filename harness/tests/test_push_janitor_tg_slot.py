"""v0.1.15: push on Stop, a report-only janitor, one poller per token.

Locked behaviour:
- the auto-commit Stop hook pushes ONLY with the backup module (`backup` in
  BOT_MODULES, i.e. backup.git_remote set), only from the bot folder's own repo,
  only to an existing origin; in the background (the hook returns before the
  push ends), non-interactive, 60 s bound; on a clean tree too, so a failed
  push is retried on the next Stop; one push.log line per attempt;
- doctor `<bot>: unpushed commits`: 0 = PASS, younger than 24 h = WARN, older =
  FAIL, no repo / origin / a detached HEAD / another origin = WARN;
- harness.modules.janitor: true | false | report; `report` counts as enabled
  and the tick runs the scan WITHOUT -Clean (Get-JanitorMode: PowerShell's
  `$true -eq 'report'` is True, so the type decides first);
- doctor `<bot>: foreign telegram owner-lock` (a launcher outside BotCorp) and
  `<bot>: telegram slot` (getUpdates 409 probe, only when this bot's own poller
  is not the holder, no offset, stops at the first 409).
"""
from __future__ import annotations

import http.server
import json
import os
import secrets
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
HOOK = ASSEMBLY / "harness" / "hooks" / "auto-commit.sh"
COMMON = ASSEMBLY / "daemon" / "_common.ps1"
BOTYAML = ASSEMBLY / "daemon" / "botyaml.mjs"
LIB = (ASSEMBLY / "cli" / "_lib.mjs").as_uri()

needs_bash = pytest.mark.skipif(shutil.which("bash") is None or shutil.which("git") is None, reason="bash + git on PATH")
needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")
needs_pwsh = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None or shutil.which("node") is None,
                                reason="Windows with pwsh and node on PATH")


def _git(cwd: Path, *args: str) -> str:
    r = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


def _node(expr: str):
    script = f"const m = await import({json.dumps(LIB)}); console.log(JSON.stringify(await ({expr})));"
    r = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, timeout=120, cwd=str(ASSEMBLY))
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout.strip().splitlines()[-1])


# --- B2: push on Stop ---------------------------------------------------------------------------
@pytest.fixture
def pushable(tmp_path):
    """A bot folder that is its own repo with one unpushed commit, and a bare origin."""
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "-q", "--bare", str(remote)], check=True)
    home = tmp_path / "bot"
    home.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main", str(home)], check=True)
    for k, v in (("user.email", "test@example.invalid"), ("user.name", "Test")):
        _git(home, "config", k, v)
    (home / "memory").mkdir()
    (home / "memory" / "a.md").write_text("one\n", encoding="utf-8")
    _git(home, "add", "-A")
    _git(home, "commit", "-q", "-m", "first")
    _git(home, "remote", "add", "origin", str(remote))
    return home, remote, tmp_path / "rt"


def _run_hook(home: Path, rt: Path, modules: str | None):
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "BOT_"))}
    env.update({"BOT_HOME": str(home), "BOT_NAME": "pushbot", "BOTCORP_HOME": str(rt), "CLAUDE_PLUGIN_ROOT": str(ASSEMBLY / "harness")})
    if modules is not None:
        env["BOT_MODULES"] = modules
    t = time.monotonic()
    r = subprocess.run(["bash", str(HOOK)], input="{}", capture_output=True, text=True, env=env, timeout=60)
    return r, time.monotonic() - t


def _remote_head(remote: Path) -> str:
    r = subprocess.run(["git", "--git-dir", str(remote), "rev-parse", "-q", "--verify", "refs/heads/main"], capture_output=True, text=True, timeout=30)
    return r.stdout.strip()


def _wait_remote(remote: Path, want: str, secs: float = 40) -> bool:
    end = time.monotonic() + secs
    while time.monotonic() < end:
        if _remote_head(remote) == want:
            return True
        time.sleep(0.3)
    return False


def _push_log(rt: Path) -> list[str]:
    f = rt / "state" / "pushbot" / "push.log"
    return f.read_text(encoding="utf-8").splitlines() if f.exists() else []


@needs_bash
def test_a_clean_tree_with_an_unpushed_commit_is_pushed_with_the_backup_module(pushable):
    home, remote, rt = pushable
    r, _ = _run_hook(home, rt, "auto_commit,backup")
    assert r.returncode == 0, r.stderr
    assert _wait_remote(remote, _git(home, "rev-parse", "HEAD")), "the unpushed commit never reached origin"
    for _ in range(50):
        if _push_log(rt):
            break
        time.sleep(0.2)
    last = _push_log(rt)[-1]
    assert " push main ahead=1 rc=0" in last, last


@needs_bash
def test_a_dirty_tree_is_committed_then_pushed(pushable):
    home, remote, rt = pushable
    (home / "memory" / "b.md").write_text("two\n", encoding="utf-8")
    r, _ = _run_hook(home, rt, "auto_commit,backup")
    assert r.returncode == 0, r.stderr
    assert _git(home, "status", "--porcelain") == ""
    assert _git(home, "log", "-1", "--format=%s").startswith("chore(auto): session checkpoint")
    assert _wait_remote(remote, _git(home, "rev-parse", "HEAD"))


@needs_bash
@pytest.mark.parametrize("modules", ["auto_commit", "", None])
def test_no_backup_module_means_commit_only_never_push(pushable, modules):
    home, remote, rt = pushable
    (home / "memory" / "b.md").write_text("two\n", encoding="utf-8")
    r, _ = _run_hook(home, rt, modules)
    assert r.returncode == 0, r.stderr
    # still commits (BOT_MODULES '' = every module off, auto_commit too; unset = all on, but backup must be named)
    assert (_git(home, "status", "--porcelain") == "") == (modules != "")
    time.sleep(3)
    assert _remote_head(remote) == "" and _push_log(rt) == []


@needs_bash
def test_the_hook_returns_before_a_slow_push_ends(pushable):
    home, remote, rt = pushable
    hook = remote / "hooks" / "pre-receive"
    hook.write_text("#!/bin/sh\nsleep 8\nexit 0\n", encoding="utf-8")
    hook.chmod(0o755)
    r, took = _run_hook(home, rt, "auto_commit,backup")
    assert r.returncode == 0, r.stderr
    assert took < 5, f"the Stop hook waited {took:.1f}s for the push"
    assert _remote_head(remote) == ""                          # still in flight
    assert _wait_remote(remote, _git(home, "rev-parse", "HEAD"), secs=60)


@needs_bash
def test_a_failed_push_is_logged_and_retried_on_the_next_clean_stop(pushable, tmp_path):
    home, remote, rt = pushable
    _git(home, "remote", "set-url", "origin", str(tmp_path / "missing.git"))
    r, _ = _run_hook(home, rt, "auto_commit,backup")
    assert r.returncode == 0
    for _ in range(100):
        if _push_log(rt):
            break
        time.sleep(0.2)
    assert _push_log(rt) and "rc=0" not in _push_log(rt)[-1], _push_log(rt)
    _git(home, "remote", "set-url", "origin", str(remote))
    assert _git(home, "status", "--porcelain") == ""
    _run_hook(home, rt, "auto_commit,backup")
    assert _wait_remote(remote, _git(home, "rev-parse", "HEAD"))


@needs_bash
def test_never_pushes_a_repo_above_the_bot_folder(tmp_path):
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "-q", "--bare", str(remote)], check=True)
    outer = tmp_path / "checkout"
    subprocess.run(["git", "init", "-q", "-b", "main", str(outer)], check=True)
    for k, v in (("user.email", "test@example.invalid"), ("user.name", "Test")):
        _git(outer, "config", k, v)
    home = outer / "bots" / "pushbot"
    home.mkdir(parents=True)
    (outer / "README.md").write_text("x\n", encoding="utf-8")
    _git(outer, "add", "-A")
    _git(outer, "commit", "-q", "-m", "outer")
    _git(outer, "remote", "add", "origin", str(remote))
    r, _ = _run_hook(home, tmp_path / "rt", "auto_commit,backup")
    assert r.returncode == 0
    time.sleep(3)
    assert _remote_head(remote) == ""


@needs_node
def test_unpushed_verdict():
    day = 24 * 3600_000
    now = 1_800_000_000_000
    iso = lambda ms: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ms / 1000))  # noqa: E731
    R = "https://example.invalid/me/bot.git"
    base = f"{{remote: '{R}', hasGit: true, origin: '{R}', branch: 'main', now: {now}"
    got = _node("[" + ", ".join([
        "m.unpushedVerdict({remote: null})",
        f"m.unpushedVerdict({base}, ahead: 0}})",
        f"m.unpushedVerdict({base}, ahead: 2, oldest: '{iso(now - 3600_000)}', lastPush: 'x rc=128'}})",
        f"m.unpushedVerdict({base}, ahead: 2, oldest: '{iso(now - day - 60_000)}'}})",
        f"m.unpushedVerdict({{remote: '{R}', hasGit: false}})",
        f"m.unpushedVerdict({{remote: '{R}', hasGit: true, origin: ''}})",
        f"m.unpushedVerdict({{remote: '{R}', hasGit: true, origin: 'https://example.invalid/other.git', branch: 'main', ahead: 0}})",
        f"m.unpushedVerdict({{remote: '{R}', hasGit: true, origin: 'https://EXAMPLE.invalid/me/bot', branch: 'main', ahead: 0}})",
        f"m.unpushedVerdict({base}, ahead: 1, oldest: '{iso(now - 60_000)}', autoCommit: false}})",
    ]) + "]")
    off, zero, young, old, norepo, noorigin, other, same, manual = got
    assert off is None
    assert zero["level"] == "PASS"
    assert young["level"] == "WARN" and "2 commit(s) on main" in young["detail"] and "last push: x rc=128" in young["detail"]
    assert old["level"] == "FAIL" and "exist only on this machine" in old["detail"]
    assert norepo["level"] == "WARN" and "botcorp backup" in norepo["detail"]
    assert noorigin["level"] == "WARN" and "no origin" in noorigin["detail"]
    assert other["level"] == "WARN" and "not backup.git_remote" in other["detail"]
    assert same["level"] == "PASS"                                   # .git / case / trailing slash are the same remote
    assert manual["level"] == "WARN" and "only botcorp backup" in manual["detail"]


# --- B5: janitor report ---------------------------------------------------------------------------
def _cfg(tmp_path: Path, text: str) -> dict:
    f = tmp_path / "bot.yaml"
    f.write_text(text, encoding="utf-8")
    r = subprocess.run(["node", str(BOTYAML), str(f)], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


@needs_node
def test_janitor_values_validate_and_report_counts_as_enabled(tmp_path):
    def j(v):
        c = _cfg(tmp_path, f"name: b\nharness:\n  modules:\n    janitor: {v}\n")
        return "janitor" in c["_modules"], c["_errors"]
    assert j("true") == (True, [])
    assert j("report") == (True, [])
    assert j("false") == (False, [])
    for bad in ("yes", "Report", "clean", "1"):
        assert j(bad)[1], bad


@needs_pwsh
def test_get_janitor_mode_decides_on_the_type_first():
    body = ("$o = @(); foreach ($v in @($true, 'report', $false, 'Report', 'true', $null, 1)) { $o += (Get-JanitorMode $v) }; $o -join ','")
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", f". '{COMMON}'\n{body}"],
                       capture_output=True, text=True, timeout=120, cwd=str(ASSEMBLY))
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip().splitlines()[-1] == "clean,report,off,off,off,off,off"
    body = ("$c = Get-JanitorArgs -Script 'x.ps1' -Mode clean; $r = Get-JanitorArgs -Script 'x.ps1' -Mode report; "
            "\"$($c -contains '-Clean')|$($r -contains '-Clean')|$($r[-1])|$($r.Count)\"")
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", f". '{COMMON}'\n{body}"],
                       capture_output=True, text=True, timeout=120, cwd=str(ASSEMBLY))
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip().splitlines()[-1] == "True|False|x.ps1|6"


@pytest.fixture
def repo_bot(tmp_path):
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


@needs_pwsh
def test_a_real_tick_runs_a_report_janitor_without_clean(repo_bot, tmp_path):
    name, home, rt, env = repo_bot
    (home / "bot.yaml").write_text(f"name: {name}\nharness:\n  service: manual\n  modules:\n    telegram: false\n    janitor: report\n"
                                   "    usage_resume: false\n", encoding="utf-8")
    # an ALIVE bot (action none, where the janitor runs): a live process named claude.exe
    exe = tmp_path / "claude.exe"
    shutil.copy2(Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe", exe)
    fake = subprocess.Popen([str(exe), "/c", "ping -n 120 127.0.0.1 >nul"], creationflags=subprocess.CREATE_NO_WINDOW)
    node = tmp_path / "fake-node" / "node.exe"
    node.parent.mkdir()
    shutil.copy2(Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe", node)
    sink = subprocess.Popen([str(node), "/c", "ping -n 120 127.0.0.1 >nul"], creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        (rt / "state" / f"{name}.json").write_text(json.dumps({"bot": name, "claude_pid": fake.pid, "status": "running", "service": "bg", "bg_id": ""}), encoding="utf-8")
        (rt / "cockpit.json").write_text('{"enabled": false}', encoding="utf-8")
        (rt / "state" / "daemon.json").write_text(json.dumps({"update_check_at": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())}), encoding="utf-8")
        (rt / "state" / "otel.json").write_text(json.dumps({"pid": sink.pid}), encoding="utf-8")
        r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ASSEMBLY / "daemon" / "tick.ps1")],
                           capture_output=True, text=True, timeout=400, cwd=str(ASSEMBLY), env=env)
    finally:
        for p in (fake, sink):
            subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True)
    assert r.returncode == 0, r.stderr
    log = (rt / "daemon.log").read_text(encoding="utf-8")
    line = next((ln for ln in log.splitlines() if f"[{name}] janitor:" in ln), "")
    assert "janitor: report-only, nothing touched, exit=0 worst=" in line, log[-3000:]
    st = json.loads((rt / "state" / f"{name}.json").read_text(encoding="utf-8"))
    assert st.get("janitor_at")


# --- B1: one poller per token ---------------------------------------------------------------------
@needs_node
def test_foreign_owner_lock_and_slot_verdicts():
    got = _node("[" + ", ".join([
        "m.foreignTgLockVerdict([])",
        "m.foreignTgLockVerdict([{rel: 'host/.run/tg_owner.lock', pid: 4242, alive: true}])",
        "m.foreignTgLockVerdict([{rel: '.claude/.tg_owner.lock', pid: 4242, alive: false}])",
        "m.tgSlotVerdict({ownPoller: 'OWNED', codes: [409]})",
        "m.tgSlotVerdict({ownPoller: null, codes: [200, 200, 409]})",
        "m.tgSlotVerdict({ownPoller: 'DEAD', codes: [200, 200, 200, 200]})",
        "m.tgSlotVerdict({ownPoller: null, codes: [401]})",
        "m.tgSlotVerdict({ownPoller: null, codes: [0, 0]})",
        "m.tgSlotVerdict({ownPoller: null, skipped: 'no telegram_token in the vault'})",
    ]) + "]")
    none, live, stale, owned, busy, free, bad, net, skip = got
    assert none["level"] == "PASS"
    assert live["level"] == "FAIL" and "live pid 4242" in live["detail"]
    assert stale["level"] == "WARN" and "stale" in stale["detail"]
    assert owned["level"] == "INFO" and "not probed" in owned["detail"]
    assert busy["level"] == "FAIL" and "409 on 1 of 3" in busy["detail"] and "not running" in busy["detail"]
    assert free["level"] == "PASS" and "DEAD" in free["detail"]
    assert bad["level"] == "FAIL" and "rejected" in bad["detail"]
    assert net["level"] == "WARN"
    assert skip["level"] == "INFO"


class _Tg(http.server.BaseHTTPRequestHandler):
    codes: list = []
    paths: list = []

    def do_GET(self):  # noqa: N802
        type(self).paths.append(self.path)
        code = type(self).codes.pop(0) if type(self).codes else 200
        body = json.dumps({"ok": code == 200, "result": []}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


@needs_node
@pytest.mark.parametrize("codes,want", [([200, 409, 200], [200, 409]), ([200, 200, 200], [200, 200, 200])])
def test_slot_probe_stops_at_the_first_409_and_never_sends_an_offset(codes, want):
    _Tg.codes, _Tg.paths = list(codes), []
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Tg)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        base = f"http://127.0.0.1:{srv.server_address[1]}"
        got = _node(f"m.tgSlotProbe('not-a-real-value', {{base: '{base}', n: 3, gapMs: 50}})")
    finally:
        srv.shutdown()
    assert got == want
    assert all(p == "/botnot-a-real-value/getUpdates?timeout=0&limit=1" for p in _Tg.paths), _Tg.paths
