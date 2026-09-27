"""R5a step 11: the cockpit API for approvals, attention, usage, automations, tools.

A real cockpit (node cockpit/server.mjs) on a free loopback port, over fixture
bots and a temp BOTCORP_HOME / BOTCORP_BOTS_DIR (never the real runtime):
- the GET routes return their shapes (attention items, usage groups, pending +
  recent approvals, a tools scan);
- approve: refused (403) without the per-boot approval token the server prints,
  then 200 with it; the queue entry is applied, the history names the
  identity, and the audit log has the line;
- automations run queues a run-now; resume (widening) needs the token too.
"""
from __future__ import annotations

import json
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from test_operator_only import ASSEMBLY, make_bot, needs_node, operator_env, queue

SERVER = ASSEMBLY / "cockpit" / "server.mjs"

T_YAML = (
    "name: t\nharness:\n  service: manual\n"
    "automations:\n"
    "  - name: job\n    command: echo hi\n    trigger: { interval_min: 60 }\n"
    "  - name: off\n    command: echo hi\n    trigger: { interval_min: 60 }\n    enabled: false\n"
    "tools: []\n"
)
ENTRY = {"id": "abc123", "ts": "2026-09-27T00:00:00Z", "path": "harness.modules.remote_control", "value": True,
         "requested_by": "bot:u", "reason": "enables Remote Control"}


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
    assert appr["action"] == {"type": "approve", "bot": "u", "id": "abc123"} and "remote_control" in appr["text"]
    assert all(set(i) == {"bot", "kind", "severity", "text", "action"} for i in att["items"])

    code, usage = c.call("GET", "/api/usage")
    assert code == 200 and sorted(r["bot"] for r in usage["bots"]) == ["t", "u"], usage
    assert all("fiveHour" in r and "sevenDay" in r and "account" in r for r in usage["bots"])
    assert sorted(b for g in usage["accounts"] for b in g["bots"]) == ["t", "u"], usage["accounts"]

    code, ap = c.call("GET", "/api/approvals")
    assert code == 200 and [p["id"] for p in ap["pending"]] == ["abc123"] and ap["recent"] == [], ap
    assert ap["pending"][0]["diff"] == "harness.modules.remote_control: false -> true"

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
    assert "remote_control: true" in (bots / "u" / "bot.yaml").read_text(encoding="utf-8")
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
    code, body = c.call("POST", "/api/bots/t/automations/job/run")
    assert code == 200 and body["ok"], body
    q = (rt / "state" / "t" / "events" / "run-now.queue").read_text(encoding="utf-8").splitlines()
    assert json.loads(q[-1])["automation"] == "job"

    code, body = c.call("POST", "/api/bots/t/automations/off/resume")
    assert code == 403, body
    code, body = c.call("POST", "/api/bots/t/automations/off/resume", token=True)
    assert code == 200 and body["ok"], body
    assert "enabled: false" not in (bots / "t" / "bot.yaml").read_text(encoding="utf-8")

    assert c.call("POST", "/api/bots/t/automations/nope/run")[0] == 404
    assert c.call("POST", "/api/bots/t/automations/job/explode")[0] == 400
    rows = _audit(rt, 5)
    assert rows[0]["automation"] == "job" and rows[0]["action"] == "run" and rows[0]["result"] == 200, rows
