"""QA pack C 3: model ids and prices come from harness/models.json only.

Locked behaviour:
- no code file under harness/, daemon/ or cli/ (tests excluded; models.json,
  the agent frontmatter, rules and docs are not code) names a literal
  claude-<family>-<digits> id: every model a tool picks is a tier of
  models.json (ALLOW is the explicit exception list, empty today);
- the alert-triage run uses the workhorse tier (BOT_TRIAGE_MODEL overrides);
- the cost meter's transcript fallback prices each family from the tier's
  price_per_mtok (a Fable turn is priced as Fable, not as Sonnet);
- harness/rules/models.md's price column matches models.json for every tier.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import alert_triage as at
import cost_meter
from test_v2_alert_triage import paths  # noqa: F401

ASSEMBLY = Path(__file__).resolve().parents[2]
MODELS = json.loads((ASSEMBLY / "harness" / "models.json").read_text(encoding="utf-8"))
LITERAL = re.compile(r"claude-(opus|sonnet|haiku|fable)-\d")
CODE = {".py", ".mjs", ".js", ".cjs", ".ts", ".sh", ".ps1"}
# path (relative, forward slashes) -> why the literal is needed; keep it small
ALLOW: dict[str, str] = {}


def _code_files():
    for top in ("harness", "daemon", "cli"):
        for f in (ASSEMBLY / top).rglob("*"):
            rel = f.relative_to(ASSEMBLY).as_posix()
            if not f.is_file() or f.suffix not in CODE:
                continue
            if "/tests/" in f"/{rel}" or "node_modules" in rel or "__pycache__" in rel:
                continue
            yield rel, f


def test_no_literal_model_id_in_code():
    hits = []
    for rel, f in _code_files():
        if rel in ALLOW:
            continue
        for n, line in enumerate(f.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            if LITERAL.search(line):
                hits.append(f"{rel}:{n}: {line.strip()[:120]}")
    assert not hits, "literal model ids (read harness/models.json instead):\n" + "\n".join(hits)


def test_the_scan_sees_the_code_it_guards():
    # positive control: the scan covers the files that held literals before
    seen = {rel for rel, _ in _code_files()}
    assert {"harness/tools/v2/alert_triage.py", "cli/botcorp.mjs", "harness/hooks/session-debrief.sh",
            "harness/tools/v2/cost_meter.py", "daemon/tick.ps1"} <= seen
    assert LITERAL.search('model = "' + MODELS["tiers"]["top"]["id"] + '"')


def test_triage_runs_on_the_workhorse_tier(paths, tmp_path, monkeypatch):  # noqa: F811
    monkeypatch.delenv("BOT_TRIAGE_MODEL", raising=False)
    seen = {}

    def fake_popen(cmd, **kw):
        seen["cmd"] = cmd
        raise RuntimeError("no spawn in tests")

    monkeypatch.setattr(at.subprocess, "Popen", fake_popen)
    pf = tmp_path / "p.txt"
    pf.write_text("x", encoding="utf-8")
    at.run(pf, tmp_path / "run.txt")
    cmd = seen["cmd"]
    assert cmd[cmd.index("--model") + 1] == MODELS["tiers"]["workhorse"]["id"]
    monkeypatch.setenv("BOT_TRIAGE_MODEL", "opus")
    at.run(pf, tmp_path / "run2.txt")
    assert seen["cmd"][seen["cmd"].index("--model") + 1] == "opus"


def test_cost_meter_prices_each_family_from_models_json(tmp_path):
    tiers = MODELS["tiers"]
    assert cost_meter.PRICING["fable"] == tiers["hyper"]["price_per_mtok"]
    assert cost_meter.PRICING["opus"] == tiers["top"]["price_per_mtok"]
    f = tmp_path / "t.jsonl"
    f.write_text(json.dumps({"type": "assistant", "timestamp": "2026-09-30T10:00:00Z", "message": {
        "model": tiers["hyper"]["id"], "usage": {"input_tokens": 1_000_000, "output_tokens": 1_000_000}}}) + "\n", encoding="utf-8")
    p = tiers["hyper"]["price_per_mtok"]
    assert abs(cost_meter._price_jsonl(f)["usd"] - (p["input"] + p["output"])) < 1e-9


def test_unpriced_transcript_is_flagged_not_silent(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(cost_meter, "PRICING", {})
    f = tmp_path / "t.jsonl"
    f.write_text(json.dumps({"type": "assistant", "timestamp": "2026-09-30T10:00:00Z", "message": {
        "model": "claude-opus-5-5", "usage": {"input_tokens": 1000, "output_tokens": 1000}}}) + "\n", encoding="utf-8")
    t = cost_meter._price_jsonl(f)
    assert t["usd"] == 0.0 and t.get("unpriced") is True
    assert "no prices" in capsys.readouterr().err


def test_models_md_prices_match_models_json():
    md = (ASSEMBLY / "harness" / "rules" / "models.md").read_text(encoding="utf-8")
    for key, t in MODELS["tiers"].items():
        p = t["price_per_mtok"]
        row = re.search(rf"^\| {re.escape(t['name'])} \|.*\| \$([\d.]+) / \$([\d.]+) \|$", md, re.M)
        assert row, f"rules/models.md has no price row for {t['name']}"
        assert (float(row.group(1)), float(row.group(2))) == (p["input"], p["output"]), key
