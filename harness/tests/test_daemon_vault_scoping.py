"""daemon/vault.ps1 + daemon/_common.ps1 (Get-SecretEnvName / Get-ClaudeEnv) +
daemon/botyaml.mjs contract for the per-bot secrets-vault scoping work:
declared-keys-only env injection, the secret-access audit log, the vault ACL
reset/probe, and bot.yaml validation of the vault-guard hook / automations
secrets subset / vault.lock enum.

Driven with `pwsh -NoProfile -Command <script>` that dot-sources the daemon
scripts by absolute path (style of test_daemon_chat_accounts_tray.py), plus
`node daemon/botyaml.mjs --validate` directly. Only fake values
(`value-for-tests-...`) ever touch the vault here.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
COMMON_PS1 = ASSEMBLY / "daemon" / "_common.ps1"
VAULT_PS1 = ASSEMBLY / "daemon" / "vault.ps1"
BOTYAML_MJS = ASSEMBLY / "daemon" / "botyaml.mjs"

pytestmark = pytest.mark.skipif(
    sys.platform != "win32" or shutil.which("pwsh") is None or shutil.which("node") is None,
    reason="Windows only (DPAPI vault, icacls) with pwsh and node on PATH",
)


def _pwsh(script: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["pwsh", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
        capture_output=True, text=True, timeout=120, cwd=ASSEMBLY,
    )


def _node_validate(bot_yaml_path: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["node", str(BOTYAML_MJS), str(bot_yaml_path), "--validate"],
        capture_output=True, text=True, timeout=60, cwd=ASSEMBLY,
    )


def test_secret_env_name_and_claude_env_mapping():
    script = f"""
$ErrorActionPreference = 'Stop'
. '{COMMON_PS1.as_posix()}'
$names = @((Get-SecretEnvName 'oauth_token'), (Get-SecretEnvName 'telegram_token'), (Get-SecretEnvName 'hub_token'), (Get-SecretEnvName 'aws_secret_access_key'))
$e = Get-ClaudeEnv -ConfigDir 'x' -Secrets @{{oauth_token='v1'; hub_token='v2'}}
$envKeys = @($e.Keys | Sort-Object)
([ordered]@{{ names = $names; envKeys = $envKeys }} | ConvertTo-Json -Compress)
"""
    r = _pwsh(script)
    assert r.returncode == 0, r.stderr
    payload = json.loads(r.stdout.strip().splitlines()[-1])
    assert payload["names"] == [
        "CLAUDE_CODE_OAUTH_TOKEN", "TELEGRAM_BOT_TOKEN", "HUB_TOKEN", "AWS_SECRET_ACCESS_KEY",
    ]
    # + the pinned Claude Code exe and the autoupdater off (R3, test_cc_pin.py)
    assert sorted(payload["envKeys"]) == ["BOTCORP_CLAUDE_EXE", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "DISABLE_AUTOUPDATER", "HUB_TOKEN"]


def test_vault_list_never_decrypts_and_audit_log_records_exactly_one_line(tmp_path):
    bot_home = tmp_path / "vault_bot_home"
    script = f"""
