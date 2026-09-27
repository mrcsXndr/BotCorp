"""Fake-stdin integration tests for harness/hooks/vault-guard.sh.

Same pattern as test_hooks_fake_stdin.py: run the hook with `bash` from a
throwaway git-initialised BOT_HOME, feeding it the JSON payload Claude Code
would send on stdin, and assert on exit code + stderr.
"""
from __future__ import annotations

import json

from test_hooks_fake_stdin import HARNESS, HOOKS, base_env, bot_home, run_hook  # noqa: F401


def _run(env, tool_input, args=None):
    payload = json.dumps({"tool_input": tool_input})
    return run_hook("vault-guard.sh", env, payload, args=args)


# (a) another bot's vault, reached via a relative path
def test_blocks_other_bot_vault(tmp_path, bot_home):
    env = base_env(tmp_path, bot_home)
    proc = _run(env, {"file_path": str(bot_home / ".." / "other-bot" / ".vault" / "secrets.json")})
    assert proc.returncode == 2
    assert "BLOCKED" in proc.stderr


# (b) this bot's own vault
def test_blocks_own_vault(tmp_path, bot_home):
    env = base_env(tmp_path, bot_home)
    proc = _run(env, {"file_path": str(bot_home / ".vault" / "secrets.json")})
    assert proc.returncode == 2
    assert "BLOCKED" in proc.stderr


# (c) secrets CLI mutating verb via Bash, invoked through node directly
def test_blocks_secrets_get_command(tmp_path, bot_home):
    env = base_env(tmp_path, bot_home)
    proc = _run(env, {"command": "node cli/botcorp.mjs secrets get demo oauth_token"})
    assert proc.returncode == 2
    assert "BLOCKED" in proc.stderr


# (d) secrets CLI read-only verb is allowed
def test_allows_secrets_list_command(tmp_path, bot_home):
    env = base_env(tmp_path, bot_home)
    proc = _run(env, {"command": "botcorp secrets list demo"})
    assert proc.returncode == 0
    assert proc.stdout == ""


# (e) an ordinary file is allowed
def test_allows_ordinary_file(tmp_path, bot_home):
    env = base_env(tmp_path, bot_home)
    proc = _run(env, {"file_path": str(bot_home / "memory" / "TDL.md")})
    assert proc.returncode == 0
    assert proc.stdout == ""


# (f) Grep pattern naming the DPAPI API
def test_blocks_protecteddata_pattern(tmp_path, bot_home):
    env = base_env(tmp_path, bot_home)
    proc = _run(env, {"pattern": "ProtectedData"})
    assert proc.returncode == 2
    assert "BLOCKED" in proc.stderr


# (g) Windows-style backslash path
def test_blocks_windows_backslash_vault_path(tmp_path, bot_home):
    env = base_env(tmp_path, bot_home)
    proc = _run(env, {"file_path": "C:\\x\\bots\\demo\\.vault\\secrets.json"})
    assert proc.returncode == 2
    assert "BLOCKED" in proc.stderr


# (h) empty stdin
def test_empty_stdin_is_silent(tmp_path, bot_home):
    env = base_env(tmp_path, bot_home)
    proc = run_hook("vault-guard.sh", env, "")
    assert proc.returncode == 0
    assert proc.stdout == ""


# (i) v0.7.3: a payload it cannot parse blocks (it used to exit 0)
def test_unparseable_payload_fails_closed(tmp_path, bot_home):
    env = base_env(tmp_path, bot_home)
    for payload in ('{"tool_input": {"file_path": ".vault/secrets.json"', "[1, 2]", '{"tool_input": "x"}'):
        proc = run_hook("vault-guard.sh", env, payload)
        assert proc.returncode == 2, payload
        assert "could not parse" in proc.stderr


# (j) v0.7.3: no working interpreter is a parse failure too
def test_broken_python_fails_closed(tmp_path, bot_home):
    env = base_env(tmp_path, bot_home, {"BOT_PYTHON": str(tmp_path / "no-such-python")})
    proc = _run(env, {"file_path": str(bot_home / "memory" / "TDL.md")})
    assert proc.returncode == 2
    assert "could not parse" in proc.stderr


# (k) positive control for (i)/(j): a valid payload with nothing to inspect stays silent
def test_valid_payload_without_paths_is_silent(tmp_path, bot_home):
    env = base_env(tmp_path, bot_home)
    proc = _run(env, {"description": "x"})
    assert proc.returncode == 0 and proc.stderr == ""
