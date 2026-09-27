"""R5a step 7: the doctor rows of the capability registry (cli/tools.mjs
registryRows, a pure function of the config and the scan).

- warn mode: an unregistered executable is WARN, an entry matching no file FAIL,
  an automation running an unregistered script WARN, a registered script
  nothing references INFO. enforce mode (harness.tools_registry) makes the
  two gap rows FAIL.
- automation-bare-python: WARN for an ENABLED job starting with python / py;
  a disabled one gives no row.
- board-token: PASS with gh_token declared, INFO without (board module on only).
- through `doctor --json`, a bot with `tools:` shows the rows (the positive
  control for the no-rows check in test_tools_registry_schema.py).
"""
from __future__ import annotations

import json
import subprocess

from test_operator_only import ASSEMBLY, box, cli, needs_node  # noqa: F401

TOOLS_MJS = (ASSEMBLY / "cli" / "tools.mjs").as_uri()


def _rows(cfg: dict, scan: dict | None) -> dict:
    script = ("const { registryRows } = await import(process.argv[1]);"
              "const [cfg, scan] = JSON.parse(process.argv[2]);"
              "console.log(JSON.stringify(registryRows(cfg, scan)));")
    r = subprocess.run(["node", "--input-type=module", "-e", script, TOOLS_MJS, json.dumps([cfg, scan])],
                       capture_output=True, text=True, timeout=60, cwd=str(ASSEMBLY))
    assert r.returncode == 0, r.stderr
    return {row["name"]: row for row in json.loads(r.stdout)}


def _scan(**kw):
    base = {"registry": "warn", "executables": ["tools/a.py"], "registered": [], "missing": [], "unused": [],
            "unregistered": [], "automation_unregistered": [], "proposal": {"tools": [], "orphans": []}}
    return {**base, **kw}


CFG = {"harness": {"modules": {"board": False}}, "automations": [], "secrets": ["oauth_token"]}


@needs_node
def test_warn_mode_levels():
    rows = _rows(CFG, _scan(unregistered=["tools/a.py"], missing=["gone"], unused=["idle"],
                            automation_unregistered=[{"automation": "mon", "path": "tools/a.py"}]))
    assert rows["tools-unregistered"]["level"] == "WARN"
    assert rows["tools-missing"]["level"] == "FAIL" and "gone" in rows["tools-missing"]["detail"]
    assert rows["automation-unregistered"]["level"] == "WARN"
    assert rows["tools-unused"]["level"] == "INFO"


@needs_node
def test_enforce_mode_fails_the_gaps():
    rows = _rows(CFG, _scan(registry="enforce", unregistered=["tools/a.py"], unused=["idle"],
                            automation_unregistered=[{"automation": "mon", "path": "tools/a.py"}]))
    assert rows["tools-unregistered"]["level"] == "FAIL"
    assert rows["automation-unregistered"]["level"] == "FAIL"
    assert rows["tools-unused"]["level"] == "INFO"


@needs_node
def test_clean_registry_passes_and_off_has_no_rows():
    rows = _rows(CFG, _scan())
    assert {rows[n]["level"] for n in ("tools-unregistered", "tools-missing", "automation-unregistered")} == {"PASS"}
    assert "tools-unused" not in rows
    assert _rows(CFG, None) == {}


def _rows3(cfg: dict, scan: dict, streak) -> dict:
    script = ("const { registryRows } = await import(process.argv[1]);"
              "const [cfg, scan, n] = JSON.parse(process.argv[2]);"
              "console.log(JSON.stringify(registryRows(cfg, scan, n)));")
    r = subprocess.run(["node", "--input-type=module", "-e", script, TOOLS_MJS, json.dumps([cfg, scan, streak])],
                       capture_output=True, text=True, timeout=60, cwd=str(ASSEMBLY))
    assert r.returncode == 0, r.stderr
    return {row["name"]: row for row in json.loads(r.stdout)}


@needs_node
def test_enforce_ready_row_only_in_warn_mode():
    assert _rows3(CFG, _scan(), 3)["tools-enforce-ready"] == {"level": "INFO", "name": "tools-enforce-ready", "detail": "clean 3/7 consecutive days before enforce (botcorp tools <bot> gate)"}
    assert "ready for botcorp config set <bot> harness.tools_registry enforce" in _rows3(CFG, _scan(), 7)["tools-enforce-ready"]["detail"]
    assert "tools-enforce-ready" not in _rows3(CFG, _scan(registry="enforce"), 9)
    assert "tools-enforce-ready" not in _rows3(CFG, _scan(), None)


@needs_node
def test_bare_python_only_for_enabled_jobs():
    job = {"name": "j", "command": "python tools/a.py", "trigger": {"interval_min": 5}}
    rows = _rows({**CFG, "automations": [job]}, None)
    assert rows["automation-bare-python"]["level"] == "WARN" and "j" in rows["automation-bare-python"]["detail"]
    assert "automation-bare-python" not in _rows({**CFG, "automations": [{**job, "enabled": False}]}, None)
    assert "automation-bare-python" not in _rows({**CFG, "automations": [{**job, "command": "${PY} tools/a.py"}]}, None)


@needs_node
def test_board_token_row():
    board = {**CFG, "harness": {"modules": {"board": True}}}
    assert _rows(board, None)["board-token"]["level"] == "INFO"
    assert _rows({**board, "secrets": ["oauth_token", "gh_token"]}, None)["board-token"]["level"] == "PASS"
    assert "board-token" not in _rows(CFG, None)


@needs_node
def test_a_glob_over_a_secret_reader_is_underclassified(box):
    rt, bots, env = box
    home = bots / "t"
    for name, text in {"one.py": "print(1)\n", "two.py": "print(2)\n", "a.py": 'import os\nk = os.environ["AWS_SECRET_ACCESS_KEY"]\n'}.items():
        (home / "tools" / "x").mkdir(parents=True, exist_ok=True)
        (home / "tools" / "x" / name).write_text(text, encoding="utf-8")
    base = "name: t\nharness:\n  service: manual\n{mode}tools:\n  - {{name: x, path: tools/x/*.py, kind: cli}}\n"
    for mode, level in (("", "WARN"), ("  tools_registry: enforce\n", "FAIL")):
        (home / "bot.yaml").write_text(base.format(mode=mode), encoding="utf-8")
        scan = json.loads(cli(env, "tools", "t", "scan", "--json").stdout)
        assert scan["underclassified"] == [{"path": "tools/x/a.py", "entry": "x", "reads": ["AWS_SECRET_ACCESS_KEY"]}]
        row = _rows(CFG, scan)["tools-underclassified"]
        assert row["level"] == level and "tools/x/a.py" in row["detail"]
    assert _rows(CFG, _scan())["tools-underclassified"]["level"] == "PASS"


@needs_node
def test_doctor_shows_the_rows_for_a_registry_bot(box):
    rt, bots, env = box
    home = bots / "t"
    (home / "bot.yaml").write_text("name: t\nharness:\n  service: manual\ntools:\n  - {name: gone, path: tools/gone.py, kind: cli}\n", encoding="utf-8")
    (home / "tools").mkdir()
    (home / "tools" / "new.py").write_text("print(1)\n", encoding="utf-8")
    r = cli(env, "doctor", "--no-tg-probe", "--no-accounts", "--json", timeout=300)
    rows = {c["name"]: c for c in json.loads(r.stdout)}
    assert rows["t: tools-unregistered"]["level"] == "WARN" and "tools/new.py" in rows["t: tools-unregistered"]["detail"]
    assert rows["t: tools-missing"]["level"] == "FAIL"