$ErrorActionPreference = 'Stop'
. '{VAULT_PS1.as_posix()}'
$botHome = '{bot_home.as_posix()}'
Set-VaultSecret -BotHome $botHome -Bot 'vaulttest' -Key 'oauth_token' -Value 'value-for-tests-1234' | Out-Null
Set-VaultSecret -BotHome $botHome -Bot 'vaulttest' -Key 'hub_token' -Value 'value-for-tests-5678' | Out-Null
$list = @(Get-VaultList -BotHome $botHome -Bot 'vaulttest' | ForEach-Object {{ [ordered]@{{ key = $_.key; masked = $_.masked }} }})
$auditPath = Join-Path $env:BOTCORP_HOME 'state/secret-access.jsonl'
$auditExistsBefore = Test-Path $auditPath
# reason launch without a minted nonce: refused (audited ok=false); with one: ok
$unattested = ''
try {{ [void](Get-VaultSecret -BotHome $botHome -Bot 'vaulttest' -Key 'oauth_token' -Reason 'launch' -Nonce ('ab' * 32)) }} catch {{ $unattested = $_.Exception.Message }}
$nonce = New-LaunchNonce -Bot 'vaulttest'
[void](Get-VaultSecret -BotHome $botHome -Bot 'vaulttest' -Key 'oauth_token' -Reason 'launch' -Nonce $nonce)
$lines = @(Get-Content $auditPath)
([ordered]@{{ list = $list; auditExistsBefore = $auditExistsBefore; unattested = $unattested; noncePrefix = $nonce.Substring(0, 8); lineCount = $lines.Count; firstLine = $lines[0]; lastLine = ($lines | Select-Object -Last 1) }} | ConvertTo-Json -Depth 5 -Compress)
"""
    r = _pwsh(script)
    assert r.returncode == 0, r.stderr
    payload = json.loads(r.stdout.strip().splitlines()[-1])

    masked = {row["key"]: row["masked"] for row in payload["list"]}
    assert masked == {"oauth_token": "****1234", "hub_token": "****5678"}
    assert payload["auditExistsBefore"] is False
    assert "not attested" in payload["unattested"]

    assert payload["lineCount"] == 2
    first = json.loads(payload["firstLine"])
    assert first["reason"] == "launch" and first["ok"] is False
    rec = json.loads(payload["lastLine"])
    assert rec["bot"] == "vaulttest"
    assert rec["key"] == "oauth_token"
    assert rec["reason"] == "launch"
    assert rec["ok"] is True
    assert rec["nonce"] == payload["noncePrefix"]
    assert rec["pid"] > 0


def test_launch_nonce_is_single_use_hash_recorded_and_age_bounded(tmp_path):
    script = f"""
$ErrorActionPreference = 'Stop'
$env:BOTCORP_HOME = '{(tmp_path / "rt").as_posix()}'
. '{VAULT_PS1.as_posix()}'
$n = New-LaunchNonce -Bot 'noncebot'
$stateRaw = Get-Content (Join-Path $env:BOTCORP_HOME 'state/noncebot.json') -Raw
$ok = Test-LaunchNonce -Bot 'noncebot' -Nonce $n
$wrong = Test-LaunchNonce -Bot 'noncebot' -Nonce ('0' * 64)
Confirm-LaunchNonce -Bot 'noncebot'
$afterConsume = Test-LaunchNonce -Bot 'noncebot' -Nonce $n
$n2 = New-LaunchNonce -Bot 'noncebot'
$st = Get-Content (Join-Path $env:BOTCORP_HOME 'state/noncebot.json') -Raw | ConvertFrom-Json
$st.launch.at_unix = $st.launch.at_unix - 200
$st | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $env:BOTCORP_HOME 'state/noncebot.json')
$stale = Test-LaunchNonce -Bot 'noncebot' -Nonce $n2
([ordered]@{{ nonce = $n; rawContainsNonce = $stateRaw.Contains($n); ok = $ok; wrong = $wrong; afterConsume = $afterConsume; stale = $stale }} | ConvertTo-Json -Compress)
"""
    r = _pwsh(script)
    assert r.returncode == 0, r.stderr
    p = json.loads(r.stdout.strip().splitlines()[-1])
    assert len(p["nonce"]) == 64
    assert p["rawContainsNonce"] is False   # only sha256(nonce) is on disk
    assert p["ok"] is True and p["wrong"] is False
    assert p["afterConsume"] is False
    assert p["stale"] is False


def test_vault_v2_migrate_lock_unlock_and_reboot(tmp_path):
    bot_home = tmp_path / "lock_bot_home"
    script = f"""
