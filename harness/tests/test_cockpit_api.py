"""R5a step 11: the cockpit API for approvals, attention, usage, automations, tools.

A real cockpit (node cockpit/server.mjs) on a free loopback port, over fixture
bots and a temp BOTCORP_HOME / BOTCORP_BOTS_DIR (never the real runtime):
- the GET routes return their shapes (attention items, usage groups, pending +
  recent approvals, a tools scan);
- approve: refused (403) without the per-boot approval token the server prints,
  then 200 with it; the queue entry is applied, the history names the
  identity, and the audit log has the line;
- automations run queues a run-now; resume (widening) needs the token too.
- (R5c) switch account: POST /api/bots/<bot>/account needs the token, runs
  `accounts use` (bot.yaml account:, audited), and /api/usage marks the switch
  pending; the attention item fires only for an attempted switch that did not land.
"""
from __future__ import annotations

import json
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import pytest

from test_operator_only import ASSEMBLY, cli, make_bot, needs_node, operator_env, queue

SERVER = ASSEMBLY / "cockpit" / "server.mjs"

T_YAML = (
    "name: t\nharness:\n  service: manual\n"
    "automations:\n"
    "  - name: job\n    command: echo hi\n    trigger: { interval_min: 60 }\n"
    "  - name: off\n    command: echo hi\n    trigger: { interval_min: 60 }\n    enabled: false\n"
    "tools: []\n"
)
ENTRY = {"id": "abc123", "ts": "2026-09-27T00:00:00Z", "path": "harness.modules.debrief", "value": True,
         "requested_by": "bot:u", "reason": "enables the debrief"}


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Cockpit:
    def __init__(self, env: dict):
        self.port = _free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        self.lines: list[str] = []
        self.proc = subprocess.Popen(["node", str(SERVER), "--port", str(self.port)], cwd=str(ASSEMBLY), env=env,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8")
        threading.Thread(target=lambda: [self.lines.append(l) for l in self.proc.stdout], daemon=True).start()
        deadline = time.time() + 30
        while time.time() < deadline and not any("approval token" in l for l in self.lines):
            time.sleep(0.1)
        tok = [l for l in self.lines if "approval token" in l]
        assert tok, "".join(self.lines)
        self.token = tok[0].strip().rsplit(" ", 1)[1]
        with urllib.request.urlopen(self.base + "/") as r:
            self.cookie = r.headers["Set-Cookie"].split(";")[0]

    def call(self, method: str, path: str, body=None, token: bool = False):
        headers = {"Cookie": self.cookie}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        if token:
            headers["X-Approve-Token"] = self.token
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"null")

    def close(self):
        self.proc.kill()
        self.proc.wait(timeout=10)


@pytest.fixture
def cockpit(tmp_path):
    rt, bots = tmp_path / "rt", tmp_path / "bots"
    (rt / "state").mkdir(parents=True)
    t = make_bot(bots, "t", T_YAML)
    (t / "tools").mkdir()
    (t / "tools" / "stray.py").write_text("print('x')\n", encoding="utf-8")
    make_bot(bots, "u")
    queue(rt, "u", [ENTRY])
    (rt / "state" / "t").mkdir(parents=True)
    (rt / "state" / "t" / "automations.json").write_text(json.dumps({"job": {"failure_streak": 3, "last_exit": 1}}), encoding="utf-8")
    c = Cockpit(operator_env(rt, bots))
    try:
        yield c, rt, bots
    finally:
        c.close()


def _audit(rt: Path, want: int) -> list[dict]:
    f = rt / "state" / "cockpit-audit.jsonl"
    for _ in range(60):
        rows = [json.loads(l) for l in f.read_text(encoding="utf-8").splitlines() if l.strip()] if f.exists() else []
        if len(rows) >= want:
            return rows
        time.sleep(0.05)
    return rows


@needs_node
def test_get_routes_return_their_shapes(cockpit):
    c, rt, bots = cockpit
    code, att = c.call("GET", "/api/attention")
    assert code == 200 and att["count"] == len(att["items"]), att
    kinds = {(i["bot"], i["kind"]) for i in att["items"]}
    assert ("u", "approval") in kinds and ("t", "automation_failing") in kinds and ("t", "registry") in kinds, kinds
    appr = next(i for i in att["items"] if i["kind"] == "approval")
    assert appr["action"] == {"type": "approve", "bot": "u", "id": "abc123"} and appr["text"] == "u asks: Enables the debrief", appr
    assert all(set(i) == {"bot", "kind", "severity", "text", "action"} for i in att["items"])

    code, usage = c.call("GET", "/api/usage")
    assert code == 200 and sorted(r["bot"] for r in usage["bots"]) == ["t", "u"], usage
    assert all("fiveHour" in r and "sevenDay" in r and "account" in r for r in usage["bots"])
    assert sorted(b for g in usage["accounts"] for b in g["bots"]) == ["t", "u"], usage["accounts"]

    code, ap = c.call("GET", "/api/approvals")
    assert code == 200 and [p["id"] for p in ap["pending"]] == ["abc123"] and ap["recent"] == [], ap
    assert ap["pending"][0]["diff"] == "harness.modules.debrief: false -> true"

    code, scan = c.call("GET", "/api/bots/t/tools")
    assert code == 200 and scan["registry"] == "warn" and scan["unregistered"] == ["tools/stray.py"], scan

    code, autos = c.call("GET", "/api/bots/t/automations")
    assert code == 200 and autos["state"]["job"]["failure_streak"] == 3 and [a["name"] for a in autos["declared"]] == ["job", "off"]


