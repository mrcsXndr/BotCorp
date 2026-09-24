"""cli/_lib.mjs system-binary resolution + the two doctor helpers that were
wrong on the reference host, evaluated under node against the real module.

Locked: every resolver returns an ABSOLUTE existing path on Windows (a bare
name spawned ENOENT from a Scheduled Task), `coversMesh` accepts the
dotted-mask RemoteAddress form the firewall cmdlets print, and the
coexist-task allowlist matches exact names and `*` globs case-insensitively.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
LIB = (ASSEMBLY / "cli" / "_lib.mjs").as_uri()

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")


def _node(expr: str) -> object:
    script = f"const m = await import({json.dumps(LIB)}); console.log(JSON.stringify({expr}));"
    r = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True,
                       timeout=120, cwd=str(ASSEMBLY))
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout.strip().splitlines()[-1])


def test_covers_mesh_accepts_cidr_dotted_mask_range_and_any():
    cases = {
        "Any": True,
        "100.96.0.0/12": True,
        "100.96.0.0/255.240.0.0": True,   # what Get-NetFirewallAddressFilter prints
        "100.64.0.0/10": True,
        "100.96.0.0-100.111.255.255": True,
        "100.100.0.0/16": False,
        "10.0.0.0/8": False,
        "100.96.0.0/255.255.0.0": False,
        "LocalSubnet": False,
    }
    got = _node(f"Object.fromEntries({json.dumps(list(cases))}.map((a) => [a, m.coversMesh(a)]))")
    assert got == cases


def test_matches_any_glob_names_and_globs_case_insensitive():
    pats = ["OtherBot-*", "exact-task"]
    got = _node(f"['OtherBot-Supervisor', 'otherbot-x', 'EXACT-TASK', 'BotCorp-Daemon', 'OtherBot'].map((n) => m.matchesAnyGlob(n, {json.dumps(pats)}))")
    assert got == [True, True, True, False, False]
    assert _node("m.matchesAnyGlob('x', [])") is False
    assert _node("m.matchesAnyGlob('a.b', ['a.b'])") is True
    assert _node("m.matchesAnyGlob('axb', ['a.b'])") is False


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only resolution")
def test_windows_resolvers_return_absolute_existing_paths():
    got = _node("({ pwsh: m.resolvePwsh(), py: m.resolvePython(), git: m.resolveGit(), tk: m.sysExe('taskkill.exe'), ps: m.POWERSHELL_EXE })")
    for key in ("pwsh", "git", "tk", "ps"):
        assert got[key] and Path(got[key]).is_absolute(), got
        assert Path(got[key]).is_file(), got
    assert got["tk"].lower().endswith("\\system32\\taskkill.exe")
    assert got["ps"].lower().endswith("\\windowspowershell\\v1.0\\powershell.exe")
    assert "WindowsApps\\python" not in got["pwsh"]
    py = got["py"]
    assert py and Path(py["file"]).is_absolute() and Path(py["file"]).is_file(), got
    assert py["version"].startswith("Python 3.")
    assert py["via"] in ("BOT_PYTHON", "py launcher", "PATH", "per-user install") or py["via"].startswith("registry PythonCore")
    assert "WindowsApps" not in py["file"]


def test_python_looked_in_names_every_location():
    s = _node("m.PYTHON_LOOKED_IN")
    for token in ("BOT_PYTHON", "py launcher", "PythonCore", "Programs\\\\Python", "PATH"):
        assert token.replace("\\\\", "\\") in s, s
