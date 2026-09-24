"""cli/botcorp.mjs export/adopt contract, driven through node.

`export`/`import`/`adopt` resolve bot folders under ROOT/bots (ROOT is the
BotCorp checkout, resolved from cli/_lib.mjs's own __dirname — NOT from
BOTCORP_HOME, which is only the machine runtime dir). This suite must never
write into ROOT/bots, so every case here either reads source only or runs
`adopt --dry-run` (which never touches disk) against a synthetic `tmp_path`
source.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
CLI = ASSEMBLY / "cli" / "botcorp.mjs"

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")


def _node(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["node", str(CLI), *args], capture_output=True, text=True,
                          cwd=str(ASSEMBLY), timeout=60)


def test_export_skip_dirs_and_import_drop_git():
    """The behaviour (a real export/import round-trip) can't be exercised
    without writing into ROOT/bots, which this suite must never touch, so this
    asserts the source directly instead."""
    text = CLI.read_text(encoding="utf-8")
    line = next(
        ln for ln in text.splitlines()
        if ln.strip().startswith("const EXPORT_SKIP_DIRS = new Set(")
    )
    assert "'.git'" in line
    assert "rel.startsWith('.git/')" in text


def test_adopt_dry_run_leaves_git_and_secrets_behind(tmp_path):
    old = tmp_path / "old"
    (old / ".git").mkdir(parents=True)
    (old / ".git" / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
    (old / ".env").write_text("FOO=bar\n", encoding="utf-8")
    (old / ".claude").mkdir(parents=True, exist_ok=True)
    (old / ".claude" / ".oauth_token").write_text("secret\n", encoding="utf-8")
    (old / "token.json").write_text("{}\n", encoding="utf-8")
    (old / "CLAUDE.md").write_text("# old bot\n", encoding="utf-8")
    (old / "memory").mkdir(parents=True, exist_ok=True)
    (old / "memory" / "MEMORY.md").write_text("# memory\n", encoding="utf-8")
    (old / ".claude" / "settings.json").write_text(
        '{"model":"claude-sonnet-5","permissions":{"defaultMode":"bypassPermissions"}}\n',
        encoding="utf-8",
    )

    r = _node("adopt", str(old), "--as", "zz-adopt-test", "--dry-run")
    assert r.returncode == 0, r.stderr

    assert "leave  .git/" in r.stdout
    assert "leave  .env" in r.stdout
    assert "leave  token.json" in r.stdout
    assert "copy   CLAUDE.md" in r.stdout
    assert "copy   memory/" in r.stdout
    assert "model: claude-sonnet-5" in r.stdout
    assert "not implemented" not in r.stdout

    assert not (ASSEMBLY / "bots" / "zz-adopt-test").exists()


def test_adopt_missing_source_fails(tmp_path):
    missing = tmp_path / "nonexistent"
    r = _node("adopt", str(missing), "--as", "example")
    assert r.returncode == 1
    assert "is not a directory" in (r.stdout + r.stderr)