@needs_node
def test_approve_needs_the_token_then_applies_and_audits(cockpit):
    c, rt, bots = cockpit
    code, body = c.call("POST", "/api/bots/u/approvals/abc123/approve")
    assert code == 403 and body["need"] == "approve-token", body
    assert json.loads((rt / "state" / "u.approvals.json").read_text(encoding="utf-8"))[0]["id"] == "abc123"

    code, body = c.call("POST", "/api/bots/u/approvals/abc123/approve", token=True)
    assert code == 200 and body["ok"], body
    assert json.loads((rt / "state" / "u.approvals.json").read_text(encoding="utf-8")) == []
    assert "debrief: true" in (bots / "u" / "bot.yaml").read_text(encoding="utf-8")
    hist = json.loads((rt / "state" / "u.approvals.history.jsonl").read_text(encoding="utf-8").splitlines()[-1])
    assert hist["approved_by"] == "local"

    rows = _audit(rt, 2)
    assert [r["result"] for r in rows] == [403, 200], rows
    ok = rows[1]
    assert ok["identity"] == "local" and ok["bot"] == "u" and ok["approval"] == "abc123" and ok["decision"] == "approve", ok

    code, ap = c.call("GET", "/api/approvals")
    assert ap["pending"] == [] and ap["recent"][0]["decision"] == "approved" and ap["recent"][0]["by"] == "local", ap


@needs_node
def test_automation_run_queues_and_resume_needs_the_token(cockpit):
    c, rt, bots = cockpit
    # v0.9.3: every write needs the operator, a run too
    code, body = c.call("POST", "/api/bots/t/automations/job/run")
    assert code == 403 and body["need"] == "approve-token", body
    code, body = c.call("POST", "/api/bots/t/automations/job/run", token=True)
    assert code == 200 and body["ok"], body
    q = (rt / "state" / "t" / "events" / "run-now.queue").read_text(encoding="utf-8").splitlines()
    assert json.loads(q[-1])["automation"] == "job"

    code, body = c.call("POST", "/api/bots/t/automations/off/resume")
    assert code == 403, body
    code, body = c.call("POST", "/api/bots/t/automations/off/resume", token=True)
    assert code == 200 and body["ok"], body
    assert "enabled: false" not in (bots / "t" / "bot.yaml").read_text(encoding="utf-8")

    assert c.call("POST", "/api/bots/t/automations/nope/run", token=True)[0] == 404
    assert c.call("POST", "/api/bots/t/automations/job/explode", token=True)[0] == 400
    rows = _audit(rt, 6)
    assert rows[0]["result"] == 403, rows
    assert rows[1]["automation"] == "job" and rows[1]["action"] == "run" and rows[1]["result"] == 200, rows


# --- R5c step 19: switch account ----------------------------------------------------------------
needs_win_node = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None or shutil.which("node") is None,
                                    reason="Windows only (DPAPI account vault) with pwsh and node on PATH")


@pytest.fixture
def acockpit(tmp_path):
    """Bots t and u, two registered accounts (fake tokens) whose token checks are cached ok."""
    rt, bots = tmp_path / "rt", tmp_path / "bots"
    (rt / "state").mkdir(parents=True)
    make_bot(bots, "t")
    make_bot(bots, "u")
    stand_in = tmp_path / "claude.exe"   # never a real Claude Code: a cache miss runs this, which cannot start
    stand_in.write_bytes(b"not a program")
    env = {**operator_env(rt, bots), "BOTCORP_CLAUDE_EXE": str(stand_in)}
    for acc, last4 in (("acc1", "A1b2"), ("acc2", "C3d4")):
        r = subprocess.run(["node", str(ASSEMBLY / "cli" / "botcorp.mjs"), "accounts", "add", acc], input=f"value-for-tests-{acc}-{last4}\n",
                           capture_output=True, text=True, timeout=120, cwd=str(ASSEMBLY), env=env)
        assert r.returncode == 0, r.stdout + r.stderr
    rows = json.loads(cli(env, "accounts", "list", "--json").stdout)
    now = datetime.now(timezone.utc).isoformat()
    (rt / "state" / "account-checks.json").write_text(json.dumps({a["fp"]: {"ok": True, "at": now, "detail": "haiku replied"} for a in rows}), encoding="utf-8")
    c = Cockpit(env)
    try:
        yield c, rt, bots
    finally:
        c.close()


