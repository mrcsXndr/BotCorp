"""daemon/accounts.ps1 + daemon/chat.ps1 + daemon/attach.ps1 + daemon/tray.ps1 /
tray-register.ps1 contract, driven through the real CLI (cli/botcorp.mjs) and,
where the CLI has no equivalent flag, the .ps1 directly.

Locked behaviour asserted here: the accounts registry never puts a plaintext
token on stdout/argv (masked ****last4 only; `get` is launcher-only), `seed`
mints one account per bot that holds an oauth_token without ever printing it,
`chat --dry-run` shows the wt tab command with the token as an env-var
placeholder (never the real value), `attach` is a message (not a launch) with
no recorded bg id, and `tray`/`tray-register` dry-run paths never open a GUI.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
FAKE_TOKEN = "sk-ant-oat01-" + "FAKE" * 7 + "-test"

pytestmark = pytest.mark.skipif(
    sys.platform != "win32" or shutil.which("pwsh") is None or shutil.which("node") is None,
    reason="Windows only (DPAPI vault, HKCU Run) with pwsh and node on PATH",
)


def _pwsh(script: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["pwsh", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ASSEMBLY / "daemon" / script), *args],
        capture_output=True, text=True, timeout=120, cwd=ASSEMBLY,
    )


def _cli(*args: str, stdin: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["node", str(ASSEMBLY / "cli" / "botcorp.mjs"), *args],
        capture_output=True, text=True, timeout=120, cwd=ASSEMBLY, input=stdin,
    )


def test_accounts_add_list_get_remove_round_trip(tmp_path):
    assert Path(os.environ["BOTCORP_HOME"]).is_relative_to(tmp_path)

    r = _cli("accounts", "add", "demo", "--label", "Demo", "--plan", "max", stdin=FAKE_TOKEN + "\n")
    assert r.returncode == 0, r.stderr
    assert "****test" in r.stdout
    assert FAKE_TOKEN not in r.stdout

    r = _cli("accounts", "list", "--json")
    assert r.returncode == 0, r.stderr
    rows = json.loads(r.stdout)
    assert len(rows) == 1
    row = rows[0]
    assert row["id"] == "demo"
    assert row["masked"] == "****test"
    assert len(row["fp"]) == 12 and all(c in "0123456789abcdef" for c in row["fp"])
    assert row["config_dir"].replace("/", "\\").endswith("accounts\\demo\\claude")

    r = _pwsh("accounts.ps1", "-Action", "get", "-Id", "demo", "-IAmTheLauncher", "-BotCorpRoot", str(ASSEMBLY))
    assert r.returncode == 0, r.stderr
    assert r.stdout == FAKE_TOKEN

    r = _pwsh("accounts.ps1", "-Action", "get", "-Id", "demo", "-BotCorpRoot", str(ASSEMBLY))
    assert r.returncode == 1
    assert FAKE_TOKEN not in r.stdout and "sk-ant" not in r.stdout

    vault_file = Path(os.environ["BOTCORP_HOME"]) / "accounts" / "demo" / ".vault" / "secrets.json"
    assert vault_file.exists()
    assert FAKE_TOKEN not in vault_file.read_text(encoding="utf-8")

    r = _cli("accounts", "remove", "demo")
    assert r.returncode == 0, r.stderr

    r = _cli("accounts", "list", "--json")
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout) == []


def test_accounts_seed_creates_one_account_per_bot_with_a_token():
    bots = [
        d.name for d in (ASSEMBLY / "bots").iterdir()
        if d.is_dir() and not d.name.startswith("_")
        and (d / "bot.yaml").exists()
        and (d / ".vault" / "secrets.json").exists()
    ]
    if not bots:
        pytest.skip("no bot with a vault on this box")

    r = _cli("accounts", "seed", "--json")
    assert r.returncode == 0, r.stderr
    assert "sk-ant" not in r.stdout
    payload = json.loads(r.stdout)

    r = _cli("accounts", "list", "--json")
    assert r.returncode == 0, r.stderr
    rows = {row["id"]: row for row in json.loads(r.stdout)}

    for name in bots:
        sec = _pwsh("secrets.ps1", "-Bot", name, "-Action", "list", "-Json", "-BotCorpRoot", str(ASSEMBLY))
        assert sec.returncode == 0, sec.stderr
        keys = {entry["key"] for entry in json.loads(sec.stdout)}
        if "oauth_token" not in keys:
            continue
        assert any(s.startswith(name + " ") for s in payload["seeded"]), payload
        assert name in rows and rows[name]["masked"]
        r = _cli("accounts", "remove", name)
        assert r.returncode == 0, r.stderr


def test_chat_dry_run_builds_a_wt_tab_with_intab_and_never_prints_the_token(tmp_path):
    r = _cli("accounts", "add", "demo", stdin=FAKE_TOKEN + "\n")
    assert r.returncode == 0, r.stderr

    r = _cli("chat", "--account", "demo", "--generic", "--dry-run")
    assert r.returncode == 0, r.stderr
    assert "new-tab" in r.stdout
    assert "chat.ps1" in r.stdout
    assert "-InTab" in r.stdout
    assert "-Generic" in r.stdout
    assert "CLAUDE_CODE_OAUTH_TOKEN=<from account vault, never printed>" in r.stdout
    assert FAKE_TOKEN not in r.stdout

    r = _cli("chat", "--account", "demo", "--cwd", str(tmp_path), "--dry-run")
    assert r.returncode == 0, r.stderr
    assert "-Cwd" in r.stdout
    assert str(tmp_path) in r.stdout

    r = _cli("chat", "--account", "nope", "--generic", "--dry-run")
    assert r.returncode != 0
    combined = r.stdout + r.stderr
    assert "no account 'nope'" in combined

    r = _cli("chat", "--generic", "--cwd", "x")
    assert r.returncode == 2


def test_attach_without_bg_id_is_a_message_not_a_launch():
    r = _pwsh("attach.ps1", "-Bot", "demo-bot", "-DryRun")
    assert r.returncode == 0, r.stderr
    assert "no bg id recorded" in r.stdout


def test_attach_dry_run_with_a_recorded_bg_id():
    state_dir = Path(os.environ["BOTCORP_HOME"]) / "state"
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "demo-bot.json").write_text(
        json.dumps({"bot": "demo-bot", "bg_id": "abcd1234", "status": "running"}), encoding="utf-8",
    )

    r = _pwsh("attach.ps1", "-Bot", "demo-bot", "-DryRun")
    assert r.returncode == 0, r.stderr
    assert "claude attach abcd1234" in r.stdout
    assert "-InTab" in r.stdout
    assert "attach.ps1" in r.stdout


def test_tray_register_dry_run_and_status():
    r = _pwsh("tray-register.ps1", "-Bot", "demo-bot", "-AttachAtLogin", "-DryRun")
    assert r.returncode == 0, r.stderr
    assert "BotCorp-Tray-demo-bot" in r.stdout
    assert "BotCorp-Attach-demo-bot" in r.stdout
    assert "-WaitSec 180" in r.stdout

    r = _pwsh("tray-register.ps1", "-Bot", "demo-bot", "-Remove", "-DryRun")
    assert r.returncode == 0, r.stderr

    r = _pwsh("tray-register.ps1", "-Bot", "zz-not-a-bot", "-Status")
    assert r.returncode == 2
    assert "absent" in r.stdout

    r = _cli("tray", "zz-not-a-bot", "status")
    assert r.returncode != 0
    combined = r.stdout + r.stderr
    assert "no bot" in combined


def test_tray_probe_and_dry_run_never_open_a_gui():
    r = _pwsh("tray.ps1", "-Bot", "demo-bot", "-Probe")
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip()
    import re
    assert re.search(r"tray probe: demo-bot: (stopped|unknown|idle|working|blocked|starting|down \(daemon restarts it\)) \| ctx .*% \| tick", r.stdout)

    # the tray shows the phase the tick persisted (observed.phase), not a pid check of its own
    state_dir = Path(os.environ["BOTCORP_HOME"]) / "state"
    state_dir.mkdir(parents=True, exist_ok=True)
    state_file = state_dir / "demo-bot.json"
    for phase, text in (("down", "down (daemon restarts it)"), ("working", "working")):
        state_file.write_text(json.dumps({"bot": "demo-bot", "schema": 2, "observed": {"alive": phase != "down", "phase": phase}}), encoding="utf-8")
        r = _pwsh("tray.ps1", "-Bot", "demo-bot", "-Probe")
        assert r.returncode == 0, r.stderr
        assert f"tray probe: demo-bot: {text} | ctx" in r.stdout, r.stdout
    state_file.unlink()

    r = _pwsh("tray.ps1", "-Bot", "demo-bot", "-DryRun")
    assert r.returncode == 0, r.stderr
    for label in ("Attach", "Restart", "Stop", "Open cockpit", "New chat"):
        assert label in r.stdout
