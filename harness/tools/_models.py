"""_models.py — model ids and prices from harness/models.json, the one source.

    tier_id("workhorse")  -> the tier's pinned id; the Claude Code alias of its
                             family ("sonnet") when models.json is unreadable
    tier_prices()         -> {family: price_per_mtok}, family = opus | sonnet | haiku | fable
"""
from __future__ import annotations

import json
from pathlib import Path

MODELS_JSON = Path(__file__).resolve().parents[1] / "models.json"
_ALIAS = {"top": "opus", "workhorse": "sonnet", "tiny": "haiku", "hyper": "fable"}


def _tiers() -> dict:
    try:
        return json.loads(MODELS_JSON.read_text(encoding="utf-8")).get("tiers") or {}
    except Exception:
        return {}


def tier_id(tier: str) -> str:
    return str((_tiers().get(tier) or {}).get("id") or _ALIAS.get(tier, "sonnet"))


def tier_prices() -> dict:
    out = {}
    for t in _tiers().values():
        fam = next((f for f in ("opus", "sonnet", "haiku", "fable") if f in str(t.get("id", ""))), None)
        if fam and isinstance(t.get("price_per_mtok"), dict):
            out[fam] = t["price_per_mtok"]
    return out