$ErrorActionPreference = 'Stop'
$env:BOTCORP_HOME = '{(tmp_path / "rt").as_posix()}'
. '{VAULT_PS1.as_posix()}'
$botHome = '{bot_home.as_posix()}'
Set-VaultSecret -BotHome $botHome -Bot 'lockbot' -Key 'api_key' -Value 'value-for-tests-4321' | Out-Null
$migrated = ConvertTo-VaultV2 -BotHome $botHome -Bot 'lockbot'
$keyFile = Get-Content (Join-Path $botHome '.vault/key.json') -Raw | ConvertFrom-Json
$v2get = Get-VaultSecret -BotHome $botHome -Bot 'lockbot' -Key 'api_key' -Reason 'cli'
$s1 = Get-VaultLockState -BotHome $botHome -Bot 'lockbot'
Lock-Vault -BotHome $botHome -Bot 'lockbot' -Passphrase 'correct horse battery'
$keyFileLocked = Get-Content (Join-Path $botHome '.vault/key.json') -Raw | ConvertFrom-Json
$s2 = Get-VaultLockState -BotHome $botHome -Bot 'lockbot'
$lockedErr = ''; try {{ [void](Get-VaultSecret -BotHome $botHome -Bot 'lockbot' -Key 'api_key' -Reason 'cli') }} catch {{ $lockedErr = $_.Exception.Message }}
$setErr = ''; try {{ [void](Set-VaultSecret -BotHome $botHome -Bot 'lockbot' -Key 'other' -Value 'value-for-tests-0000') }} catch {{ $setErr = $_.Exception.Message }}
$wrongErr = ''; try {{ [void](Unlock-Vault -BotHome $botHome -Bot 'lockbot' -Passphrase 'not the passphrase') }} catch {{ $wrongErr = $_.Exception.Message }}
$how = Unlock-Vault -BotHome $botHome -Bot 'lockbot' -Passphrase 'correct horse battery'
$cachePath = Join-Path $env:BOTCORP_HOME 'state/unlock/lockbot.key'
$cacheExists = Test-Path $cachePath
$cacheRaw = Get-Content $cachePath -Raw
$unlockedGet = Get-VaultSecret -BotHome $botHome -Bot 'lockbot' -Key 'api_key' -Reason 'cli'
$s3 = Get-VaultLockState -BotHome $botHome -Bot 'lockbot'
$env:BOTCORP_FAKE_BOOT = '2099-01-01T00:00:00.0000000Z'
$rebootErr = ''; try {{ [void](Get-VaultSecret -BotHome $botHome -Bot 'lockbot' -Key 'api_key' -Reason 'cli') }} catch {{ $rebootErr = $_.Exception.Message }}
$cacheAfterReboot = Test-Path $cachePath
$env:BOTCORP_FAKE_BOOT = $null
[void](Unlock-Vault -BotHome $botHome -Bot 'lockbot' -Passphrase 'correct horse battery')
$perm = Unlock-Vault -BotHome $botHome -Bot 'lockbot' -Passphrase 'correct horse battery' -Permanent
$s4 = Get-VaultLockState -BotHome $botHome -Bot 'lockbot'
$finalGet = Get-VaultSecret -BotHome $botHome -Bot 'lockbot' -Key 'api_key' -Reason 'cli'
$audit = @(Get-Content (Join-Path $env:BOTCORP_HOME 'state/secret-access.jsonl') | ForEach-Object {{ $_ | ConvertFrom-Json }})
([ordered]@{{ migrated = $migrated; kfVersion = $keyFile.v; kfHasDpapi = [bool]$keyFile.wraps.dpapi; v2get = $v2get; s1 = $s1
  lockedHasDpapi = ($keyFileLocked.wraps.PSObject.Properties.Name -contains 'dpapi'); lockedHasOperator = [bool]$keyFileLocked.wraps.operator; s2 = $s2
  lockedErr = $lockedErr; setErr = $setErr; wrongErr = $wrongErr; how = $how; cacheExists = $cacheExists; cacheHasRawKey = $cacheRaw.Contains('value-for-tests'); unlockedGet = $unlockedGet; s3 = $s3
  rebootErr = $rebootErr; cacheAfterReboot = $cacheAfterReboot; perm = $perm; s4 = $s4; finalGet = $finalGet
  unlockAudit = @($audit | Where-Object {{ $_.reason -eq 'unlock' }} | ForEach-Object {{ $_.ok }}); lockedAudit = @($audit | Where-Object {{ $_.reason -eq 'cli' -and -not $_.ok }}).Count }} | ConvertTo-Json -Depth 5 -Compress)
