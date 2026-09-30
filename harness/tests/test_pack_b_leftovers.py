"""QA pack B 8: the leftovers from pack A.

Locked behaviour:
- `remote_control` is gone from the cockpit's source (cards.ts, settings.ts),
  its built bundle and docs/cockpit.md, like everywhere else since pack A;
- the session-summarize Stop hook runs only with module session_summarize
  (on by default): the exact hooks.json command writes no snapshot without it;
- the Tools tab's hook list (cli/tools.mjs toolInventory) is hooks.json's
  run.mjs names plus the tool guards, the same list harness.hooks_disable
  accepts, each with a purpose read from the script it runs.
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


@needs_node
def test_the_tools_tab_lists_the_hooks_hooks_json_runs(tmp_path):
    home = tmp_path / "bots" / "t"
    home.mkdir(parents=True)
    (home / "bot.yaml").write_text("name: t\nharness:\n  hooks_disable: [cost-meter]\n", encoding="utf-8")
    js = (
        "const [tools, botyaml, home, root] = process.argv.slice(1);"
        "const { toolInventory } = await import(tools); const { loadBotYaml, hookNames } = await import(botyaml);"
        "const inv = toolInventory({ botHome: home, cfg: loadBotYaml(home + '/bot.yaml'), botcorpRoot: root });"
        "const s = inv.groups.find((g) => g.source === 'harness').sections.find((x) => x.kind === 'hook');"
        "console.log(JSON.stringify({ names: hookNames(), hooks: s.items }));"
    )
    env = {**os.environ, "BOTCORP_HOME": str(tmp_path / "rt"), "BOTCORP_BOTS_DIR": str(tmp_path / "bots")}
    r = subprocess.run(["node", "--input-type=module", "-e", js, (ASSEMBLY / "cli" / "tools.mjs").as_uri(),
                        (ASSEMBLY / "daemon" / "botyaml.mjs").as_uri(), str(home), str(ASSEMBLY)],
                       capture_output=True, text=True, timeout=60, env=env, cwd=str(ASSEMBLY))
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    hooks = {h["name"]: h for h in out["hooks"]}
    assert sorted(hooks) == out["names"]
    assert {"session-summarize", "cost-meter", "precompact-extract", "precompact-timeline"} <= set(hooks)
    assert [n for n, h in hooks.items() if not h["description"]] == []
    assert hooks["cost-meter"]["on"] is False and hooks["cost-meter"]["toggle"] == {"list": "harness.hooks_disable", "item": "cost-meter"}
    assert hooks["vault-guard"]["toggle"] is None and hooks["vault-guard"]["locked"]
