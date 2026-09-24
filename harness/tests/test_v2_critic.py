"""Smoke test for the v2 critic wiring.

Verifies:
  1. harness/agents/critic.md exists with valid YAML frontmatter
     (name=critic, model=claude-sonnet-5, non-empty description, body text)
  2. tools/v2/critic.py runs without traceback
  3. critic.py returns valid JSON with the expected backwards-compat envelope
     (status="manual-only", claims=list, overall_score, task_file, result_file)

The critic's actual scoring is performed by the Claude Code subagent defined
in harness/agents/critic.md — invoked via the harness, not the Anthropic SDK.
This test only validates the wiring, not the model output.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

HARNESS_ROOT = Path(__file__).resolve().parents[1]
CRITIC_PY = HARNESS_ROOT / "tools" / "v2" / "critic.py"
CRITIC_MD = HARNESS_ROOT / "agents" / "critic.md"

FAKE_TASK = "Implement user login form with email + password fields. Submit to /api/auth/login. Validate before submit."
FAKE_RESULT = (
    "I added the form to login.tsx with email/password fields.\n"
    "- Added LoginForm component at src/components/LoginForm.tsx:1\n"
    "- All 18 existing tests still pass.\n"
)


def _parse_frontmatter(md_text: str) -> tuple[dict[str, str], str]:
    """Hand-rolled YAML-frontmatter split, to avoid a yaml dependency."""
    if not md_text.startswith("---\n") and not md_text.startswith("---\r\n"):
        return {}, md_text
    rest = md_text.split("\n", 1)[1]
    end = rest.find("\n---\n") if "\n---\n" in rest else rest.find("\n---\r\n")
    if end == -1:
        return {}, md_text
    raw = rest[:end]
    body = rest[end:].split("\n", 2)[-1]
    fields: dict[str, str] = {}
    for line in raw.splitlines():
        line = line.rstrip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        k, _, v = line.partition(":")
        fields[k.strip()] = v.strip()
    return fields, body


def test_critic_md_frontmatter():
    assert CRITIC_MD.exists(), f"harness/agents/critic.md missing at {CRITIC_MD}"
    text = CRITIC_MD.read_text(encoding="utf-8", errors="replace")
    fields, body = _parse_frontmatter(text)
    assert fields, "critic.md: no YAML frontmatter detected"
    assert fields.get("name") == "critic"
    assert fields.get("model") == "claude-sonnet-5"
    assert len(fields.get("description", "")) >= 30
    assert len(body.strip()) >= 100


def test_critic_py_emits_backwards_compat_envelope(tmp_path):
    task_file = tmp_path / "task.txt"
    result_file = tmp_path / "result.txt"
    task_file.write_text(FAKE_TASK, encoding="utf-8")
    result_file.write_text(FAKE_RESULT, encoding="utf-8")

    proc = subprocess.run(
        [sys.executable, str(CRITIC_PY), "score", str(task_file), str(result_file)],
        capture_output=True, text=True, encoding="utf-8",
    )
    assert proc.returncode == 0, proc.stderr

    data = json.loads(proc.stdout)
    for key in ("status", "claims", "overall_score", "task_file", "result_file"):
        assert key in data, f"missing key: {key!r}"
    assert isinstance(data["claims"], list)
    assert data["status"] == "manual-only"
