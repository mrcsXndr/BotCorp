"""Fake-stdin tests for harness/hooks/auto-commit.sh.

The Stop hook must commit ONLY inside the bot's own home (`bots/<name>/`, as
the launcher's BOT_HOME/BOT_NAME name it) when that folder is a git repo and
the session cwd is inside it. It once fired under `--plugin-dir` smoke runs
and committed into whatever repo the session sat in.
"""
from __future__ import annotations

import subprocess

from test_hooks_fake_stdin import HARNESS, base_env  # noqa: F401


def _git_repo(path):
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=path, check=True)
    (path / "README.md").write_text("seed\n", encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=path, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "seed"], cwd=path, check=True)
    return path


def _commits(path):
    return subprocess.run(
        ["git", "rev-list", "--count", "HEAD"], cwd=path, capture_output=True, text=True, check=True,
    ).stdout.strip()


def _env(tmp_path, bot_home, **overrides):
    env = base_env(tmp_path, bot_home, {"BOT_MODULES": "auto_commit"})
    for k, v in overrides.items():
        if v is None:
            env.pop(k, None)
        else:
            env[k] = v
    return env


def _run(env, cwd):
    return subprocess.run(
        ["bash", str(HARNESS / "hooks" / "auto-commit.sh")],
        input="{}", capture_output=True, text=True, env=env, cwd=cwd, timeout=60,
    )


def test_commits_inside_the_bots_own_home(tmp_path):
    home = _git_repo(tmp_path / "root" / "bots" / "demo")
    (home / "memory.md").write_text("dirty\n", encoding="utf-8")
    proc = _run(_env(tmp_path, home), cwd=home)
    assert proc.returncode == 0, proc.stderr
    assert _commits(home) == "2"
    assert subprocess.run(["git", "status", "--porcelain"], cwd=home, capture_output=True, text=True).stdout == ""


# The bug: a smoke run without the launch env, sitting in some other repo.
def test_foreign_git_repo_without_launch_env_is_a_noop(tmp_path):
    foreign = _git_repo(tmp_path / "other-project")
    (foreign / "work.txt").write_text("uncommitted\n", encoding="utf-8")
    env = _env(tmp_path, foreign, BOT_HOME=None, BOT_NAME=None, CLAUDE_PROJECT_DIR=str(foreign))
    proc = _run(env, cwd=foreign)
    assert proc.returncode == 0, proc.stderr
    assert _commits(foreign) == "1"
    assert "work.txt" in subprocess.run(["git", "status", "--porcelain"], cwd=foreign, capture_output=True, text=True).stdout


# Launch env present, but the session cwd is a different repo: still a no-op,
# in both directions (neither repo gets a commit).
def test_session_cwd_in_a_foreign_repo_is_a_noop(tmp_path):
    home = _git_repo(tmp_path / "root" / "bots" / "demo")
    foreign = _git_repo(tmp_path / "other-project")
    (home / "memory.md").write_text("dirty\n", encoding="utf-8")
    (foreign / "work.txt").write_text("uncommitted\n", encoding="utf-8")
    env = _env(tmp_path, home, CLAUDE_PROJECT_DIR=str(foreign))
    proc = _run(env, cwd=foreign)
    assert proc.returncode == 0, proc.stderr
    assert _commits(home) == "1"
    assert _commits(foreign) == "1"


# BOT_HOME that is not a bots/<BOT_NAME> folder (the _guard.sh cwd fallback
# shape) never commits, even when it is a dirty git repo.
def test_bot_home_outside_a_bots_folder_is_a_noop(tmp_path):
    home = _git_repo(tmp_path / "somewhere" / "demo")
    (home / "memory.md").write_text("dirty\n", encoding="utf-8")
    proc = _run(_env(tmp_path, home), cwd=home)
    assert proc.returncode == 0, proc.stderr
    assert _commits(home) == "1"


# A bot folder that is only a SUBDIRECTORY of a parent repo must not commit
# into that parent.
def test_bot_home_inside_a_parent_repo_is_a_noop(tmp_path):
    parent = _git_repo(tmp_path / "parent")
    home = parent / "bots" / "demo"
    home.mkdir(parents=True)
    (home / "memory.md").write_text("dirty\n", encoding="utf-8")
    proc = _run(_env(tmp_path, home), cwd=home)
    assert proc.returncode == 0, proc.stderr
    assert _commits(parent) == "1"
