"""QA pack B 8: the leftovers from pack A.

Locked behaviour:
- `remote_control` is gone from the cockpit's source (cards.ts, settings.ts),
  its built bundle and docs/cockpit.md, like everywhere else since pack A;
- the session-summarize Stop hook runs only with module session_summarize
  (on by default): the exact hooks.json command writes no snapshot without it;
"""
from __future__ import annotations

import json
import os
import subprocess

from test_operator_only import ASSEMBLY, needs_node

WEB = ASSEMBLY / "cockpit" / "web"
HOOKS = ASSEMBLY / "harness" / "hooks"


def _stop_hook(name: str) -> list[str]:
    stop = json.loads((HOOKS / "hooks.json").read_text(encoding="utf-8"))["hooks"]["Stop"][0]["hooks"]
    h = next(h for h in stop if h["args"][1] == name)
    return [h["command"], *(a.replace("${CLAUDE_PLUGIN_ROOT}", str(ASSEMBLY / "harness")) for a in h["args"])]


def test_remote_control_is_gone_from_the_cockpit_and_its_doc():
    src = [str(p.relative_to(ASSEMBLY)) for p in (WEB / "src").rglob("*")
           if p.is_file() and p.suffix in (".ts", ".tsx") and ".test." not in p.name
           and "remote_control" in p.read_text(encoding="utf-8", errors="replace")]
    dist = [str(p.relative_to(ASSEMBLY)) for p in (WEB / "dist").rglob("*.js")
            if "remote_control" in p.read_text(encoding="utf-8", errors="replace")]
    assert src == [] and dist == [], src + dist
    assert "Remote Control" not in (ASSEMBLY / "docs" / "cockpit.md").read_text(encoding="utf-8")


@needs_node
def test_session_summarize_runs_only_with_its_module(tmp_path):
    args = _stop_hook("session-summarize")
    for mods, want in (("telegram", False), ("telegram,session_summarize", True)):
        home = tmp_path / mods.replace(",", "_")
        (home / "memory").mkdir(parents=True)
        env = {**os.environ, "BOT_HOME": str(home), "BOT_NAME": home.name, "BOTCORP_HOME": str(tmp_path / "rt"),
               "BOT_MODULES": mods, "BOT_TG_MUTE": "1", "PYTHONIOENCODING": "utf-8"}
        r = subprocess.run(args, capture_output=True, text=True, timeout=120, env=env, cwd=str(home))
        assert r.returncode == 0, r.stderr
        snaps = list((home / "memory" / "sessions").glob("*.md")) if (home / "memory" / "sessions").exists() else []
        assert bool(snaps) is want, (mods, snaps, r.stderr)
