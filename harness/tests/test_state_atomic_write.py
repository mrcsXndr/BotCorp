"""Code review 2026-09-30, L3 (daemon half): Write-JsonFile (daemon/_common.ps1)
replaces the file in one rename, so a reader never sees it truncated or half
written, which the CLI and the tick read as "no record". Also the launch-state
writer (vault.ps1 Update-VaultLaunchState): a torn state file is refused, not
rebuilt from nothing.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
COMMON = ASSEMBLY / "daemon" / "_common.ps1"

pytestmark = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None, reason="Windows with pwsh on PATH")


def _env(tmp_path: Path) -> dict:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "TELEGRAM_", "BOT_"))}
    env.update({"BOTCORP_HOME": str(tmp_path / "rt"), "BOTCORP_BOTS_DIR": str(tmp_path / "bots"), "BOTCORP_ROOT": str(ASSEMBLY), "BOT_TG_MUTE": "1"})
    (tmp_path / "rt" / "state").mkdir(parents=True, exist_ok=True)
    (tmp_path / "bots").mkdir(exist_ok=True)
    return env


def test_write_jsonfile_never_shows_a_partial_file(tmp_path):
    target = tmp_path / "rt" / "state" / "demo.json"
    body = (f". '{COMMON}'\n"
            f"$o = [ordered]@{{ bot = 'demo'; bg_id = 'abc123'; pad = ('x' * 200000) }}\n"
            f"for ($i = 0; $i -lt 150; $i++) {{ $o['n'] = $i; if (-not (Write-JsonFile -Path '{target}' -Object $o)) {{ Write-Output 'WRITE-FAILED'; exit 1 }} }}\n"
            "Write-Output 'DONE'")
    env = _env(tmp_path)
    p = subprocess.Popen(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", body],
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=str(ASSEMBLY), env=env)
    reads, bad = 0, []
    while p.poll() is None:
        try:
            text = target.read_text(encoding="utf-8")
        except FileNotFoundError:
            continue
        except PermissionError:   # the rename replacing it right now
            continue
        reads += 1
        try:
            assert json.loads(text)["bot"] == "demo"
        except Exception as e:  # noqa: BLE001 - any partial read is the defect
            bad.append(f"{type(e).__name__} at {len(text)} chars")
    out, err = p.communicate(timeout=300)
    assert p.returncode == 0 and "DONE" in out, out + err
    assert reads > 20, f"the reader ran alongside ({reads} reads)"
    assert bad == [], f"{len(bad)} of {reads} reads saw a partial file: {bad[:5]}"
    assert [f.name for f in target.parent.iterdir() if f.name.endswith(".tmp")] == [], "no temp file left"


def test_launch_state_writer_refuses_a_torn_state_file(tmp_path):
    env = _env(tmp_path)
    state = tmp_path / "rt" / "state" / "demo.json"
    torn = '{\n  "bot": "demo",\n  "bg_id": "abc123",\n  "claude_pid": 4'
    state.write_text(torn, encoding="utf-8")
    body = (f". '{COMMON}'\n"
            "try { Update-VaultLaunchState -Bot demo -Launch ([ordered]@{ nonce_sha256 = 'ab'; at_unix = 1 }); 'WROTE' } catch { \"REFUSED: $($_.Exception.Message)\" }")
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", body],
                       capture_output=True, text=True, timeout=180, cwd=str(ASSEMBLY), env=env)
    assert "REFUSED" in r.stdout, r.stdout + r.stderr
    assert state.read_text(encoding="utf-8") == torn, "the torn file is left for its writer, not rebuilt as {bot, launch}"

    # positive control: a whole file is merged, every key kept
    state.write_text(json.dumps({"bot": "demo", "bg_id": "abc123", "claude_pid": 42}), encoding="utf-8")
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", body],
                       capture_output=True, text=True, timeout=180, cwd=str(ASSEMBLY), env=env)
    assert "WROTE" in r.stdout, r.stdout + r.stderr
    got = json.loads(state.read_text(encoding="utf-8"))
    assert got["bg_id"] == "abc123" and got["claude_pid"] == 42 and got["launch"]["nonce_sha256"] == "ab", got
