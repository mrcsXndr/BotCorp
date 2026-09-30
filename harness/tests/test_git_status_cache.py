"""QA pack A item 5: git status leaves the render path.

statusline.js ran two git processes on every render, and status_footer.py on
every footer. Both now read "(branch)" / "(branch*)" from one TTL cache,
<config_home>/botcorp/git-status.json, keyed by folder.

Locked behaviour:
- within GIT_TTL_S (30 s) a render reuses the cached segment, even after the
  tree changed; git runs again only once the entry is older than the TTL;
- the two tools share the cache: what one wrote, the other reads.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import time
from pathlib import Path

import pytest

import status_footer
from test_statusline_format import CTX, run_statusline

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git on PATH")


def _repo(tmp_path: Path) -> Path:
    repo = tmp_path / "mybot"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "symbolic-ref", "HEAD", "refs/heads/main"], cwd=repo, check=True)
    return repo


def _age_cache(cfg: Path, seconds: float) -> None:
    f = cfg / "botcorp" / "git-status.json"
    cache = json.loads(f.read_text(encoding="utf-8"))
    for v in cache.values():
        v["ts"] -= seconds
    f.write_text(json.dumps(cache), encoding="utf-8")


def test_statusline_reuses_git_status_within_the_ttl(tmp_path):
    repo, cfg = _repo(tmp_path), tmp_path / "cfg"
    payload = {"model": {"display_name": "Opus 5.5"}, "workspace": {"current_dir": str(repo)}, "context_window": CTX}
    assert run_statusline(repo, cfg, payload).startswith("mybot (main) · ")
    (repo / "new.txt").write_text("x", encoding="utf-8")                 # the tree is dirty now
    assert run_statusline(repo, cfg, payload).startswith("mybot (main) · ")   # cached: no git run
    _age_cache(cfg, 31)
    assert run_statusline(repo, cfg, payload).startswith("mybot (main*) · ")  # past the TTL: refreshed


def test_footer_reuses_and_shares_the_cache(tmp_path, monkeypatch):
    repo, cfg = _repo(tmp_path), tmp_path / "cfg"
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(cfg))
    monkeypatch.setattr(status_footer, "REPO_ROOT", repo)
    assert status_footer._git_status() == "(main)"
    (repo / "new.txt").write_text("x", encoding="utf-8")
    assert status_footer._git_status() == "(main)"
    _age_cache(cfg, 31)
    assert status_footer._git_status() == "(main*)"
    # the statusline reads the entry the footer just wrote (same folder key)
    (repo / "new.txt").unlink()
    payload = {"model": {"display_name": "Opus 5.5"}, "workspace": {"current_dir": str(repo)}, "context_window": CTX}
    assert run_statusline(repo, cfg, payload).startswith("mybot (main*) · ")
