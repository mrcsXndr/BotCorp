"""QA pack B 7a: the timeline summariser runs as a daemon job with the vault token.

Locked behaviour:
- `timeline.py summarize-stale` distills a missing or structural timeline and
  exits 0; an already distilled one is left alone ("nothing to do", no claude
  run); a distill that falls back to structural exits 1 (the job's failure
  streak sees it);
- module timeline_summary gives the bot a built-in `timeline-summary`
  automation (daemon/automations.ps1 Get-BuiltinAutomations): the scheduler
  runs it, and its waiter hands the job the bot's vault oauth_token as
  CLAUDE_CODE_OAUTH_TOKEN and the workhorse model of harness/models.json;
- without the module the name is refused like any undeclared automation.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

from test_automation_oauth_env import VAULT, oauth_bot  # noqa: F401  (the fixture)
from test_automation_python import ASSEMBLY, _runs, needs_win

TIMELINE = ASSEMBLY / "harness" / "tools" / "v2" / "timeline.py"
PWSH = ["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]
SID = "sess-0001"


def _fake_claude(tmp_path, rc=0):
    """A stand-in claude: logs its argv and the token it saw, prints a distilled timeline."""
    f = tmp_path / "claude.cmd"
    f.write_text(
        "@echo off\r\n"
        "more > nul\r\n"
        f"echo %* token=[%CLAUDE_CODE_OAUTH_TOKEN%]>> \"{tmp_path / 'calls.log'}\"\r\n"
        + (f"exit /b {rc}\r\n" if rc else "")
        + "echo ---\r\necho phase: 2-distilled\r\necho ---\r\necho # Critic's Timeline (distilled)\r\n"
        "echo ## Narrative\r\necho The session shipped the queue and the digest, verified by tests.\r\n",
        encoding="utf-8")
    return f


def _bot_memory(home, structural=True):
    s = home / "memory" / "sessions" / SID
    s.mkdir(parents=True, exist_ok=True)
    (s / "journal.md").write_text("# Journal\n\n## Decisions\n- [10:00] ship pack B\n", encoding="utf-8")
    (s / "timeline.md").write_text("---\nphase: 1-structural\n---\n" if structural else "---\nphase: 2-distilled\n---\nbody\n", encoding="utf-8")
    (home / ".claude").mkdir(exist_ok=True)
    (home / ".claude" / ".current_session_id").write_text(SID, encoding="utf-8")


def _summarize(tmp_path, home, fake, token="t0k"):
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "BOT_"))}
    env.update(BOT_HOME=str(home), BOTCORP_CLAUDE_EXE=str(fake), CLAUDE_CODE_OAUTH_TOKEN=token, PYTHONIOENCODING="utf-8")
    return subprocess.run([sys.executable, str(TIMELINE), "summarize-stale"], capture_output=True, text=True,
                          encoding="utf-8", env=env, timeout=120)


def test_summarize_stale_distills_skips_and_reports_a_fallback(tmp_path):
    home = tmp_path / "bot"
    _bot_memory(home)
    fake = _fake_claude(tmp_path)
    r = _summarize(tmp_path, home, fake)
    assert r.returncode == 0 and "SUMMARY: distilled" in r.stdout, r.stdout + r.stderr
    tl = (home / "memory" / "sessions" / SID / "timeline.md").read_text(encoding="utf-8")
    assert "phase: 2-distilled" in tl and "phase: 1-structural" not in tl
    calls = (tmp_path / "calls.log").read_text(encoding="utf-8").splitlines()
    assert len(calls) == 1
    r = _summarize(tmp_path, home, fake)
    assert r.returncode == 0 and "already distilled" in r.stdout
    assert len((tmp_path / "calls.log").read_text(encoding="utf-8").splitlines()) == 1   # no second claude run

    _bot_memory(home)   # structural again, and claude fails this time
    r = _summarize(tmp_path, home, _fake_claude(tmp_path, rc=1))
    assert r.returncode == 1 and "fell back to structural" in r.stdout, r.stdout + r.stderr


@needs_win
def test_the_module_runs_the_builtin_job_with_the_vault_token(oauth_bot, tmp_path):  # noqa: F811
    name, home, rt, env = oauth_bot
    (home / "bot.yaml").write_text(
        f"name: {name}\nharness:\n  service: manual\n  modules:\n    telegram: false\n    timeline_summary: true\n"
        "secrets: [oauth_token]\n", encoding="utf-8")
    seed = subprocess.run([*PWSH, "-Command", f". '{VAULT}'; [void](Set-VaultSecret -BotHome '{home}' -Bot '{name}' -Key 'oauth_token' -Value 'mine'); 'seeded'"],
                          capture_output=True, text=True, timeout=120, env=env)
    assert seed.returncode == 0 and "seeded" in seed.stdout, seed.stderr
    _bot_memory(home)
    env = {**env, "BOTCORP_CLAUDE_EXE": str(_fake_claude(tmp_path))}

    dry = subprocess.run([*PWSH, "-File", str(ASSEMBLY / "daemon" / "automations.ps1"), "-Bot", name, "-DryRun"],
                         capture_output=True, text=True, timeout=300, cwd=str(ASSEMBLY), env=env)
    assert "DRYRUN would run timeline-summary" in dry.stdout, dry.stdout + dry.stderr

    jobs = rt / "state" / name / "jobs"
    jobs.mkdir(parents=True, exist_ok=True)
    job = jobs / "20260930-000000-aaaa.json"
    job.write_text(json.dumps({"bot": name, "run_id": "20260930-000000-aaaa", "automation": {"name": "timeline-summary"},
                               "log": str(rt / "logs" / name / "timeline-summary" / "20260930-000000-aaaa.log")}), encoding="utf-8")
    r = subprocess.run([*PWSH, "-File", str(ASSEMBLY / "daemon" / "automations.ps1"), "-Bot", name, "-ExecJob", str(job)],
                       capture_output=True, text=True, timeout=300, cwd=str(ASSEMBLY), env=env)
    assert r.returncode == 0, r.stderr + r.stdout
    rec = _runs(rt, name)[-1]
    assert rec["automation"] == "timeline-summary" and rec["exit"] == 0 and rec["summary"].startswith("SUMMARY: distilled"), rec
    call = (tmp_path / "calls.log").read_text(encoding="utf-8")
    workhorse = json.loads((ASSEMBLY / "harness" / "models.json").read_text(encoding="utf-8"))["tiers"]["workhorse"]["id"]
    assert "token=[mine]" in call and f"--model {workhorse}" in call, call


@needs_win
def test_without_the_module_the_name_is_refused(oauth_bot):  # noqa: F811
    name, home, rt, env = oauth_bot
    (home / "bot.yaml").write_text(f"name: {name}\nharness:\n  service: manual\n  modules:\n    telegram: false\n", encoding="utf-8")
    jobs = rt / "state" / name / "jobs"
    jobs.mkdir(parents=True, exist_ok=True)
    job = jobs / "20260930-000000-bbbb.json"
    job.write_text(json.dumps({"bot": name, "run_id": "20260930-000000-bbbb", "automation": {"name": "timeline-summary"},
                               "log": str(rt / "logs" / name / "timeline-summary" / "x.log")}), encoding="utf-8")
    subprocess.run([*PWSH, "-File", str(ASSEMBLY / "daemon" / "automations.ps1"), "-Bot", name, "-ExecJob", str(job)],
                   capture_output=True, text=True, timeout=300, cwd=str(ASSEMBLY), env=env)
    assert _runs(rt, name) == []
