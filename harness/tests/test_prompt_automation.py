"""`kind: prompt` automations: a prompt typed into the bot's live session.

Locked behaviour:
- bot.yaml validation: `kind` defaults to command; `kind: prompt` needs
  `prompt:` and forbids `command:`; a command entry may not carry `prompt:`.
- a due prompt fire with the session down or busy is recorded as
  `skipped: <reason>` (runs.jsonl + automations.json last_result), advances
  to the next cron fire, and logs at most the prompt's first 60 chars.
- with the session up and idle, daemon/inject.mjs types the prompt through
  the pty-host (the cockpit chat's path) and the run is `sent` once the user
  entry reaches the transcript. A bg session gets a transient attach host that
  is stopped again; the session itself keeps running.

The session is a stub hosted by the real pty-host (BOTCORP_PTY_COMMAND): it
writes each line typed into it to a fake transcript as a user entry.
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
BOTYAML = ASSEMBLY / "daemon" / "botyaml.mjs"
PTY_HOST = ASSEMBLY / "daemon" / "pty-host.mjs"
AUTOMATIONS = ASSEMBLY / "daemon" / "automations.ps1"

needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node on PATH")
needs_win = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None or shutil.which("node") is None,
                               reason="Windows with pwsh and node on PATH")

# Longer than the 60-char log preview; the tail must never reach a log.
PROMPT = "Read the answers on the board, act on each, then re-sync the list. TAIL-MARKER-NEVER-LOGGED"

STUB = r"""
const fs = require('fs');
const out = process.argv[2];
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write('stub session> ');
let buf = '';
process.stdin.on('data', (b) => {
  buf += b.toString('utf8');
  let i;
  while ((i = buf.indexOf('\r')) >= 0) {
    const text = buf.slice(0, i).replace(/\x1b\[20[01]~/g, '');
    buf = buf.slice(i + 1);
    // A typed `/name args` is recorded the way Claude Code records a plugin
    // skill: namespaced, in a <command-name> wrapper (reference host 2026-09-26).
    const m = /^\/([\w.-]+)\s*([\s\S]*)$/.exec(text);
    const content = m ? `<command-message>botcorp:${m[1]}</command-message>\n<command-name>/botcorp:${m[1]}</command-name>\n<command-args>${m[2]}</command-args>` : text;
    fs.appendFileSync(out, JSON.stringify({ type: 'user', message: { role: 'user', content }, timestamp: new Date().toISOString() }) + '\n');
    process.stdout.write('\r\nok\r\nstub session> ');
  }
});
setTimeout(() => process.exit(0), 120000);
"""


def _yaml(name: str, session: str, automation: str) -> str:
    return (f"name: {name}\nharness:\n  service: manual\n  session: {session}\n  modules:\n    telegram: false\n"
            f"automations:\n{automation}")


def _prompt_entry(prompt: str = PROMPT) -> str:
    return ("  - name: standup\n    kind: prompt\n    prompt: " + json.dumps(prompt) + "\n"
            "    trigger: {cron: \"37 8 * * 1-5\"}\n    timeout_min: 0.5\n")


# ---- validation ------------------------------------------------------------------------------
@needs_node
@pytest.mark.parametrize("entry, ok, err", [
    ("  - name: a\n    trigger: {interval_min: 5}\n    command: \"echo hi\"\n", True, None),
    ("  - name: a\n    kind: command\n    trigger: {interval_min: 5}\n    command: \"echo hi\"\n", True, None),
    ("  - name: a\n    kind: prompt\n    prompt: \"/standup\"\n    trigger: {cron: \"0 9 * * 1-5\"}\n", True, None),
    ("  - name: a\n    kind: prompt\n    prompt: \"hi\"\n    command: \"echo hi\"\n    trigger: {interval_min: 5}\n", False, "command: not allowed with kind: prompt"),
    ("  - name: a\n    kind: prompt\n    trigger: {interval_min: 5}\n", False, "prompt: required for kind: prompt"),
    ("  - name: a\n    kind: prompt\n    prompt: \"  \"\n    trigger: {interval_min: 5}\n", False, "prompt: required for kind: prompt"),
    ("  - name: a\n    trigger: {interval_min: 5}\n    command: \"echo hi\"\n    prompt: \"hi\"\n", False, "prompt: only with kind: prompt"),
    ("  - name: a\n    kind: shell\n    trigger: {interval_min: 5}\n    command: \"echo hi\"\n", False, "kind: command | prompt"),
])
def test_validation(tmp_path, entry, ok, err):
    f = tmp_path / "bot.yaml"
    f.write_text(f"name: zz-v\nautomations:\n{entry}", encoding="utf-8")
    r = subprocess.run(["node", str(BOTYAML), str(f), "--validate"], capture_output=True, text=True, timeout=60)
    assert (r.returncode == 0) == ok, r.stdout + r.stderr
    if err:
        assert err in r.stderr, r.stderr


# ---- scheduler + delivery --------------------------------------------------------------------
@pytest.fixture
def bot(tmp_path):
    name = f"zz-p{secrets.token_hex(3)}"
    home = ASSEMBLY / "bots" / name
    home.mkdir(parents=True)
    rt = tmp_path / "rt"
    (rt / "state").mkdir(parents=True)
    slug = re.sub(r"[^A-Za-z0-9]", "-", str(home))
    transcript = home / f".claude-{name}" / "projects" / slug / "stub-session.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text(json.dumps({"type": "user", "message": {"role": "user", "content": "earlier turn"}}) + "\n", encoding="utf-8")
    stub = tmp_path / "stub.js"
    stub.write_text(STUB, encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "TELEGRAM_", "BOT_"))}
    env["BOTCORP_HOME"] = str(rt)
    env["BOTCORP_PTY_COMMAND"] = f'node "{stub}" "{transcript}"'
    hosts: list[subprocess.Popen] = []
    try:
        yield {"name": name, "home": home, "rt": rt, "env": env, "transcript": transcript, "hosts": hosts, "tmp": tmp_path}
    finally:
        subprocess.run(["node", str(PTY_HOST), "--stop", name], capture_output=True, timeout=60, env=env)
        for h in hosts:
            if h.poll() is None:
                h.kill()
        shutil.rmtree(home, ignore_errors=True)


def _set_idle(transcript: Path, idle: bool):
    t = time.time() - (600 if idle else 0)
    os.utime(transcript, (t, t))


def _start_pty_host(b) -> dict:
    h = subprocess.Popen(["node", str(PTY_HOST), "--bot", b["name"], "--botcorp", str(ASSEMBLY), "--continue"],
                         env=b["env"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    b["hosts"].append(h)
    rec_file = b["rt"] / "state" / f"{b['name']}.pty.json"
    for _ in range(100):
        if rec_file.exists():
            return json.loads(rec_file.read_text(encoding="utf-8"))
        time.sleep(0.1)
    raise AssertionError("pty-host did not publish its endpoint")


def _run_now(b):
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(AUTOMATIONS),
                        "-Bot", b["name"], "-RunNow", "standup"], capture_output=True, text=True, timeout=300,
                       cwd=str(ASSEMBLY), env=b["env"])
    assert r.returncode == 0, r.stderr + r.stdout
    runs = [json.loads(ln) for ln in (b["rt"] / "state" / b["name"] / "runs.jsonl").read_text(encoding="utf-8-sig").splitlines() if ln.strip()]
    state = json.loads((b["rt"] / "state" / b["name"] / "automations.json").read_text(encoding="utf-8-sig"))["standup"]
    logs = "\n".join(p.read_text(encoding="utf-8", errors="replace") for p in b["rt"].rglob("*.log"))
    return runs, state, logs


def _typed(b) -> list[str]:
    lines = b["transcript"].read_text(encoding="utf-8").splitlines()
    return [json.loads(ln)["message"]["content"] for ln in lines[1:]]


@needs_win
def test_skip_when_down(bot):
    (bot["home"] / "bot.yaml").write_text(_yaml(bot["name"], "pty", _prompt_entry()), encoding="utf-8")
    _set_idle(bot["transcript"], True)
    runs, state, logs = _run_now(bot)
    assert runs[-1]["result"] == "skipped: session down", runs
    assert runs[-1]["exit"] is None and runs[-1]["log"] is None
    assert state["last_result"] == "skipped: session down"
    assert state.get("next_due"), state          # the next cron fire is the next chance
    assert not state.get("running_run_id")
    assert "skip standup: session down" in logs, logs
    assert PROMPT[:60] in logs and "TAIL-MARKER-NEVER-LOGGED" not in logs, logs
    assert _typed(bot) == []


@needs_win
def test_skip_when_busy(bot):
    (bot["home"] / "bot.yaml").write_text(_yaml(bot["name"], "pty", _prompt_entry()), encoding="utf-8")
    _start_pty_host(bot)
    _set_idle(bot["transcript"], False)          # written just now: a turn is in flight
    runs, state, logs = _run_now(bot)
    assert runs[-1]["result"] == "skipped: session busy", runs
    assert state["last_result"] == "skipped: session busy"
    assert state.get("next_due"), state
    time.sleep(1)
    assert _typed(bot) == [], "a busy session must not be typed into"


@needs_win
def test_sent_through_the_running_pty_host(bot):
    (bot["home"] / "bot.yaml").write_text(_yaml(bot["name"], "pty", _prompt_entry()), encoding="utf-8")
    rec = _start_pty_host(bot)
    _set_idle(bot["transcript"], True)
    runs, state, logs = _run_now(bot)
    assert runs[-1]["result"] == "sent", (runs, logs)
    assert runs[-1]["exit"] == 0
    assert state["last_result"] == "sent" and state.get("next_due")
    assert _typed(bot) == [PROMPT]
    assert "TAIL-MARKER-NEVER-LOGGED" not in logs
    # the pre-existing host is left running
    cur = json.loads((bot["rt"] / "state" / f"{bot['name']}.pty.json").read_text(encoding="utf-8"))
    assert cur["pid"] == rec["pid"]


@pytest.fixture(scope="module")
def fake_claude_exe(tmp_path_factory):
    # A process NAMED claude (a copy of node) is what the up-check sees for a bg session.
    exe = tmp_path_factory.mktemp("fakeclaude") / "claude.exe"
    shutil.copyfile(shutil.which("node"), exe)
    return exe


@needs_win
def test_sent_to_a_bg_session_through_a_transient_attach_host(bot, fake_claude_exe):
    (bot["home"] / "bot.yaml").write_text(_yaml(bot["name"], "bg", _prompt_entry("/standup")), encoding="utf-8")
    session = subprocess.Popen([str(fake_claude_exe), "-e", "setTimeout(() => {}, 120000)"])
    bot["hosts"].append(session)
    (bot["rt"] / "state" / f"{bot['name']}.json").write_text(json.dumps({"bot": bot["name"], "status": "running", "claude_pid": session.pid, "bg_id": "abc123"}), encoding="utf-8")
    _set_idle(bot["transcript"], True)
    runs, state, logs = _run_now(bot)
    assert runs[-1]["result"] == "sent", (runs, logs)
    assert "transient attach host" in runs[-1]["summary"]
    # recorded namespaced (/botcorp:standup), yet confirmed as the typed /standup
    assert _typed(bot) == ["<command-message>botcorp:standup</command-message>\n<command-name>/botcorp:standup</command-name>\n<command-args></command-args>"]
    assert not (bot["rt"] / "state" / f"{bot['name']}.pty.json").exists(), "the transient attach host must be stopped"
    assert session.poll() is None, "stopping the attach host must not touch the session"
