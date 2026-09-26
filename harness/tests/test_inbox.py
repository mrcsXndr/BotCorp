"""The inbox (core/inbox.mjs) and `botcorp send`: the one way text reaches a session.

Locked behaviour:
- `botcorp send <bot> [text | stdin]` queues; one detached drainer per bot types
  each item in order, and only while observe says the phase is `idle` or the job
  record says the session awaits its next prompt (`awaiting_prompt`);
- a bg session gets an attach host (`pty-host --attach`) that the drainer starts
  and nobody stops: it exits on its own after BOTCORP_ATTACH_IDLE_MIN with no
  client, and the session keeps running; a pty session is typed into through its
  running pty-host;
- a delivery is `delivered` only once its user turn reaches the transcript. A
  typed `/standup` is recorded namespaced (`<command-name>/botcorp:standup`,
  reference host 2026-09-26) and still confirms (the v0.2.17 regression); a
  `/name` Claude Code does not know fails at once with that reason;
- a message is `held` while the session is hard-blocked (a login), then goes out
  once the block clears; `expired` once its ttl runs out while it waits;
  `failed` at once when the session is stopped;
- the daemon tick kicks a drainer for a queue nobody drains.

The session is a stub hosted by the real pty-host (BOTCORP_PTY_COMMAND). It
writes each line typed into it to a transcript in Claude Code's own user-entry
shape. Every run uses a temp BOTCORP_HOME / BOTCORP_BOTS_DIR.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
CLI = ASSEMBLY / "cli" / "botcorp.mjs"
PTY_HOST = ASSEMBLY / "daemon" / "pty-host.mjs"

pytestmark = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None or shutil.which("node") is None,
                                reason="Windows with pwsh and node on PATH")

# One typed line -> one user entry, with the fields Claude Code 2.1 writes
# (a typed prompt is a string `content`; a plugin skill is the wrapper below).
STUB = r"""
const fs = require('fs');
const crypto = require('crypto');
const [out, cwd] = process.argv.slice(2);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write('stub session> ');
let buf = '', parent = null;
const sessionId = crypto.randomUUID();
process.stdin.on('data', (b) => {
  buf += b.toString('utf8');
  let i;
  while ((i = buf.indexOf('\r')) >= 0) {
    const text = buf.slice(0, i).replace(/\x1b\[20[01]~/g, '');
    buf = buf.slice(i + 1);
    const m = /^\/([\w.-]+)\s*([\s\S]*)$/.exec(text);
    if (m && m[1] === 'nosuch') {   // what Claude Code writes for a /name it does not know
      for (const content of [`Unknown command: /${m[1]}`, `Args from unknown skill: ${m[2]}`]) {
        fs.appendFileSync(out, JSON.stringify({ parentUuid: parent, isSidechain: false, type: 'system', subtype: 'informational', content,
          isMeta: false, timestamp: new Date().toISOString(), uuid: crypto.randomUUID(), level: 'warning', sessionId }) + '\n');
      }
      process.stdout.write('\r\nstub session> ');
      continue;
    }
    const content = m ? `<command-message>botcorp:${m[1]}</command-message>\n<command-name>/botcorp:${m[1]}</command-name>\n<command-args>${m[2]}</command-args>` : text;
    const uuid = crypto.randomUUID();
    fs.appendFileSync(out, JSON.stringify({ parentUuid: parent, isSidechain: false, promptId: crypto.randomUUID(), type: 'user',
      message: { role: 'user', content }, uuid, timestamp: new Date().toISOString(), userType: 'external', entrypoint: 'cli',
      cwd, sessionId, version: '2.1.282', gitBranch: '' }) + '\n');
    parent = uuid;
    process.stdout.write('\r\nok\r\nstub session> ');
  }
});
setTimeout(() => process.exit(0), 180000);
"""
LOGIN_BLOCK = {"state": "blocked", "tempo": "blocked", "needs": "login required - run /login"}


@pytest.fixture(scope="module")
def fake_claude_exe(tmp_path_factory):
    # A process NAMED claude (a copy of node) stands in for a bg session's worker.
    exe = tmp_path_factory.mktemp("fakeclaude") / "claude.exe"
    shutil.copyfile(shutil.which("node"), exe)
    return exe


@pytest.fixture
def box(tmp_path):
    name = f"zz-i{secrets.token_hex(3)}"
    bots = tmp_path / "bots"
    home = bots / name
    home.mkdir(parents=True)
    rt = tmp_path / "rt"
    (rt / "state").mkdir(parents=True)
    slug = re.sub(r"[^A-Za-z0-9]", "-", str(home))
    transcript = home / f".claude-{name}" / "projects" / slug / "stub-session.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text("", encoding="utf-8")
    stub = tmp_path / "stub.js"
    stub.write_text(STUB, encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "TELEGRAM_", "BOT_"))}
    env.update({"BOTCORP_HOME": str(rt), "BOTCORP_BOTS_DIR": str(bots), "BOT_TG_MUTE": "1",
                "BOTCORP_PTY_COMMAND": f'node "{stub}" "{transcript}" "{home}"', "BOTCORP_INBOX_POLL_MS": "300"})
    procs: list[subprocess.Popen] = []
    b = {"name": name, "home": home, "rt": rt, "env": env, "transcript": transcript, "procs": procs}
    try:
        yield b
    finally:
        subprocess.run(["node", str(PTY_HOST), "--stop", name], capture_output=True, timeout=60, env=env)
        lock = rt / "state" / name / "inbox.drainer"
        if lock.exists():
            pid = lock.read_text(encoding="utf-8").strip()
            if pid.isdigit():
                subprocess.run(["taskkill", "/PID", pid, "/T", "/F"], capture_output=True)
        for p in procs:
            if p.poll() is None:
                p.kill()


def _yaml(b, session: str):
    (b["home"] / "bot.yaml").write_text(f"name: {b['name']}\nharness:\n  service: manual\n  session: {session}\n  modules:\n    telegram: false\n",
                                        encoding="utf-8")


def _idle(b):
    # a fresh declared breakpoint reads idle whatever the transcript did
    bp = b["home"] / ".claude" / ".botcorp_breakpoint"
    bp.parent.mkdir(exist_ok=True)
    bp.write_text("", encoding="utf-8")


def _bg_session(b, exe) -> subprocess.Popen:
    _yaml(b, "bg")
    s = subprocess.Popen([str(exe), "-e", "setTimeout(() => {}, 180000)"])
    b["procs"].append(s)
    (b["rt"] / "state" / f"{b['name']}.json").write_text(json.dumps({"bot": b["name"], "status": "running", "claude_pid": s.pid, "bg_id": "abc123"}),
                                                          encoding="utf-8")
    return s


def _job(b, rec):
    f = b["home"] / f".claude-{b['name']}" / "jobs" / "abc123" / "state.json"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(rec), encoding="utf-8")


def _cli(b, *args, stdin: str = "", timeout: int = 180):
    return subprocess.run(["node", str(CLI), *args], input=stdin, capture_output=True, text=True, timeout=timeout,
                          cwd=str(ASSEMBLY), env=b["env"])


def _typed(b) -> list[str]:
    return [json.loads(ln)["message"]["content"] for ln in b["transcript"].read_text(encoding="utf-8").splitlines() if ln.strip()]


def _items(b) -> list[dict]:
    r = _cli(b, "inbox", b["name"], "--json")
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def _wait_for(pred, timeout=90.0):
    end = time.time() + timeout
    while time.time() < end:
        v = pred()
        if v:
            return v
        time.sleep(0.3)
    raise AssertionError("timed out")


def _endpoint(b):
    f = b["rt"] / "state" / f"{b['name']}.pty.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else None


def test_delivered_to_a_bg_session_through_a_new_attach_host(box, fake_claude_exe):
    session = _bg_session(box, fake_claude_exe)
    _idle(box)
    nonce = f"inbox-{secrets.token_hex(6)}"
    r = _cli(box, "send", box["name"], "--wait", "--json", stdin=f"hello {nonce}\n")
    assert r.returncode == 0, r.stdout + r.stderr
    out = json.loads(r.stdout)
    assert out["status"] == "delivered" and "via a new attach host" in out["detail"] and "confirmed in the transcript" in out["detail"], out
    assert _typed(box) == [f"hello {nonce}"]
    assert box["transcript"].read_text(encoding="utf-8").count(nonce) == 1, "typed exactly once"
    assert _endpoint(box)["mode"] == "attach", "the attach host stays up for the next message"
    assert session.poll() is None
    # the namespaced skill shape confirms a typed /standup, through the running host
    r = _cli(box, "send", box["name"], "--wait", "--json", "/standup")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "via the running attach host" in json.loads(r.stdout)["detail"]
    assert _typed(box)[-1] == "<command-message>botcorp:standup</command-message>\n<command-name>/botcorp:standup</command-name>\n<command-args></command-args>"


def test_an_unknown_command_fails_at_once_with_the_reason(box, fake_claude_exe):
    # bare `/critic` (a plugin command) is "Unknown command" on a real host: say so, never wait out the confirm window
    _bg_session(box, fake_claude_exe)
    _idle(box)
    t0 = time.time()
    r = _cli(box, "send", box["name"], "--wait", "--json", "/nosuch bot.yaml")
    out = json.loads(r.stdout)
    assert r.returncode == 1 and out["status"] == "failed", out
    assert "Claude Code has no /nosuch" in out["detail"] and "/botcorp:<name>" in out["detail"], out
    assert time.time() - t0 < 25, "reported from the system line, not after the 30 s confirm window"
    # positive control: the same session confirms a command it knows
    r = _cli(box, "send", box["name"], "--wait", "--json", "/standup")
    assert r.returncode == 0 and json.loads(r.stdout)["status"] == "delivered", r.stdout


def test_delivered_through_a_running_pty_host(box):
    _yaml(box, "pty")
    h = subprocess.Popen(["node", str(PTY_HOST), "--bot", box["name"], "--botcorp", str(ASSEMBLY), "--continue"],
                         env=box["env"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    box["procs"].append(h)
    rec = _wait_for(lambda: _endpoint(box), 20)
    _idle(box)
    r = _cli(box, "send", box["name"], "--wait", "a line for the pty session")
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.startswith("delivered ") and "via the running pty-host (continue)" in r.stdout, r.stdout
    assert _typed(box) == ["a line for the pty session"]
    assert _endpoint(box)["pid"] == rec["pid"]


def test_in_order(box, fake_claude_exe):
    _bg_session(box, fake_claude_exe)
    _idle(box)
    ids = []
    for n in ("one", "two", "three"):
        r = _cli(box, "send", box["name"], f"message {n}")
        assert r.returncode == 0 and r.stdout.startswith("queued "), r.stdout + r.stderr
        ids.append(r.stdout.split()[1])
    _wait_for(lambda: all(i["status"] == "delivered" for i in _items(box)), 120)
    assert [i["id"] for i in _items(box)] == ids
    assert _typed(box) == ["message one", "message two", "message three"]


def test_held_while_blocked_then_delivered(box, fake_claude_exe):
    _bg_session(box, fake_claude_exe)
    _idle(box)
    _job(box, LOGIN_BLOCK)
    r = _cli(box, "send", box["name"], "after the login")
    assert r.returncode == 0, r.stderr
    item = _wait_for(lambda: next((i for i in _items(box) if i["status"] == "held"), None), 30)
    assert "login required" in item["detail"]
    time.sleep(1.5)
    assert _typed(box) == [], "a blocked session must not be typed into"
    assert item["preview"] == "after the login" and "text" not in item
    _job(box, {"state": "working", "tempo": "blocked", "needs": "send a prompt to start"})
    _wait_for(lambda: _items(box)[0]["status"] == "delivered", 60)
    assert _typed(box) == ["after the login"]
    results = [json.loads(ln) for ln in (box["rt"] / "state" / box["name"] / "inbox.results.jsonl").read_text(encoding="utf-8").splitlines()]
    assert [x["status"] for x in results] == ["held", "queued", "delivered"], results


def test_a_warn_block_does_not_hold(box, fake_claude_exe):
    # its last turn ended asking something: it still takes its next prompt
    _bg_session(box, fake_claude_exe)
    _idle(box)
    _job(box, {"state": "blocked", "tempo": "blocked", "needs": "which branch should I use?"})
    r = _cli(box, "send", box["name"], "--wait", "use main")
    assert r.returncode == 0, r.stdout + r.stderr
    assert _typed(box) == ["use main"]


# The job record's own shapes (test_bg_pin_boot_poller.py). The transcript was
# written just now and there is no breakpoint: the quiet rule reads `working`,
# and only `awaiting_prompt` lets the item go out before the ttl.
@pytest.mark.parametrize("job, activity, awaiting", [
    ({"state": "working", "tempo": "blocked", "needs": "send a prompt to start"}, "working", True),
    ({"tempo": "blocked", "needs": "confirm tg_send.py executed with 'back online after reboot'"}, "working", True),   # WARN
    ({"tempo": "active", "state": "working"}, "working", False),
    (LOGIN_BLOCK, "blocked", False),                                                                                   # FAIL
    # a turn ended: the record says done, idle, nothing in flight, as of just now
    ({"state": "done", "tempo": "idle", "inFlight": {"tasks": 0, "queued": 0}, "updatedAt": "NOW"}, "working", True),
    # ... but the transcript moved a minute after the record said so: a new turn is running
    ({"state": "done", "tempo": "idle", "inFlight": {"tasks": 0, "queued": 0}, "updatedAt": "OLD"}, "working", False),
    # ... or a background task still runs
    ({"state": "done", "tempo": "idle", "inFlight": {"tasks": 1, "queued": 0}, "updatedAt": "NOW"}, "working", False),
])
def test_a_session_awaiting_its_next_prompt_takes_it_at_once(box, fake_claude_exe, job, activity, awaiting):
    _bg_session(box, fake_claude_exe)
    stamp = {"NOW": time.time(), "OLD": time.time() - 60}
    if job.get("updatedAt") in stamp:
        job = {**job, "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(stamp[job["updatedAt"]]))}
    _job(box, job)
    os.utime(box["transcript"], None)
    o = json.loads(_cli(box, "observe", box["name"], "--json").stdout)
    assert (o["activity"], o["phase"], o["awaiting_prompt"]) == (activity, activity, awaiting), o
    r = _cli(box, "send", box["name"], "--wait", "--json", "--ttl", "10s", "right away")
    out = json.loads(r.stdout)
    if awaiting:
        assert r.returncode == 0 and out["status"] == "delivered", out
        assert _typed(box) == ["right away"]
    else:
        assert r.returncode == 1 and out["status"] == "expired", out
        assert _typed(box) == [] and _endpoint(box) is None


def test_expires_while_the_session_is_working(box, fake_claude_exe):
    _bg_session(box, fake_claude_exe)
    os.utime(box["transcript"], None)            # written just now, no breakpoint: a turn is in flight
    r = _cli(box, "send", box["name"], "--wait", "--ttl", "2s", "not now")
    assert r.returncode == 1, r.stdout + r.stderr
    assert r.stdout.startswith("expired ") and "waited past its ttl (2s)" in r.stdout, r.stdout
    assert _typed(box) == [] and _endpoint(box) is None


def test_expires_while_the_session_is_down(box):
    _yaml(box, "bg")
    p = subprocess.Popen([sys.executable, "-c", ""])
    p.wait()
    (box["rt"] / "state" / f"{box['name']}.json").write_text(json.dumps({"bot": box["name"], "status": "running", "claude_pid": p.pid, "bg_id": "abc123"}),
                                                            encoding="utf-8")
    r = _cli(box, "send", box["name"], "--wait", "--ttl", "2s", "while down")
    assert r.returncode == 1 and r.stdout.startswith("expired "), r.stdout + r.stderr


def test_fails_at_once_when_stopped(box):
    _yaml(box, "bg")                              # no state file: never started
    t0 = time.time()
    r = _cli(box, "send", box["name"], "--wait", "--json", "anyone there")
    assert r.returncode == 1, r.stdout + r.stderr
    out = json.loads(r.stdout)
    assert out["status"] == "failed" and f"botcorp start {box['name']}" in out["detail"], out
    assert time.time() - t0 < 30


def test_the_attach_host_exits_on_its_own_and_the_session_survives(box, fake_claude_exe):
    box["env"]["BOTCORP_ATTACH_IDLE_MIN"] = "0.05"          # 3 s
    session = _bg_session(box, fake_claude_exe)
    _idle(box)
    r = _cli(box, "send", box["name"], "--wait", "then go quiet")
    assert r.returncode == 0, r.stdout + r.stderr
    _wait_for(lambda: _endpoint(box) is None, 30)
    assert session.poll() is None, "the attach host exiting must not touch the session"


@pytest.mark.parametrize("args, stdin, err", [
    ([], "", "send <bot>"),
    ([], "  \n", "send <bot>"),
    (["--ttl", "soon", "hi"], "", "--ttl"),
    (["--ttl", "25h", "hi"], "", "--ttl"),
    (["--source", "tg", "hi"], "", "--source"),
])
def test_send_refuses_bad_input(box, args, stdin, err):
    _yaml(box, "bg")
    r = _cli(box, "send", box["name"], *args, stdin=stdin)
    assert r.returncode == 2 and err in r.stderr, r.stdout + r.stderr
    assert not (box["rt"] / "state" / box["name"] / "inbox.jsonl").exists()


def test_a_captured_send_returns_while_its_drainer_waits(box):
    # A script that captures `botcorp send`'s output, itself read through a
    # pipe: the drainer outlives send (down session, 60 s ttl) and must not hold
    # that pipe. node spawn passes every inheritable handle on, so a drainer
    # spawned that way kept it until the ttl ran out.
    _yaml(box, "bg")
    p = subprocess.Popen([sys.executable, "-c", ""])
    p.wait()
    (box["rt"] / "state" / f"{box['name']}.json").write_text(json.dumps({"bot": box["name"], "status": "running", "claude_pid": p.pid, "bg_id": "abc123"}),
                                                            encoding="utf-8")
    script = f"$r = 'hello' | node '{CLI}' send {box['name']} --ttl 60s; $r"
    t0 = time.time()
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-Command", script], capture_output=True, text=True, timeout=120,
                       cwd=str(ASSEMBLY), env=box["env"])
    took = time.time() - t0
    assert r.returncode == 0 and r.stdout.startswith("queued "), r.stdout + r.stderr
    assert took < 10, f"send's caller waited {took:.1f}s for the drainer"
    assert _cli(box, "inbox", box["name"], "kick").stdout.strip().endswith("runs)"), "the drainer is still waiting"


def test_both_files_are_bounded_and_keep_every_status(box):
    # 650 finished items (each a held line then an expired one) behind 3 that
    # still wait: one more send trims inbox.jsonl to the newest 500 plus the 3,
    # and the drainer's next result cuts inbox.results.jsonl to one line per kept item.
    _yaml(box, "bg")                              # no state file: stopped, so the drainer fails what waits
    d = box["rt"] / "state" / box["name"]
    d.mkdir()
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    waiting = [{"id": f"wait-{n}", "text": "still waiting", "source": "cli", "ttl_s": 86400, "at": now} for n in range(3)]
    done = [{"id": f"done-{n}", "text": f"old {n}", "source": "cli", "ttl_s": 60, "at": "2026-09-01T00:00:00Z"} for n in range(650)]
    (d / "inbox.jsonl").write_text("".join(json.dumps(i) + "\n" for i in waiting + done), encoding="utf-8")
    (d / "inbox.results.jsonl").write_text("".join(json.dumps({"id": i["id"], "status": s, "at": now, "detail": ""}) + "\n"
                                                   for i in done for s in ("held", "expired")), encoding="utf-8")
    r = _cli(box, "send", box["name"], "--wait", "--json", "one more")
    assert r.returncode == 1 and json.loads(r.stdout)["status"] == "failed", r.stdout + r.stderr
    kept = [json.loads(ln)["id"] for ln in (d / "inbox.jsonl").read_text(encoding="utf-8").splitlines()]
    new_id = json.loads(r.stdout)["id"]
    assert kept == [i["id"] for i in waiting] + [f"done-{n}" for n in range(151, 650)] + [new_id], (len(kept), kept[:5])
    items = json.loads(_cli(box, "inbox", box["name"], "--json", "--tail", "1000").stdout)
    assert {i["id"]: i["status"] for i in items} == {**{i["id"]: "failed" for i in waiting}, **{f"done-{n}": "expired" for n in range(151, 650)}, new_id: "failed"}
    results = [json.loads(ln) for ln in (d / "inbox.results.jsonl").read_text(encoding="utf-8").splitlines()]
    assert len(results) == len(items) == 503, len(results)
    assert not list(d.glob("*.tmp")) and not (d / "inbox.lock").exists()


def _free_port() -> int:
    import socket
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_the_cockpit_send_route(box):
    # stopped (no state file): the message is queued, then fails at once
    import urllib.error
    import urllib.request
    _yaml(box, "bg")
    xss = '<img src=x onerror=alert(1)> [x](javascript:alert(1)) </code>'
    port = _free_port()
    srv = subprocess.Popen(["node", str(ASSEMBLY / "cockpit" / "server.mjs"), "--port", str(port)], cwd=str(ASSEMBLY), env=box["env"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
    box["procs"].append(srv)
    base = f"http://127.0.0.1:{port}"
    deadline = time.time() + 60
    while True:
        try:
            urllib.request.urlopen(base + "/healthz", timeout=5).read()
            break
        except OSError:
            assert time.time() < deadline and srv.poll() is None, "cockpit did not come up"
            time.sleep(0.5)
    cookie = urllib.request.urlopen(base + "/", timeout=30).headers["Set-Cookie"].split(";")[0]

    def call(method, path, body=None):
        req = urllib.request.Request(base + path, method=method, headers={"Cookie": cookie, "Content-Type": "application/json"},
                                     data=json.dumps(body).encode() if body is not None else None)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    code, item = call("POST", f"/api/bots/{box['name']}/send", {"text": xss})
    assert code == 200 and item["status"] == "queued" and item["id"], item
    assert call("POST", f"/api/bots/{box['name']}/send", {"text": "  "})[0] == 400
    assert call("POST", f"/api/bots/{box['name']}/send", {})[0] == 400
    assert call("POST", "/api/bots/no-such-bot/send", {"text": "hi"})[0] == 404
    rows = _wait_for(lambda: (lambda r: r if r and r[-1]["status"] == "failed" else None)(call("GET", f"/api/bots/{box['name']}/inbox")[1]), 30)
    assert rows[-1]["id"] == item["id"] and "session stopped" in rows[-1]["detail"]
    assert "text" not in rows[-1] and rows[-1]["source"] == "cockpit"
    stored = json.loads((box["rt"] / "state" / box["name"] / "inbox.jsonl").read_text(encoding="utf-8").splitlines()[0])
    assert stored["text"] == xss, "queued exactly as typed"
    audit = [json.loads(ln) for ln in (box["rt"] / "state" / "cockpit-audit.jsonl").read_text(encoding="utf-8").splitlines()]
    sends = [a for a in audit if a["path"].endswith("/send")]
    assert len(sends) == 4 and sends[0]["inbox_id"] == item["id"] and sends[0]["result"] == 200 and sends[0]["bot"] == box["name"], sends
    assert "onerror" not in json.dumps(audit), "the audit never carries the text"


def test_the_tick_kicks_a_queue_nobody_drains(box, tmp_path):
    _yaml(box, "bg")
    p = subprocess.Popen([sys.executable, "-c", ""])
    p.wait()
    rt = box["rt"]
    (rt / "state" / f"{box['name']}.json").write_text(json.dumps({"bot": box["name"], "status": "running", "claude_pid": p.pid, "bg_id": ""}), encoding="utf-8")
    # queued long ago with a 1 s ttl, and no drainer: the kicked drainer expires it
    (rt / "state" / box["name"]).mkdir()
    (rt / "state" / box["name"] / "inbox.jsonl").write_text(json.dumps({"id": "old-1", "text": "stale", "source": "cli", "ttl_s": 1, "at": "2026-09-01T00:00:00Z"}) + "\n",
                                                            encoding="utf-8")
    (rt / "cockpit.json").write_text('{"enabled": false}', encoding="utf-8")
    (rt / "state" / "daemon.json").write_text(json.dumps({"update_check_at": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())}), encoding="utf-8")
    env = dict(box["env"], BOTCORP_ROOT=str(ASSEMBLY), BOTCORP_DAEMON_MUTEX=f"Global\\BotCorpDaemon-test-{secrets.token_hex(8)}")
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
    assert re.search(rf"\[{box['name']}\].*inbox: drainer started \(pid \d+\)", log), log[-2000:]
    item = _wait_for(lambda: next((i for i in _items(box) if i["status"] == "expired"), None), 30)
    assert item["id"] == "old-1"
