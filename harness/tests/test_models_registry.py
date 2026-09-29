"""harness/models.json is the single source of truth for model routing.

Checks that every harness/agents/*.md frontmatter agrees with it (model id and
effort), that every agent named in models.json has a file, that no agent file is
missing from models.json, and that harness/rules/models.md names each tier id.
"""
from __future__ import annotations

import json
from pathlib import Path

HARNESS_ROOT = Path(__file__).resolve().parents[1]
MODELS_JSON = HARNESS_ROOT / "models.json"
MODELS_MD = HARNESS_ROOT / "rules" / "models.md"
AGENTS_DIR = HARNESS_ROOT / "agents"


def _frontmatter(path: Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8").replace("\r\n", "\n")
    assert text.startswith("---\n"), f"{path.name}: no frontmatter"
    raw = text[4:].split("\n---\n", 1)[0]
    fields: dict[str, str] = {}
    for line in raw.splitlines():
        if ":" in line and not line.startswith("#"):
            k, _, v = line.partition(":")
            fields[k.strip()] = v.strip()
    return fields


def _registry() -> dict:
    return json.loads(MODELS_JSON.read_text(encoding="utf-8"))


def test_every_registered_agent_exists():
    for name in _registry()["agents"]:
        assert (AGENTS_DIR / f"{name}.md").exists(), f"models.json names {name} but agents/{name}.md is missing"


def test_every_agent_file_is_registered():
    registered = set(_registry()["agents"])
    on_disk = {p.stem for p in AGENTS_DIR.glob("*.md")}
    assert on_disk == registered, f"agents not in models.json: {on_disk - registered}; missing files: {registered - on_disk}"


def test_agent_frontmatter_matches_registry():
    reg = _registry()
    for name, tier_key in reg["agents"].items():
        tier = reg["tiers"][tier_key]
        fields = _frontmatter(AGENTS_DIR / f"{name}.md")
        assert fields.get("model") == tier["id"], f"{name}: model {fields.get('model')!r} != {tier['id']!r}"
        if tier["effort"] is None:
            assert "effort" not in fields, f"{name}: tier {tier_key} has no effort setting but the file sets one"
        else:
            assert fields.get("effort") == tier["effort"], f"{name}: effort {fields.get('effort')!r} != {tier['effort']!r}"


def test_models_md_names_every_tier_id():
    md = MODELS_MD.read_text(encoding="utf-8")
    for key, tier in _registry()["tiers"].items():
        assert tier["id"] in md, f"rules/models.md does not mention tier {key} id {tier['id']}"
