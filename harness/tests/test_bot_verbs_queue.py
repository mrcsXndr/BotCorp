"""QA pack B 1: `new`, `import` and `adopt` from a bot wait for approval; `archive` is symmetric.

Locked behaviour (cli/botcorp.mjs queueBotVerb / applyBotVerb / ownUnstartedBot):
- from a bot session the verb creates nothing: it queues op new|import|adopt in
  the REQUESTING bot's queue (path = the new bot's name), exit 0, and a token
  given on stdin never lands in the queue;
- `botcorp approve <requester> <id>` from the operator runs the verb and records
  state/<new>.origin.json created_by bot:<requester>;
- from the operator's terminal the verbs apply at once (unchanged);
- `archive` from a bot works only for a bot IT asked for and that was never
  started; any other bot, and every other bot's archive, stays operator-only (exit 3).
"""
from __future__ import annotations

import json
import shutil
import subprocess

import pytest

from test_admin_role import ID_BOSS, ID_PEON, abox  # noqa: F401 (abox is a fixture)
from test_operator_only import ASSEMBLY, make_bot

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node on PATH")

FAKE = "sk-ant-oat01-" + "FAKE" * 7 + "-Qb01"


def _cli(env, *args, stdin=""):
    return subprocess.run(["node", str(ASSEMBLY / "cli" / "botcorp.mjs"), *args], input=stdin, capture_output=True,
                          text=True, encoding="utf-8", timeout=180, cwd=str(ASSEMBLY), env=env)


def _queue(rt, bot):
    f = rt / "state" / f"{bot}.approvals.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else []


def _new_from(env, name):
    return _cli(env, "new", "--yes", "--no-launch", "--name", name, "--service", "manual", "--oauth-stdin", stdin=FAKE + "\n")


def test_new_from_a_bot_queues_and_the_operator_approves(abox):
    rt, bots, op, as_bot = abox
    r = _new_from(as_bot("peon", ID_PEON), "scratch")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "queued for operator approval: botcorp approve peon" in r.stdout
    assert not (bots / "scratch").exists()
    q = _queue(rt, "peon")
    assert len(q) == 1 and q[0]["op"] == "new" and q[0]["path"] == "scratch" and q[0]["requested_by"] == "bot:peon"
    assert FAKE not in (rt / "state" / "peon.approvals.json").read_text(encoding="utf-8")
    # the same request again is a duplicate, not a second entry
    assert _new_from(as_bot("peon", ID_PEON), "scratch").returncode == 0 and len(_queue(rt, "peon")) == 1

    r = _cli(op, "approve", "peon", q[0]["id"])
    assert r.returncode == 0, r.stdout + r.stderr
    assert "service: manual" in (bots / "scratch" / "bot.yaml").read_text(encoding="utf-8")
    assert json.loads((rt / "state" / "scratch.origin.json").read_text(encoding="utf-8"))["created_by"] == "bot:peon"
    assert _queue(rt, "peon") == []


def test_new_from_the_operator_applies_at_once(abox):
    rt, bots, op, as_bot = abox
    r = _cli(op, "new", "--yes", "--no-launch", "--name", "direct", "--service", "manual")
    assert r.returncode == 0, r.stdout + r.stderr
    assert (bots / "direct" / "bot.yaml").exists() and not (rt / "state" / "direct.origin.json").exists()


def test_import_and_adopt_from_a_bot_queue(abox, tmp_path):
    rt, bots, op, as_bot = abox
    zip_file = tmp_path / "peon.zip"
    assert _cli(op, "export", "peon", "--out", str(zip_file)).returncode == 0
    r = _cli(as_bot("peon", ID_PEON), "import", str(zip_file), "--as", "copy")
    assert r.returncode == 0 and "queued for operator approval" in r.stdout, r.stdout + r.stderr
    assert not (bots / "copy").exists()

    src = tmp_path / "oldbot"
    (src / ".claude").mkdir(parents=True)
    (src / "CLAUDE.md").write_text("# old\n", encoding="utf-8")
    r = _cli(as_bot("peon", ID_PEON), "adopt", str(src), "--as", "adopted", "--dry-run")
    assert r.returncode == 0 and "adopt plan (dry-run" in r.stdout   # read-only: still runs
    r = _cli(as_bot("peon", ID_PEON), "adopt", str(src), "--as", "adopted")
    assert r.returncode == 0 and "queued for operator approval" in r.stdout, r.stdout + r.stderr
    assert not (bots / "adopted").exists()

    q = {e["path"]: e for e in _queue(rt, "peon")}
    assert q["copy"]["op"] == "import" and q["adopted"]["op"] == "adopt"
    assert _cli(op, "approve", "peon", "--all").returncode == 0
    assert (bots / "copy" / "bot.yaml").exists() and (bots / "adopted" / "bot.yaml").exists()
    assert "name: copy" in (bots / "copy" / "bot.yaml").read_text(encoding="utf-8")


def test_archive_by_the_requesting_bot_only_while_never_started(abox):
    rt, bots, op, as_bot = abox
    for name in ("s1", "s2"):
        _new_from(as_bot("peon", ID_PEON), name)
    assert _cli(op, "approve", "peon", "--all").returncode == 0
    # another bot, an admin one included, may not archive peon's bot
    r = _cli(as_bot("boss", ID_BOSS), "archive", "s1")
    assert r.returncode == 3 and "operator-only" in r.stderr, r.stdout + r.stderr
    # a spoofed peon (wrong launch id) may not either
    assert _cli(as_bot("peon", "ab" * 32), "archive", "s1").returncode == 3
    # a bot the operator made is operator-only for peon
    make_bot(bots, "opbot")
    assert _cli(as_bot("peon", ID_PEON), "archive", "opbot").returncode == 3
    # started once: operator-only again
    (rt / "state" / "s2.json").write_text(json.dumps({"bot": "s2", "launch": {"at": "2026-09-30T00:00:00Z"}}), encoding="utf-8")
    assert _cli(as_bot("peon", ID_PEON), "archive", "s2").returncode == 3
    # never started and peon's own: archived, and the origin record goes with it
    r = _cli(as_bot("peon", ID_PEON), "archive", "s1")
    assert r.returncode == 0, r.stdout + r.stderr
    assert not (bots / "s1").exists() and not (rt / "state" / "s1.origin.json").exists()
