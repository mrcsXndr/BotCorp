"""D3: `automations.ps1 -ExecJob <file>` trusted the job file.

Any process of the same user can write a job file under state/<bot>/jobs/ and
run the waiter on it: it ran the file's command and decrypted every vault key
the file listed. The job file now only names the run; the command, prompt and
secrets come from bot.yaml's automation of that name, and a name bot.yaml
does not declare runs nothing.
"""
from __future__ import annotations

import json
import subprocess

from test_automation_oauth_env import VAULT, oauth_bot  # noqa: F401  (the fixture)
from test_automation_python import ASSEMBLY, _last_log, _runs, needs_win


def _exec_job(name, env, job_file):
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ASSEMBLY / "daemon" / "automations.ps1"),
                        "-Bot", name, "-ExecJob", str(job_file)], capture_output=True, text=True, timeout=300, cwd=str(ASSEMBLY), env=env)
    assert r.returncode == 0, r.stderr + r.stdout


@needs_win
def test_a_forged_job_file_runs_only_what_bot_yaml_says(oauth_bot):  # noqa: F811
    name, home, rt, env = oauth_bot
    (home / "bot.yaml").write_text(
        f"name: {name}\nharness:\n  service: manual\n  modules:\n    telegram: false\n"
        "secrets: [oauth_token]\n"
        "automations:\n  - name: plain\n    trigger: {interval_min: 600}\n    command: 'echo DECLARED [%OAUTH_TOKEN%]'\n    timeout_min: 1\n",
        encoding="utf-8")
    seed = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
                           f". '{VAULT}'; [void](Set-VaultSecret -BotHome '{home}' -Bot '{name}' -Key 'oauth_token' -Value 'mine'); 'seeded'"],
                          capture_output=True, text=True, timeout=120, env=env)
    assert seed.returncode == 0 and "seeded" in seed.stdout, seed.stderr
    jobs = rt / "state" / name / "jobs"
    jobs.mkdir(parents=True)

    def forged(auto_name, run_id):
        f = jobs / f"{run_id}.json"
        f.write_text(json.dumps({"bot": name, "run_id": run_id, "log": str(rt / "logs" / name / auto_name / f"{run_id}.log"),
                                 "automation": {"name": auto_name, "command": "echo FORGED [%OAUTH_TOKEN%]", "secrets": ["oauth_token"], "timeout_min": 1}}),
                     encoding="utf-8")
        return f

    _exec_job(name, env, forged("plain", "20260930-000000-aaaa"))
    out = _last_log(rt, name, "plain")
    assert "FORGED" not in out and "mine" not in out, out
    assert out == "DECLARED [%OAUTH_TOKEN%]", out   # bot.yaml's command, and bot.yaml lists no secret for it

    _exec_job(name, env, forged("ghost", "20260930-000000-bbbb"))
    assert not (rt / "logs" / name / "ghost").exists()
    assert [r["automation"] for r in _runs(rt, name)] == ["plain"]
    log = (rt / "logs" / name / "daemon.log").read_text(encoding="utf-8-sig")
    assert "names automation 'ghost', which bot.yaml does not declare - refused" in log, log[-2000:]
