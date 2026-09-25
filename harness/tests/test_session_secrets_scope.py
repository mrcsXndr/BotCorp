"""v0.1.13: bot.yaml `secrets:` reaches the SESSION env (backport of v0.2.0's
scoping, without attestation or the lock mode).

Locked behaviour:
- Get-SecretEnvName: oauth_token -> CLAUDE_CODE_OAUTH_TOKEN, telegram_token ->
  TELEGRAM_BOT_TOKEN, anything else upper-cased; Get-ClaudeEnv maps every key;
- bot.yaml: `secrets:` defaults to [oauth_token, telegram_token], must be a list
  of key names, and automations[].secrets must be a subset of it;
- a launch decrypts ONLY the declared keys into the session env (masked when
  printed), names a present-but-undeclared key without its value, and says
  which declared key has no vault entry.

Only fake values (`value-for-tests-...`) ever touch the vault here.
"""
from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
COMMON = ASSEMBLY / "daemon" / "_common.ps1"
VAULT = ASSEMBLY / "daemon" / "vault.ps1"
BOTYAML = ASSEMBLY / "daemon" / "botyaml.mjs"

pytestmark = pytest.mark.skipif(
    sys.platform != "win32" or shutil.which("pwsh") is None or shutil.which("node") is None,
    reason="Windows only (DPAPI vault) with pwsh and node on PATH",
)


def _pwsh(script: str, env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
                          capture_output=True, text=True, timeout=180, cwd=str(ASSEMBLY), env=env)


def _cfg(tmp_path: Path, text: str) -> dict:
    f = tmp_path / "bot.yaml"
    f.write_text(text, encoding="utf-8")
    r = subprocess.run(["node", str(BOTYAML), str(f)], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def test_secret_env_names_and_claude_env_mapping():
    r = _pwsh(f""". '{COMMON}'
$names = @((Get-SecretEnvName 'oauth_token'), (Get-SecretEnvName 'telegram_token'), (Get-SecretEnvName 'hub_token'), (Get-SecretEnvName 'aws_secret_access_key'))
$e = Get-ClaudeEnv -ConfigDir 'x' -Secrets @{{oauth_token='v1'; hub_token='v2'}}
([ordered]@{{ names = $names; keys = @($e.Keys | Sort-Object) }} | ConvertTo-Json -Compress)""")
    assert r.returncode == 0, r.stderr
    got = json.loads(r.stdout.strip().splitlines()[-1])
    assert got["names"] == ["CLAUDE_CODE_OAUTH_TOKEN", "TELEGRAM_BOT_TOKEN", "HUB_TOKEN", "AWS_SECRET_ACCESS_KEY"]
    assert got["keys"] == ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "HUB_TOKEN"]


def test_bot_yaml_secrets_default_shape_and_automation_subset(tmp_path):
    base = "name: b\n"
    c = _cfg(tmp_path, base)
    assert c["secrets"] == ["oauth_token", "telegram_token"] and not c["_errors"]
    assert _cfg(tmp_path, base + "secrets: [oauth_token, hcloud_token]\n")["_errors"] == []
    assert _cfg(tmp_path, base + "secrets: [Bad-Key]\n")["_errors"]
    auto = "automations:\n  - name: j\n    trigger: {interval_min: 5}\n    command: x\n    secrets: [hcloud_token]\n"
    errs = _cfg(tmp_path, base + auto)["_errors"]
    assert any("hcloud_token not declared" in e for e in errs), errs
    assert _cfg(tmp_path, base + "secrets: [oauth_token, hcloud_token]\n" + auto)["_errors"] == []


def test_a_fifteen_key_secrets_list_is_a_valid_bot_yaml(tmp_path):
    # the shape of the reference host's list (15 keys); v0.1.10's validator called `secrets` an unknown top-level key
    keys = ["oauth_token", "telegram_token", "aws_access_key_id", "aws_secret_access_key", "aws_default_region",
            "cloudflare_api_key", "cloudflare_email", "cf_global_read_token", "ob_org_d1_acct", "ob_org_d1_id",
            "hcloud_token", "github_token", "vpn_svc_client_id", "vpn_svc_client_secret", "vpn_agent_bearer"]
    c = _cfg(tmp_path, f"name: b\nharness:\n  modules:\n    telegram: true\nsecrets: [{', '.join(keys)}]\n")
    assert c["_errors"] == [] and c["secrets"] == keys


def test_launch_env_record_keeps_the_injected_names_only(tmp_path):
    cfg = tmp_path / "cfg"
    for names in ("@('HCLOUD_TOKEN')", "@('CLAUDE_CODE_OAUTH_TOKEN','GITHUB_TOKEN')", "@()"):
        r = _pwsh(f""". '{COMMON}'
[void](Add-LaunchEnvRecord -ConfigDir '{cfg}' -LauncherPid 4242 -OauthLast4 'Q7w3' -OauthSource vault -TelegramLast4 '' -At '2026-09-25T09:00:00Z' -SecretEnv {names})
'ok'""")
        assert r.returncode == 0 and "ok" in r.stdout, r.stderr
        rec = json.loads((cfg / "botcorp" / "launch-env.json").read_text(encoding="utf-8"))["launches"]["4242"]
        assert rec["secret_env"] == json.loads(names.replace("@(", "[").replace(")", "]").replace("'", '"'))


