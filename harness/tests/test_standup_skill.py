"""The /standup skill: one skill + page template for every bot, public-safe.

Locked behaviour:
- harness/skills/standup/{SKILL.md, board.html} exist; SKILL.md keeps the
  per-bot context/standup.md config, the read-answers-back step, the
  ArtifactData board and the 2-line Telegram pointer, and never implies a
  default timer (a schedule is per-bot and opt-in);
- the template declares and uses the db and user capabilities, carries the
  logo as the published file logo.png, uses generic localStorage keys, holds
  no item data and no artifact URL;
- neither file contains an identity string (debrand-lint's own patterns);
- harness/rules/telegram.md carries the `/<name>` -> skill rule, and every
  tg_commands HANDLERS name is reserved there and collides with no harness skill.
"""
from __future__ import annotations

import importlib.util
import re
from pathlib import Path

import tg_commands

ASSEMBLY = Path(__file__).resolve().parents[2]
SKILL_DIR = ASSEMBLY / "harness" / "skills" / "standup"
SKILL = SKILL_DIR / "SKILL.md"
BOARD = SKILL_DIR / "board.html"
TG_RULE = ASSEMBLY / "harness" / "rules" / "telegram.md"


def _lint():
    spec = importlib.util.spec_from_file_location("debrand_lint", ASSEMBLY / "scripts" / "debrand-lint.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_skill_and_template_exist_with_the_kept_steps():
    s = SKILL.read_text(encoding="utf-8")
    assert s.startswith("---\nname: standup\n")
    for kept in ("context/standup.md", "board_url:", "Read answers back first", "ArtifactData",
                 "2 lines max", "board.html", "{db: {}, user: {}}"):
        assert kept in s, kept
    sched = s.split("## Schedule", 1)[1].split("\n## ", 1)[0]
    assert "On request is the default" in sched and "Optional:" in sched and "automations:" in sched
    assert BOARD.is_file()


def test_template_declares_db_and_user_and_stays_generic():
    h = BOARD.read_text(encoding="utf-8")
    assert h.startswith("<title>")
    assert "capabilities {db: {}, user: {}}" in h
    assert 'c.use("db")' in h and 'c.use("user")' in h
    assert 'src="logo.png"' in h
    keys = set(re.findall(r'localStorage\.(?:get|set)Item\("([^"]+)"', h))
    assert keys == {"standup-board-lens", "standup-board-area"}, keys
    assert "claude.ai/" not in h
    # no baked-in rows: items only ever come from the db collection
    assert '"title":' not in h and "items=[]" in h


def test_template_only_links_http_and_checks_brand_values():
    h = BOARD.read_text(encoding="utf-8")
    assert "/^https?:\\/\\//i.test(it.link" in h
    assert "COLOR.test(b.accent" in h and "FONT.test(b.font" in h


def test_no_identity_strings_in_the_skill():
    lint = _lint()
    pats = [(n, re.compile(p, re.I)) for n, p in lint.IDENTITY]
    # positive control: the patterns fire on the linter's own identity fixtures
    fixtures = [(n, t) for n, t in lint.FIXTURES if n.startswith("identity:")]
    assert fixtures and all(any(p.search(t) for _, p in pats) for _, t in fixtures)
    for f in (SKILL, BOARD):
        text = f.read_text(encoding="utf-8")
        hits = [(n, m.group(0)) for n, p in pats for m in p.finditer(text)]
        assert not hits, f"{f.name}: {hits}"


def test_telegram_rule_maps_slash_names_to_skills_and_reserves_handlers():
    rule = TG_RULE.read_text(encoding="utf-8")
    sec = rule.split("## Slash commands that run a skill", 1)
    assert len(sec) == 2, "telegram.md lost the slash-command-to-skill rule"
    body = sec[1].split("\n## ", 1)[0]
    assert "exactly `/<name>`" in body and "starts with `/<name> `" in body
    assert "botcorp:<name>" in body and "reserved" in body
    names = sorted(tg_commands.HANDLERS)
    assert names, "tg_commands.HANDLERS is empty"
    for n in names:
        assert f"`{n}`" in rule, f"{n} is not listed as reserved in telegram.md"
    skills = {d.name for d in (ASSEMBLY / "harness" / "skills").iterdir() if d.is_dir()}
    assert not {n.lstrip("/") for n in names} & skills
