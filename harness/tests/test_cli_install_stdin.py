"""`botcorp install` password intake (cli/botcorp.mjs cmdInstall + daemon/install.ps1).

Locked after the reference host's install hung on a hidden prompt in an
elevated, console-less context: the password comes from PIPED STDIN (or a
hidden prompt on a real TTY), never from argv; with no TTY and nothing on
stdin the command fails fast; S4U is only ever explicit (--s4u), never a
silent fallback. Every case here runs `--dry-run`, which registers nothing.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
CLI = ASSEMBLY / "cli" / "botcorp.mjs"

pytestmark = pytest.mark.skipif(
    sys.platform != "win32" or shutil.which("pwsh") is None or shutil.which("node") is None,
    reason="Windows only (install.ps1) with pwsh and node on PATH",
)


def _cli(tmp_path, *args, stdin=None, devnull=False):
    env = {**os.environ, "BOTCORP_HOME": str(tmp_path / "home")}
    kw = {"stdin": subprocess.DEVNULL} if devnull else {"input": stdin}
    return subprocess.run(["node", str(CLI), *args], capture_output=True, text=True, timeout=120,
                          cwd=str(ASSEMBLY), env=env, **kw)


def test_piped_password_dry_run_registers_password_logon_without_a_prompt(tmp_path):
    r = _cli(tmp_path, "install", "--dry-run", stdin="value-for-tests-1234\n")
    assert r.returncode == 0, r.stderr + r.stdout
    text = r.stdout + r.stderr
    assert "LogonType Password" in text
    assert "provided, 20 chars" in text
    assert "Nothing registered" in text
    assert "Password for" not in text          # the hidden prompt never appeared
    assert "value-for-tests-1234" not in text  # the value is never echoed


def test_no_tty_and_no_stdin_fails_fast_with_the_pipe_hint(tmp_path):
    t0 = time.monotonic()
    r = _cli(tmp_path, "install", "--dry-run", devnull=True)
    took = time.monotonic() - t0
    assert r.returncode != 0
    assert took < 5, f"took {took:.1f}s (a prompt would hang)"
    assert "stdin" in (r.stdout + r.stderr)
    assert "--s4u" in (r.stdout + r.stderr)


def test_password_on_argv_is_refused_with_the_pipe_hint(tmp_path):
    for argv in (["install", "-Password", "x", "--dry-run"], ["install", "--password", "x", "--dry-run"]):
        r = _cli(tmp_path, *argv, stdin="value-for-tests-1234\n")
        assert r.returncode != 0, argv
        assert "command line" in (r.stdout + r.stderr)
        assert "stdin" in (r.stdout + r.stderr)


def test_s4u_is_explicit_only(tmp_path):
    r = _cli(tmp_path, "install", "--s4u", "--dry-run", devnull=True)
    assert r.returncode == 0, r.stderr + r.stdout
    assert "LogonType S4U" in (r.stdout + r.stderr)
    # an empty piped password is an error, not S4U
    r = _cli(tmp_path, "install", "--dry-run", stdin="\n")
    assert r.returncode != 0
    assert "DRYRUN" not in (r.stdout + r.stderr)   # never reached install.ps1 as S4U
    assert "--s4u" in (r.stdout + r.stderr)