def test_session_secrets_env_verdict_names_only():
    script = ("const m = await import(" + json.dumps((ASSEMBLY / "cli" / "_lib.mjs").as_uri()) + ");"
              "const L = {launcher_pid: 7, secret_env: ['CLAUDE_CODE_OAUTH_TOKEN', 'HCLOUD_TOKEN']};"
              "console.log(JSON.stringify(["
              " m.sessionSecretEnvVerdict({running: true, launch: L, declaredEnv: ['CLAUDE_CODE_OAUTH_TOKEN', 'HCLOUD_TOKEN']}),"
              " m.sessionSecretEnvVerdict({running: true, launch: L, declaredEnv: ['CLAUDE_CODE_OAUTH_TOKEN', 'HCLOUD_TOKEN', 'GITHUB_TOKEN']}),"
              " m.sessionSecretEnvVerdict({running: true, launch: {launcher_pid: 7}}),"
              " m.sessionSecretEnvVerdict({running: true, launch: null}),"
              " m.sessionSecretEnvVerdict({running: false}),"
              " ['oauth_token', 'telegram_token', 'cf_global_read_token'].map(m.secretEnvName)]));")
    r = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, timeout=60, cwd=str(ASSEMBLY))
    assert r.returncode == 0, r.stderr
    ok, miss, old, none, off, names = json.loads(r.stdout.strip().splitlines()[-1])
    assert ok["level"] == "PASS" and "2: CLAUDE_CODE_OAUTH_TOKEN, HCLOUD_TOKEN" in ok["detail"]
    assert miss["level"] == "WARN" and "not in the session env: GITHUB_TOKEN" in miss["detail"]
    assert old["level"] == none["level"] == off["level"] == "INFO"
    assert names == ["CLAUDE_CODE_OAUTH_TOKEN", "TELEGRAM_BOT_TOKEN", "CF_GLOBAL_READ_TOKEN"]


def test_a_launch_injects_only_the_declared_keys(tmp_path):
    name = f"zz-s{secrets.token_hex(3)}"
    home = ASSEMBLY / "bots" / name
    home.mkdir(parents=True)
    rt = tmp_path / "rt"
    (rt / "state").mkdir(parents=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "TELEGRAM_", "BOT_", "HCLOUD", "GITHUB_TOKEN", "AWS_"))}
    env["BOTCORP_HOME"] = str(rt)
    try:
        (home / "bot.yaml").write_text(f"name: {name}\nharness:\n  service: manual\n  modules:\n    telegram: false\n"
                                       "secrets: [oauth_token, hcloud_token, github_token]\n", encoding="utf-8")
        seed = _pwsh(f""". '{VAULT}'
Set-VaultSecret -BotHome '{home}' -Bot '{name}' -Key 'oauth_token' -Value 'value-for-tests-oa-Q7w3' | Out-Null
Set-VaultSecret -BotHome '{home}' -Bot '{name}' -Key 'hcloud_token' -Value 'value-for-tests-hc-R8x4' | Out-Null
Set-VaultSecret -BotHome '{home}' -Bot '{name}' -Key 'aws_secret_access_key' -Value 'value-for-tests-aw-S9y5' | Out-Null
'seeded'""", env=env)
        assert seed.returncode == 0 and "seeded" in seed.stdout, seed.stderr
        r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ASSEMBLY / "daemon" / "launch.ps1"),
                            "-Bot", name, "-Bg", "-DryRun", "-StartedBy", "cli"], capture_output=True, text=True, timeout=300, cwd=str(ASSEMBLY), env=env)
        assert r.returncode == 0, r.stderr + r.stdout
        out = r.stdout
        envs = dict(ln.strip()[len("env : "):].split("=", 1) for ln in out.splitlines() if ln.strip().startswith("env : "))
        assert envs["CLAUDE_CODE_OAUTH_TOKEN"].endswith("Q7w3") and "value-for-tests" not in envs["CLAUDE_CODE_OAUTH_TOKEN"]
        assert envs["HCLOUD_TOKEN"].endswith("R8x4") and "value-for-tests" not in envs["HCLOUD_TOKEN"]
        assert "AWS_SECRET_ACCESS_KEY" not in envs and "GITHUB_TOKEN" not in envs
        assert "undeclared vault key(s) NOT injected: aws_secret_access_key" in out
        assert "github_token: declared in secrets: but no vault entry" in out
        assert "value-for-tests" not in out and "S9y5" not in out            # no value, not even masked, of the undeclared key
    finally:
        shutil.rmtree(home, ignore_errors=True)
