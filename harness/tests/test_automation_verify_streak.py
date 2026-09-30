"""QA pack B 4: automation `verify:`, failure-streak alerts, BOT_TG_SCHEDULED.

Locked behaviour (daemon/automations.ps1, daemon/botyaml.mjs):
- `verify: {fresh: <file>, max_age_min: N}`: a run that exits 0 but leaves the
  file missing or stale appends ONE line to memory/metrics/alerts.log and its
  runs.jsonl record says `verify: miss: ...`; a fresh file says `verify: ok`
  and writes no alert;
- a failure streak reaching 3 appends ONE alerts.log line for the streak (not
  one per failure); a success re-arms it;
- every run's env carries BOT_TG_SCHEDULED=1 (tg_send.py's quiet hours);
- bot.yaml validation takes a well-formed verify and rejects a malformed one
  or one on kind: prompt.
"""
from __future__ import annotations

import json
import subprocess

from test_automation_python import ASSEMBLY, _last_log, _runs, needs_win, repo_bot  # noqa: F401  (repo_bot is a fixture)

PWSH = ["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]
YAML = (
    "name: {name}\nharness:\n  service: manual\n  modules:\n    telegram: false\n"
    "automations:\n"
    "  - name: stale\n    trigger: {{interval_min: 600}}\n    command: 'echo nothing written'\n    timeout_min: 1\n"
    "    verify: {{fresh: out/stale.txt, max_age_min: 5}}\n"
    "  - name: fresh\n    trigger: {{interval_min: 600}}\n    command: 'echo x> fresh.txt'\n    timeout_min: 1\n"
    "    verify: {{fresh: fresh.txt, max_age_min: 5}}\n"
    "  - name: flaky\n    trigger: {{interval_min: 600}}\n    command: 'if exist ok.flag (echo fine) else (echo broke & exit /b 3)'\n    timeout_min: 1\n"
    "  - name: env\n    trigger: {{interval_min: 600}}\n    command: 'echo [%BOT_TG_SCHEDULED%]'\n    timeout_min: 1\n"
)


def _exec(name, rt, env, auto, n):
    jobs = rt / "state" / name / "jobs"
    jobs.mkdir(parents=True, exist_ok=True)
    run_id = f"20260930-0000{n:02d}-{n:04x}"
    f = jobs / f"{run_id}.json"
    f.write_text(json.dumps({"bot": name, "run_id": run_id, "log": str(rt / "logs" / name / auto / f"{run_id}.log"),
                             "automation": {"name": auto}}), encoding="utf-8")
    r = subprocess.run([*PWSH, "-File", str(ASSEMBLY / "daemon" / "automations.ps1"), "-Bot", name, "-ExecJob", str(f)],
                       capture_output=True, text=True, timeout=300, cwd=str(ASSEMBLY), env=env)
    assert r.returncode == 0, r.stderr + r.stdout


def _alerts(home):
    f = home / "memory" / "metrics" / "alerts.log"
    return f.read_text(encoding="utf-8").splitlines() if f.exists() else []


@needs_win
def test_verify_miss_alerts_once_and_a_fresh_file_passes(repo_bot):
    name, home, rt, env = repo_bot
    (home / "bot.yaml").write_text(YAML.format(name=name), encoding="utf-8")
    _exec(name, rt, env, "stale", 1)
    _exec(name, rt, env, "fresh", 2)
    recs = {r["automation"]: r for r in _runs(rt, name)}
    assert recs["stale"]["exit"] == 0 and recs["stale"]["verify"] == "miss: missing"
    assert recs["fresh"]["verify"] == "ok"
    lines = _alerts(home)
    assert len(lines) == 1 and "automation stale verify FAILED" in lines[0] and "\t" in lines[0], lines


@needs_win
def test_a_failure_streak_alerts_once_per_streak(repo_bot):
    name, home, rt, env = repo_bot
    (home / "bot.yaml").write_text(YAML.format(name=name), encoding="utf-8")
    for n in range(1, 5):
        _exec(name, rt, env, "flaky", n)
    lines = _alerts(home)
    assert len(lines) == 1 and "automation flaky FAILED 3 runs in a row" in lines[0], lines
    (home / "ok.flag").write_text("1", encoding="utf-8")
    _exec(name, rt, env, "flaky", 5)
    (home / "ok.flag").unlink()
    for n in range(6, 9):
        _exec(name, rt, env, "flaky", n)
    assert len(_alerts(home)) == 2


@needs_win
def test_runs_carry_bot_tg_scheduled(repo_bot):
    name, home, rt, env = repo_bot
    (home / "bot.yaml").write_text(YAML.format(name=name), encoding="utf-8")
    _exec(name, rt, env, "env", 1)
    assert _last_log(rt, name, "env") == "[1]"


def test_verify_schema(tmp_path):
    base = "name: v\nautomations:\n  - name: a\n    trigger: {interval_min: 5}\n"

    def check(extra):
        f = tmp_path / "bot.yaml"
        f.write_text(base + extra, encoding="utf-8")
        return subprocess.run(["node", str(ASSEMBLY / "daemon" / "botyaml.mjs"), str(f), "--validate"], capture_output=True, text=True, timeout=60)

    assert check("    command: x\n    verify: {fresh: a.txt, max_age_min: 30}\n").returncode == 0
    for bad in ("    command: x\n    verify: {fresh: a.txt}\n",
                "    command: x\n    verify: {fresh: a.txt, max_age_min: 0}\n",
                "    command: x\n    verify: {fresh: a.txt, max_age_min: 5, extra: 1}\n",
                "    command: x\n    verify: a.txt\n",
                "    kind: prompt\n    prompt: hi\n    verify: {fresh: a.txt, max_age_min: 5}\n"):
        r = check(bad)
        assert r.returncode == 1 and "verify" in r.stderr, (bad, r.stdout, r.stderr)
