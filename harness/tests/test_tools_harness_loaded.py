"""R5c step 19c: a bot file the harness loads by a fixed path (HARNESS_LOADED in
cli/tools.mjs) counts as referenced: never an orphan, proposed as an exact
entry naming its loader. The anti-rot check fails the moment a loader stops
naming the file it loads.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from test_operator_only import ASSEMBLY, box, cli, needs_node  # noqa: F401

TOOLS_MJS = (ASSEMBLY / "cli" / "tools.mjs").as_uri()


def _harness_loaded() -> list:
    script = "const { HARNESS_LOADED } = await import(process.argv[1]); console.log(JSON.stringify(HARNESS_LOADED));"
    r = subprocess.run(["node", "--input-type=module", "-e", script, TOOLS_MJS], capture_output=True, text=True, timeout=60, cwd=str(ASSEMBLY))
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


@needs_node
def test_a_harness_loaded_file_is_proposed_not_orphaned(box):
    rt, bots, env = box
    f = bots / "t" / "tools" / "tg_commands_local.py"
    f.parent.mkdir(parents=True)
    f.write_text("HANDLERS = {}\n", encoding="utf-8")
    r = cli(env, "tools", "t", "scan", "--json")
    assert r.returncode == 0, r.stderr
    d = json.loads(r.stdout)
    assert "tools/tg_commands_local.py" not in [o if isinstance(o, str) else o["path"] for o in d["proposal"]["orphans"]]
    (entry,) = d["proposal"]["tools"]
    assert entry["path"] == "tools/tg_commands_local.py" and entry["kind"] == "lib"
    assert "tg_commands.py" in entry["purpose"]


@needs_node
def test_every_loader_still_names_the_file_it_loads():
    items = _harness_loaded()
    assert items
    for h in items:
        loader = ASSEMBLY / h["loader"]
        assert loader.is_file(), h["loader"]
        assert Path(h["path"]).name in loader.read_text(encoding="utf-8"), h
