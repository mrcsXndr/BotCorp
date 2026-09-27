"""R5a step 15c: stale pending releases never reach the attention bar.

updates.json keeps every tag the daemon ever saw, most still `pending` long
after the checkout moved past them (17 on the canary host). attentionItems
counts only pending tags newer than the installed version and emits one item,
for the newest; listUpdates marks the rest `older` so the Releases panel shows
them without Apply.
"""
from __future__ import annotations

import json
import os
import subprocess

from test_operator_only import ASSEMBLY, needs_node

ATTENTION = (ASSEMBLY / "cockpit" / "attention.mjs").as_uri()
UPDATES = (ASSEMBLY / "cockpit" / "updates.mjs").as_uri()

RELEASES = [
    {"tag": "v0.1.11", "status": "pending"}, {"tag": "v0.2.13", "status": "pending"},
    {"tag": "v0.3.0", "status": "applied"}, {"tag": "v0.5.0", "status": "pending"},
    {"tag": "v0.6.0", "status": "pending"}, {"tag": "v0.10.1", "status": "pending"},
    {"tag": "v0.7.0", "status": "applied"}, {"tag": "v0.8.0", "status": "skipped"},
]


def _node(script: str, *args: str, rt) -> str:
    env = {**os.environ, "BOTCORP_HOME": str(rt)}
    r = subprocess.run(["node", "--input-type=module", "-e", script, *args], capture_output=True, text=True,
                       timeout=60, cwd=str(ASSEMBLY), env=env)
    assert r.returncode == 0, r.stderr
    return r.stdout


def _items(rt, installed):
    script = ("const { attentionItems } = await import(process.argv[1]);"
              "const [releases, installed] = JSON.parse(process.argv[2]);"
              "console.log(JSON.stringify(attentionItems({ releases, installed })));")
    return json.loads(_node(script, ATTENTION, json.dumps([RELEASES, installed]), rt=rt))


@needs_node
def test_one_item_for_the_newest_newer_tag(tmp_path):
    items = _items(tmp_path, "0.5.0")
    assert len(items) == 1, items
    assert items[0]["kind"] == "release" and items[0]["action"]["tag"] == "v0.10.1"
    assert items[0]["text"] == "Release v0.10.1 is ready to apply (2 newer releases)"


@needs_node
def test_nothing_newer_means_no_item(tmp_path):
    assert _items(tmp_path, "0.10.1") == []


@needs_node
def test_list_updates_marks_older_pending(tmp_path):
    (tmp_path / "state").mkdir()
    (tmp_path / "state" / "updates.json").write_text(json.dumps({"releases": RELEASES}), encoding="utf-8")
    installed = json.loads((ASSEMBLY / "botcorp.json").read_text(encoding="utf-8"))["version"]
    out = json.loads(_node("const { listUpdates } = await import(process.argv[1]); console.log(JSON.stringify(await listUpdates()));",
                           UPDATES, rt=tmp_path))
    assert out["installed"] == installed
    older = {r["tag"]: r["older"] for r in out["releases"]}
    assert older["v0.1.11"] is True and older["v0.2.13"] is True and older["v0.10.1"] is False
    assert older[f"v{installed}"] is True