"""
    r = _pwsh(script)
    assert r.returncode == 0, r.stderr
    p = json.loads(r.stdout.strip().splitlines()[-1])
    assert p["migrated"] is True and p["kfVersion"] == 2 and p["kfHasDpapi"] is True
    assert p["v2get"] == "value-for-tests-4321"
    assert p["s1"]["mode"] == "none" and p["s1"]["version"] == 2 and p["s1"]["locked"] is False
    assert p["lockedHasDpapi"] is False and p["lockedHasOperator"] is True
    assert p["s2"]["mode"] == "operator" and p["s2"]["locked"] is True
    assert "is locked" in p["lockedErr"] and "is locked" in p["setErr"]
    assert "wrong passphrase" in p["wrongErr"]
    assert p["how"] == "until-reboot" and p["cacheExists"] is True and p["cacheHasRawKey"] is False
    assert p["unlockedGet"] == "value-for-tests-4321"
    assert p["s3"]["mode"] == "operator" and p["s3"]["locked"] is False
    assert "is locked" in p["rebootErr"] and p["cacheAfterReboot"] is False   # a reboot re-locks and drops the cache
    assert p["perm"] == "permanent" and p["s4"]["mode"] == "none" and p["s4"]["locked"] is False
    assert p["finalGet"] == "value-for-tests-4321"
    assert p["unlockAudit"] == [False, True, True, True]   # wrong passphrase audited ok=false, then three successes
    assert p["lockedAudit"] == 2                           # the locked get and the post-reboot get, both audited ok=false


def test_vault_acl_detects_reenabled_inheritance_and_protect_vault_dir_fixes_it(tmp_path):
    bot_home = tmp_path / "acl_bot_home"
    script = f"""
$ErrorActionPreference = 'Stop'
. '{VAULT_PS1.as_posix()}'
$botHome = '{bot_home.as_posix()}'
Set-VaultSecret -BotHome $botHome -Bot 'aclbot' -Key 'oauth_token' -Value 'value-for-tests-4242' | Out-Null
$dir = Join-Path $botHome '.vault'
# A plain Set must leave the dir AND the freshly written secrets.json protected
# (Write-VaultStore applies the ACL after the move, not before it).
$r1 = Test-VaultAcl -BotHome $botHome
& icacls $dir /inheritance:e | Out-Null
$r2 = Test-VaultAcl -BotHome $botHome
Protect-VaultDir $dir
$r3 = Test-VaultAcl -BotHome $botHome
([ordered]@{{ r1 = $r1; r2 = $r2; r3 = $r3 }} | ConvertTo-Json -Depth 5 -Compress)
"""
    r = _pwsh(script)
    assert r.returncode == 0, r.stderr
    payload = json.loads(r.stdout.strip().splitlines()[-1])

    assert payload["r1"]["ok"] is True
    assert payload["r2"]["ok"] is False
    assert "inheritance on" in payload["r2"]["detail"]
    assert payload["r3"]["ok"] is True


def _write_bot_yaml(tmp_path: Path, dirname: str, body: str) -> Path:
    d = tmp_path / dirname
    d.mkdir(parents=True, exist_ok=True)
    p = d / "bot.yaml"
    p.write_text(body, encoding="utf-8")
    return p


def test_botyaml_validate_rejects_vault_guard_disable(tmp_path):
    p = _write_bot_yaml(tmp_path, "test-bot-a", """
name: test-bot-a
harness:
  hooks_disable: [vault-guard]
""")
    r = _node_validate(p)
    assert r.returncode == 1
    assert r.stdout.strip() == "INVALID"
    assert "vault-guard" in r.stderr


def test_botyaml_validate_rejects_automation_secret_not_declared(tmp_path):
    p = _write_bot_yaml(tmp_path, "test-bot-b", """
name: test-bot-b
secrets: [oauth_token]
automations:
  - name: test-automation
    command: echo hi
    trigger: {interval_min: 5}
    secrets: [other_key]
""")
    r = _node_validate(p)
    assert r.returncode == 1
    assert r.stdout.strip() == "INVALID"
    assert "other_key" in r.stderr


def test_botyaml_validate_rejects_bad_vault_lock_value(tmp_path):
    p = _write_bot_yaml(tmp_path, "test-bot-c", """
name: test-bot-c
vault:
  lock: sometimes
""")
    r = _node_validate(p)
    assert r.returncode == 1
    assert r.stdout.strip() == "INVALID"