@needs_win_node
def test_account_switch_needs_the_token_then_writes_and_audits(acockpit):
    c, rt, bots = acockpit
    yml = bots / "t" / "bot.yaml"
    before = yml.read_bytes()
    code, body = c.call("POST", "/api/bots/t/account", {"id": "acc1"})
    assert code == 403 and body["need"] == "approve-token", body
    assert yml.read_bytes() == before
    assert c.call("POST", "/api/bots/t/account", {"id": "Bad!"}, token=True)[0] == 400
    assert yml.read_bytes() == before

    code, body = c.call("POST", "/api/bots/t/account", {"id": "acc1"}, token=True)
    assert code == 200 and body["ok"], body
    assert "account: acc1" in yml.read_text(encoding="utf-8")
    rows = [r for r in _audit(rt, 3) if r["path"].endswith("/account")]
    assert [r["result"] for r in rows] == [403, 400, 200], rows
    assert rows[2]["identity"] == "local" and rows[2]["bot"] == "t" and rows[2]["account"] == "acc1", rows[2]
    log = json.loads((rt / "logs" / "t" / "accounts.log").read_text(encoding="utf-8").splitlines()[-1])
    assert log["by"] == "local" and log["to"] == "acc1"

    code, usage = c.call("GET", "/api/usage")
    by = {r["bot"]: r for r in usage["bots"]}
    assert by["t"]["account_wanted"] == "acc1" and by["t"]["account_pending"] is True, by["t"]
    assert by["u"]["account_wanted"] is None and by["u"]["account_pending"] is False, by["u"]
    assert sorted(g["id"] for g in usage["accounts"] if g["registered"]) == ["acc1", "acc2"], usage["accounts"]

    code, body = c.call("POST", "/api/bots/t/account", {"id": "none"}, token=True)
    assert code == 200 and body["ok"], body
    assert "account:" not in yml.read_text(encoding="utf-8")


ATTENTION = (ASSEMBLY / "cockpit" / "attention.mjs").as_uri()


@needs_node
def test_approval_attention_reads_as_the_cards_title_not_the_raw_change():
    script = ("const { attentionItems } = await import(process.argv[1]);"
              "console.log(JSON.stringify(attentionItems(JSON.parse(process.argv[2]))));")
    inp = {"approvals": [
        {"bot": "t", "id": "a1", "path": "harness.modules.debrief", "diff": "harness.modules.debrief: false -> true", "why": "enables the debrief"},
        {"bot": "t", "id": "a2", "path": "tools", "diff": "tools: + 2 (x, y)", "why": "widening"}]}
    r = subprocess.run(["node", "--input-type=module", "-e", script, ATTENTION, json.dumps(inp)], capture_output=True, text=True, timeout=60, cwd=str(ASSEMBLY))
    assert r.returncode == 0, r.stderr
    texts = [i["text"] for i in json.loads(r.stdout) if i["kind"] == "approval"]
    assert texts == ["t asks: Enables the debrief", "t asks: Change tools"], texts


def _account_items(attempted, last4, running=True):
    script = ("const { attentionItems } = await import(process.argv[1]);"
              "console.log(JSON.stringify(attentionItems(JSON.parse(process.argv[2]))));")
    inp = {"bots": [{"name": "t", "running": running, "account": "acc1"}],
           "usage": {"t": {"accountAttempted": attempted, "account": {"tokenLast4": last4}}},
           "accounts": [{"id": "acc1", "masked": "****A1b2"}]}
    r = subprocess.run(["node", "--input-type=module", "-e", script, ATTENTION, json.dumps(inp)], capture_output=True, text=True, timeout=60, cwd=str(ASSEMBLY))
    assert r.returncode == 0, r.stderr
    return [i for i in json.loads(r.stdout) if i["kind"] == "account"]


@needs_node
def test_account_attention_only_when_an_attempted_switch_did_not_land():
    items = _account_items("acc1", "C3d4")   # the launch attempted acc1, the session runs another token
    assert len(items) == 1 and items[0]["severity"] == "warn" and items[0]["action"] == {"type": "usage"}, items
    assert "switch to acc1 did not land" in items[0]["text"] and "botcorp doctor" in items[0]["text"]
    assert _account_items("acc1", "A1b2") == []      # landed
    assert _account_items("", "C3d4") == []          # pending: not attempted yet (the Usage sheet says "at next idle")
    assert _account_items("acc1", "C3d4", running=False) == []
