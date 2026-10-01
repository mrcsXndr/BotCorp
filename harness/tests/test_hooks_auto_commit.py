"""Fake-stdin tests for harness/hooks/auto-commit.mjs.

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
        ["node", str(HARNESS / "hooks" / "auto-commit.mjs")],
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


# v0.8.6 R13: runtime churn (memory/metrics/) never commits on its own, and
# one checkpoint per BOT_AUTO_COMMIT_EVERY_MIN at most.
def _churn(home, n="1"):
    (home / "memory" / "metrics").mkdir(parents=True, exist_ok=True)
    (home / "memory" / "metrics" / "usage_state.json").write_text(f'{{"n": {n}}}\n', encoding="utf-8")


def _status(home):
    return subprocess.run(["git", "status", "--porcelain"], cwd=home, capture_output=True, text=True).stdout


def test_churn_alone_never_commits(tmp_path):
    home = _git_repo(tmp_path / "root" / "bots" / "demo")
    _churn(home)
    proc = _run(_env(tmp_path, home), cwd=home)
    assert proc.returncode == 0, proc.stderr
    assert _commits(home) == "1"
    assert "memory/" in _status(home)


def test_churn_rides_along_with_a_real_change(tmp_path):
    home = _git_repo(tmp_path / "root" / "bots" / "demo")
    _churn(home)
    (home / "notes.md").write_text("real\n", encoding="utf-8")
    proc = _run(_env(tmp_path, home), cwd=home)
    assert proc.returncode == 0, proc.stderr
    assert _commits(home) == "2"
    assert _status(home) == ""


def test_a_second_stop_inside_the_window_waits(tmp_path):
    home = _git_repo(tmp_path / "root" / "bots" / "demo")
    (home / "notes.md").write_text("one\n", encoding="utf-8")
    assert _run(_env(tmp_path, home), cwd=home).returncode == 0
    assert _commits(home) == "2"
    (home / "notes.md").write_text("two\n", encoding="utf-8")
    assert _run(_env(tmp_path, home), cwd=home).returncode == 0
    assert _commits(home) == "2"
    assert "notes.md" in _status(home)  # kept in the work tree, not dropped
    # past the window (0 = no window) the waiting change is committed
    assert _run(_env(tmp_path, home, BOT_AUTO_COMMIT_EVERY_MIN="0"), cwd=home).returncode == 0
    assert _commits(home) == "3"
    assert _status(home) == ""


# v0.9.13: on a live Windows bot the bash hook ran at p95 28 s of its 30 s budget,
# while its git work takes ~0.2 s: the rest was Git Bash start-up and forks. The
# hook is node now and run.mjs starts it without bash: here no bash exists at all
# (PATH holds only git's own folder, the Git install run.mjs looks in is empty),
# and the Stop hook, run exactly as hooks.json declares it, still commits.
def test_the_stop_hook_commits_with_no_bash_on_the_box(tmp_path):
    import json
    import shutil
    import sys
    from pathlib import Path
    home = _git_repo(tmp_path / "root" / "bots" / "demo")
    (home / "memory.md").write_text("dirty\n", encoding="utf-8")
    git, node = shutil.which("git"), shutil.which("node")
    if sys.platform == "win32":
        gitdir = Path(git).parent
    else:
        gitdir = tmp_path / "gitonly"
        gitdir.mkdir()
        (gitdir / "git").symlink_to(git)
    assert not any((gitdir / b).exists() for b in ("bash", "bash.exe"))     # the precondition: no bash to find
    env = {k: v for k, v in _env(tmp_path, home, BOT_MODULES="auto_commit").items()
           if k.upper() not in ("PATH", "PROGRAMFILES", "CLAUDE_CODE_GIT_BASH_PATH")}
    env.update(PATH=str(gitdir), ProgramFiles=str(tmp_path / "no-program-files"))
    stop = next(h for g in json.loads((HARNESS / "hooks" / "hooks.json").read_text(encoding="utf-8"))["hooks"]["Stop"]
                for h in g["hooks"] if h["args"][1] == "auto-commit")
    proc = subprocess.run([node, str(HARNESS / "hooks" / "run.mjs"), *stop["args"][1:]],
                          input="{}", capture_output=True, text=True, env=env, cwd=home, timeout=60)
    assert proc.returncode == 0, proc.stderr
    assert _commits(home) == "2"
    assert _status(home) == ""


def _sync(home, env):
    return subprocess.run(
        ["node", str(HARNESS / "tools" / "infra" / "memory-sync-hook.cjs")],
        input='{"hook_event_name": "Stop", "session_id": "abcdef1234"}', capture_output=True, text=True, env=env, timeout=60,
    )


# The memory-sync committer obeys the same gate (its own marker, its own window).
def test_memory_sync_holds_churn_and_honours_the_window(tmp_path):
    home = _git_repo(tmp_path / "root" / "bots" / "demo")
    env = _env(tmp_path, home)
    _churn(home)
    assert _sync(home, env).returncode == 0
    assert _commits(home) == "1"
    (home / "memory" / "notes.md").write_text("real\n", encoding="utf-8")
    assert _sync(home, env).returncode == 0  # commits, then the pull fails: no origin
    assert _commits(home) == "2"
    assert "auto: memory sync" in subprocess.run(["git", "log", "-1", "--format=%s"], cwd=home, capture_output=True, text=True).stdout
    (home / "memory" / "notes.md").write_text("more\n", encoding="utf-8")
    assert _sync(home, env).returncode == 0
    assert _commits(home) == "2"
    env["BOT_AUTO_COMMIT_EVERY_MIN"] = "0"
    assert _sync(home, env).returncode == 0
    assert _commits(home) == "3"
