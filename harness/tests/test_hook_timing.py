"""QA pack C 2: every hook run is timed, and the doctor grades it.

Locked behaviour:
- harness/hooks/run.mjs appends {ts, hook, ms, rc} to
  <rt>/state/<bot>/hooks-timing.jsonl for each run that spawns (a gated-off
  hook spawns nothing and records nothing); guard.mjs records its hooks.json
  entry points as guard-pre / guard-post, a direct guard run is not recorded;
- a run that would outlive its hooks.json timeout is killed 1 s before it
  and recorded with timed_out;
- no state/<bot>/ folder -> no record and no folder (no retired-bot debris);
- the file is cut to its last 2000 lines once it passes 256 KB;
- cli/_lib.mjs hookTimingVerdict: p50/p95 per hook over the last 24 h, WARN
  when a p95 is over half the hook's hooks.json timeout or a run timed out;
  `botcorp observe <bot>` prints the same verdict as one line.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from test_operator_only import box, cli  # noqa: F401

ASSEMBLY = Path(__file__).resolve().parents[2]
HOOKS = ASSEMBLY / "harness" / "hooks"
LIB = (ASSEMBLY / "cli" / "_lib.mjs").as_uri()
needs_bash = pytest.mark.skipif(shutil.which("node") is None or (os.name != "nt" and shutil.which("bash") is None), reason="node + bash")


def _env(rt: Path, bot="t"):
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOT_")}
    env.update(BOTCORP_HOME=str(rt), BOT_NAME=bot)
    return env


def _script(tmp: Path, body: str) -> Path:
    s = tmp / "x.sh"
    s.write_text("#!/usr/bin/env bash\n" + body + "\n", encoding="utf-8", newline="\n")
    s.chmod(0o755)
    return s


def _lines(rt: Path, bot="t"):
    f = rt / "state" / bot / "hooks-timing.jsonl"
    return [json.loads(l) for l in f.read_text(encoding="utf-8").splitlines()] if f.exists() else []


@needs_bash
def test_run_mjs_records_each_spawned_run(tmp_path):
    rt = tmp_path / "rt"
    (rt / "state" / "t").mkdir(parents=True)
    s = _script(tmp_path, "exit 3")
    r = subprocess.run(["node", str(HOOKS / "run.mjs"), "x-test", "-", str(s)], env=_env(rt), capture_output=True, text=True, timeout=60)
    assert r.returncode == 3, r.stderr
    [rec] = _lines(rt)
    assert rec["hook"] == "x-test" and rec["rc"] == 3 and isinstance(rec["ms"], int) and rec["ms"] >= 0 and "timed_out" not in rec
    # a hook gated off by its module spawns nothing and records nothing
    r = subprocess.run(["node", str(HOOKS / "run.mjs"), "x-test", "some_module", str(s)], env={**_env(rt), "BOT_MODULES": "other"},
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 0 and len(_lines(rt)) == 1


@needs_bash
def test_no_state_folder_no_record_no_debris(tmp_path):
    rt = tmp_path / "rt"
    (rt / "state").mkdir(parents=True)
    s = _script(tmp_path, "exit 0")
    subprocess.run(["node", str(HOOKS / "run.mjs"), "x-test", "-", str(s)], env=_env(rt, "gone"), capture_output=True, timeout=60)
    assert not (rt / "state" / "gone").exists()


def _hooks_copy(tmp_path, body: str, timeout: int) -> Path:
    # run.mjs reads the timeout from the hooks.json next to it: a copy with one hook
    hooks = tmp_path / "hooks"
    hooks.mkdir()
    for f in ("run.mjs", "_timing.mjs"):
        shutil.copy(HOOKS / f, hooks / f)
    (hooks / "h.sh").write_text("#!/usr/bin/env bash\n" + body + "\n", encoding="utf-8", newline="\n")
    (hooks / "h.sh").chmod(0o755)
    (hooks / "hooks.json").write_text(json.dumps({"hooks": {"Stop": [{"matcher": "", "hooks": [
        {"type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/run.mjs", "h", "-", "h.sh"], "timeout": timeout}]}]}}),
        encoding="utf-8")
    return hooks


@needs_bash
def test_a_run_past_its_timeout_is_recorded_as_timed_out(tmp_path):
    # the sleep must not hold the captured pipe open, or this test waits it out, not run.mjs
    hooks = _hooks_copy(tmp_path, "sleep 20 >/dev/null 2>&1", 2)
    rt = tmp_path / "rt"
    (rt / "state" / "t").mkdir(parents=True)
    t0 = time.monotonic()
    r = subprocess.run(["node", str(hooks / "run.mjs"), "h", "-", "h.sh"], env=_env(rt), capture_output=True, text=True, timeout=60)
    assert time.monotonic() - t0 < 10
    assert r.returncode == 1
    [rec] = _lines(rt)
    assert rec["hook"] == "h" and rec["timed_out"] is True and rec["rc"] is None


@needs_bash
def test_a_hook_with_a_timeout_runs_normally(tmp_path):
    # a real hooks.json timeout (30 s) leaves a fractional budget: spawnSync needs an integer
    hooks = _hooks_copy(tmp_path, "echo out; exit 4", 30)
    rt = tmp_path / "rt"
    (rt / "state" / "t").mkdir(parents=True)
    r = subprocess.run(["node", str(hooks / "run.mjs"), "h", "-", "h.sh"], env=_env(rt), capture_output=True, text=True, timeout=60)
    assert r.returncode == 4 and r.stdout.strip() == "out", r.stderr
    [rec] = _lines(rt)
    assert rec["hook"] == "h" and rec["rc"] == 4 and "timed_out" not in rec


@needs_bash
def test_the_file_is_cut_to_the_last_2000_lines(tmp_path):
    rt = tmp_path / "rt"
    d = rt / "state" / "t"
    d.mkdir(parents=True)
    old = json.dumps({"ts": "2026-01-01T00:00:00Z", "hook": "old", "ms": 1, "rc": 0, "pad": "x" * 60})
    (d / "hooks-timing.jsonl").write_text((old + "\n") * 4000, encoding="utf-8")
    assert (d / "hooks-timing.jsonl").stat().st_size > 256 * 1024
    s = _script(tmp_path, "exit 0")
    subprocess.run(["node", str(HOOKS / "run.mjs"), "x-test", "-", str(s)], env=_env(rt), capture_output=True, timeout=60)
    lines = _lines(rt)
    assert len(lines) == 2000 and lines[-1]["hook"] == "x-test" and lines[0]["hook"] == "old"


@pytest.mark.skipif(shutil.which("node") is None, reason="node")
def test_a_failed_rotation_leaves_no_tmp_file(tmp_path):
    rt = tmp_path / "rt"
    d = rt / "state" / "t"
    d.mkdir(parents=True)
    old = json.dumps({"ts": "2026-01-01T00:00:00Z", "hook": "old", "ms": 1, "rc": 0, "pad": "x" * 60})
    (d / "hooks-timing.jsonl").write_text((old + "\n") * 4000, encoding="utf-8")
    js = (f"import fs from 'node:fs'; import {{ recordTiming }} from '{(HOOKS / '_timing.mjs').as_uri()}';"
          "fs.renameSync = () => { throw new Error('EPERM'); }; recordTiming('x', 1, 0);")
    subprocess.run(["node", "--input-type=module", "-e", js], env=_env(rt), capture_output=True, timeout=60, check=True)
    assert [p.name for p in d.iterdir()] == ["hooks-timing.jsonl"]


@pytest.mark.skipif(shutil.which("node") is None, reason="node")
def test_guard_records_its_entry_points_only(tmp_path):
    rt = tmp_path / "rt"
    (rt / "state" / "t").mkdir(parents=True)
    env = {**_env(rt), "BOT_HOME": str(tmp_path)}
    payload = json.dumps({"tool_name": "Read", "tool_input": {"file_path": str(tmp_path / "a.txt")}})
    r = subprocess.run(["node", str(HOOKS / "guard.mjs"), "pre"], input=payload, env=env, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    r = subprocess.run(["node", str(HOOKS / "guard.mjs"), "vault-guard"], input=payload, env=env, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    recs = _lines(rt)
    assert [x["hook"] for x in recs] == ["guard-pre"] and recs[0]["rc"] == 0


@pytest.mark.skipif(os.name != "nt" or shutil.which("node") is None, reason="the doctor's vault probe runs on Windows only")
def test_the_doctor_vault_probe_is_not_recorded(box):  # noqa: F811
    # QA r4 live N3: the probe's synthetic block showed up as the bot's guard-pre rc=2
    rt, bots, env = box
    (rt / "state" / "t").mkdir(parents=True, exist_ok=True)
    r = cli(env, "doctor", "--no-tg-probe", "--no-accounts", "--json", timeout=300)
    rows = {c["name"]: c for c in json.loads(r.stdout)}
    assert rows["t: vault isolation"]["level"] == "PASS", rows.get("t: vault isolation")
    assert [x for x in _lines(rt) if x["hook"] == "guard-pre"] == []


def _verdict(lines, now):
    js = (f"import {{ hookTimeouts, hookTimingVerdict }} from '{LIB}';"
          f"import fs from 'node:fs';"
          f"const t = hookTimeouts(JSON.parse(fs.readFileSync({json.dumps(str(HOOKS / 'hooks.json'))}, 'utf-8')));"
          f"console.log(JSON.stringify({{ t, v: hookTimingVerdict({json.dumps(chr(10).join(lines))}, t, {now}) }}));")
    r = subprocess.run(["node", "--input-type=module", "-e", js], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def _rec(hook, ms, age_h=1.0, **kw):
    ts = (datetime(2026, 9, 30, 22, 0, tzinfo=timezone.utc) - timedelta(hours=age_h)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return json.dumps({"ts": ts, "hook": hook, "ms": ms, "rc": 0, **kw})


NOW = int(datetime(2026, 9, 30, 22, 0, tzinfo=timezone.utc).timestamp() * 1000)


@pytest.mark.skipif(shutil.which("node") is None, reason="node")
def test_verdict_grades_p95_against_half_the_timeout():
    out = _verdict([_rec("session-start", 2000)] * 19 + [_rec("session-start", 9000), _rec("guard-pre", 120)], NOW)
    assert out["t"]["session-start"] == 30 and out["t"]["guard-pre"] == 15 and out["t"]["subagent"] == 15
    assert out["v"]["level"] == "PASS", out
    assert "session-start p50 2.0s p95 2.0s of 30s (20)" in out["v"]["detail"] and "guard-pre p50 120ms" in out["v"]["detail"]
    slow = _verdict([_rec("session-start", 16000)] * 20, NOW)["v"]
    assert slow["level"] == "WARN" and slow["detail"].startswith("p95 over half the timeout or timed out: session-start."), slow
    late = _verdict([_rec("guard-pre", 50), _rec("guard-pre", 14000, timed_out=True)], NOW)["v"]
    assert late["level"] == "WARN" and "1 timed out" in late["detail"]


@pytest.mark.skipif(shutil.which("node") is None, reason="node")
def test_verdict_reads_the_last_24h_only():
    assert _verdict([_rec("session-start", 29000, age_h=25), "not json"], NOW)["v"]["level"] == "INFO"


@pytest.mark.skipif(shutil.which("node") is None, reason="node")
def test_observe_prints_the_hook_line(box):  # noqa: F811
    rt, bots, env = box
    (rt / "state" / "t").mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    (rt / "state" / "t" / "hooks-timing.jsonl").write_text(json.dumps({"ts": now, "hook": "session-start", "ms": 20000, "rc": 0}) + "\n", encoding="utf-8")
    r = cli(env, "observe", "t")
    assert r.returncode == 0, r.stderr
    assert "hooks 24h WARN: p95 over half the timeout or timed out: session-start." in r.stdout, r.stdout
