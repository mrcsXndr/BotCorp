"""daemon/bundle.ps1 + daemon/secrets.ps1 export-bundle/import-bundle contract,
driven directly through secrets.ps1 (pwsh) against a fake -BotCorpRoot.

Locked behaviour asserted here: the passphrase is read only from stdin and
never appears in the manifest, the bundle file, or command output; the
manifest carries schema/bot/kdf/sha256/vault_keys/files exactly as documented
in docs/secrets.md; import refuses a bundle built for a different bot, a
tampered or wrong-passphrase bundle, and a manifest with an unsafe file path
- all before anything is written; a dry run writes nothing; a real import
restores the file byte-identical and the vault key with the right mask.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
FAKE_API_KEY = "value-for-tests-1234"
FAKE_TOKEN_BYTES = b"token-bytes-for-tests-0123456789"
FAKE_HOME_BYTES = b'{"svc": "value-for-tests-home-9876"}\n'
PASSPHRASE = "correct horse battery staple test"

pytestmark = pytest.mark.skipif(
    sys.platform != "win32" or shutil.which("pwsh") is None,
    reason="Windows only (DPAPI vault) with pwsh on PATH",
)


def _secrets(root: Path, args: list[str], stdin: str | None = None, env: dict | None = None) -> subprocess.CompletedProcess:
    # `env` overrides (USERPROFILE for scope=home, BOTCORP_HOME for the audit log)
    # keep every home-scoped write and every audit line inside tmp_path.
    return subprocess.run(
        ["pwsh", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ASSEMBLY / "daemon" / "secrets.ps1"),
         *args, "-BotCorpRoot", str(root)],
        capture_output=True, text=True, timeout=120, cwd=ASSEMBLY, input=stdin,
        env={**os.environ, **(env or {})},
    )


def _make_bot(root: Path, name: str, token_bytes: bytes | None = None) -> Path:
    bot_dir = root / "bots" / name
    bot_dir.mkdir(parents=True)
    (bot_dir / "bot.yaml").write_text(f"name: {name}\n", encoding="utf-8")
    if token_bytes is not None:
        (bot_dir / "token.json").write_bytes(token_bytes)
    return bot_dir


def test_export_bundle_manifest_and_no_plaintext_leak(tmp_path):
    root = tmp_path / "botcorp"
    out_dir = tmp_path / "out"
    _make_bot(root, "demo", token_bytes=FAKE_TOKEN_BYTES)

    r = _secrets(root, ["-Bot", "demo", "-Action", "set", "-Key", "api_key", "-FromStdin"], stdin=FAKE_API_KEY + "\n")
    assert r.returncode == 0, r.stderr

    r = _secrets(root, ["-Bot", "demo", "-Action", "export-bundle", "-OutDir", str(out_dir), "-Files", "token.json"],
                 stdin=PASSPHRASE + "\n")
    assert r.returncode == 0, r.stderr
    assert "secrets.bundle.enc" in r.stdout
    assert PASSPHRASE not in r.stdout

    manifest_path = out_dir / "secrets.manifest.json"
    bundle_path = out_dir / "secrets.bundle.enc"
    assert manifest_path.exists() and bundle_path.exists()

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["schema"] == 1
    assert manifest["bot"] == "demo"
    assert manifest["cipher"] == "aes-256-gcm"
    assert manifest["kdf"]["name"] == "pbkdf2-sha256"
    assert manifest["kdf"]["iterations"] >= 600000
    assert manifest["vault_keys"] == ["api_key"]
    assert len(manifest["files"]) == 1
    assert manifest["files"][0]["path"] == "token.json"
    assert manifest["files"][0]["sha256"] == hashlib.sha256(FAKE_TOKEN_BYTES).hexdigest()

    enc_bytes = bundle_path.read_bytes()
    assert hashlib.sha256(enc_bytes).hexdigest() == manifest["sha256"]
    assert FAKE_API_KEY.encode("utf-8") not in enc_bytes
    assert FAKE_TOKEN_BYTES not in enc_bytes
    assert PASSPHRASE.encode("utf-8") not in enc_bytes


def _export_fixture_bundle(tmp_path: Path) -> tuple[Path, Path, Path]:
    """Common setup for the import tests: a root with a 'demo' bot exported
    to out_dir. Returns (root, manifest_path, bundle_path)."""
    root = tmp_path / "botcorp"
    out_dir = tmp_path / "out"
    _make_bot(root, "demo", token_bytes=FAKE_TOKEN_BYTES)
    r = _secrets(root, ["-Bot", "demo", "-Action", "set", "-Key", "api_key", "-FromStdin"], stdin=FAKE_API_KEY + "\n")
    assert r.returncode == 0, r.stderr
    r = _secrets(root, ["-Bot", "demo", "-Action", "export-bundle", "-OutDir", str(out_dir), "-Files", "token.json"],
                 stdin=PASSPHRASE + "\n")
    assert r.returncode == 0, r.stderr
    return root, out_dir / "secrets.manifest.json", out_dir / "secrets.bundle.enc"


def test_import_refuses_bundle_built_for_a_different_bot(tmp_path):
    root, manifest_path, bundle_path = _export_fixture_bundle(tmp_path)
    _make_bot(root, "demo2")

    r = _secrets(root, ["-Bot", "demo2", "-Action", "import-bundle", "-Bundle", str(bundle_path),
                        "-Manifest", str(manifest_path)], stdin=PASSPHRASE + "\n")
    assert r.returncode != 0
    assert "bundle is for bot demo" in (r.stdout + r.stderr)
    assert not (root / "bots" / "demo2" / "token.json").exists()


def test_import_dry_run_writes_nothing(tmp_path):
    root, manifest_path, bundle_path = _export_fixture_bundle(tmp_path)
    demo_dir = root / "bots" / "demo"
    shutil.rmtree(demo_dir)
    _make_bot(root, "demo")

    r = _secrets(root, ["-Bot", "demo", "-Action", "import-bundle", "-Bundle", str(bundle_path),
                        "-Manifest", str(manifest_path), "-DryRun"], stdin=PASSPHRASE + "\n")
    assert r.returncode == 0, r.stderr
    assert "would restore [bot] token.json" in r.stdout
    assert "would set vault api_key" in r.stdout
    assert not (demo_dir / "token.json").exists()

    r = _secrets(root, ["-Bot", "demo", "-Action", "list", "-Json"])
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout) == []


def test_import_restores_file_and_vault_key(tmp_path):
    root, manifest_path, bundle_path = _export_fixture_bundle(tmp_path)
    demo_dir = root / "bots" / "demo"
    shutil.rmtree(demo_dir)
    _make_bot(root, "demo")

    r = _secrets(root, ["-Bot", "demo", "-Action", "import-bundle", "-Bundle", str(bundle_path),
                        "-Manifest", str(manifest_path)], stdin=PASSPHRASE + "\n")
    assert r.returncode == 0, r.stderr
    assert "restored [bot] token.json" in r.stdout
    assert (demo_dir / "token.json").read_bytes() == FAKE_TOKEN_BYTES

    r = _secrets(root, ["-Bot", "demo", "-Action", "list", "-Json"])
    assert r.returncode == 0, r.stderr
    rows = {row["key"]: row for row in json.loads(r.stdout)}
    assert "api_key" in rows
    assert rows["api_key"]["masked"] == "****" + FAKE_API_KEY[-4:]


def test_import_wrong_passphrase_fails(tmp_path):
    root, manifest_path, bundle_path = _export_fixture_bundle(tmp_path)
    demo_dir = root / "bots" / "demo"
    shutil.rmtree(demo_dir)
    _make_bot(root, "demo")

    r = _secrets(root, ["-Bot", "demo", "-Action", "import-bundle", "-Bundle", str(bundle_path),
                        "-Manifest", str(manifest_path)], stdin="definitely the wrong passphrase\n")
    assert r.returncode != 0
    assert "wrong passphrase or tampered bundle" in (r.stdout + r.stderr)
    assert not (demo_dir / "token.json").exists()


def test_import_tampered_bundle_fails_the_same_way(tmp_path):
    root, manifest_path, bundle_path = _export_fixture_bundle(tmp_path)
    demo_dir = root / "bots" / "demo"
    shutil.rmtree(demo_dir)
    _make_bot(root, "demo")

    data = bytearray(bundle_path.read_bytes())
    data[0] ^= 0xFF
    tampered = bundle_path.parent / "tampered.enc"
    tampered.write_bytes(bytes(data))

    r = _secrets(root, ["-Bot", "demo", "-Action", "import-bundle", "-Bundle", str(tampered),
                        "-Manifest", str(manifest_path)], stdin=PASSPHRASE + "\n")
    assert r.returncode != 0
    assert "wrong passphrase or tampered bundle" in (r.stdout + r.stderr)
    assert not (demo_dir / "token.json").exists()


def test_import_refuses_manifest_with_path_traversal_before_any_write(tmp_path):
    root, manifest_path, bundle_path = _export_fixture_bundle(tmp_path)
    demo_dir = root / "bots" / "demo"
    shutil.rmtree(demo_dir)
    _make_bot(root, "demo")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["files"][0]["path"] = "../evil.txt"
    evil_manifest = manifest_path.parent / "evil.manifest.json"
    evil_manifest.write_text(json.dumps(manifest), encoding="utf-8")

    r = _secrets(root, ["-Bot", "demo", "-Action", "import-bundle", "-Bundle", str(bundle_path),
                        "-Manifest", str(evil_manifest)], stdin=PASSPHRASE + "\n")
    assert r.returncode != 0
    assert not (root / "bots" / "evil.txt").exists()
    assert not (demo_dir.parent.parent / "evil.txt").exists()


# ---- scope: home ------------------------------------------------------------------------

def _home_fixture(tmp_path: Path):
    """A source USERPROFILE holding creds/svc.json, a root with 'demo' (token.json
    + api_key) and a throwaway BOTCORP_HOME for the audit log."""
    src_home = tmp_path / "src_home"
    (src_home / "creds").mkdir(parents=True)
    (src_home / "creds" / "svc.json").write_bytes(FAKE_HOME_BYTES)
    root = tmp_path / "botcorp"
    out_dir = tmp_path / "out"
    _make_bot(root, "demo", token_bytes=FAKE_TOKEN_BYTES)
    env = {"USERPROFILE": str(src_home), "BOTCORP_HOME": str(tmp_path / "rt")}
    r = _secrets(root, ["-Bot", "demo", "-Action", "set", "-Key", "api_key", "-FromStdin"], stdin=FAKE_API_KEY + "\n", env=env)
    assert r.returncode == 0, r.stderr
    # one comma-joined -Files value: `pwsh -File` binds only the first of `-Files a b`
    r = _secrets(root, ["-Bot", "demo", "-Action", "export-bundle", "-OutDir", str(out_dir),
                        "-Files", "token.json,~/creds/svc.json"], stdin=PASSPHRASE + "\n", env=env)
    assert r.returncode == 0, r.stderr
    return root, out_dir / "secrets.manifest.json", out_dir / "secrets.bundle.enc"


def test_home_scope_round_trip_needs_allow_home_and_force(tmp_path):
    root, manifest_path, bundle_path = _home_fixture(tmp_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    by_path = {f["path"]: f for f in manifest["files"]}
    assert by_path["token.json"]["scope"] == "bot"
    assert by_path["creds/svc.json"]["scope"] == "home"
    assert by_path["creds/svc.json"]["sha256"] == hashlib.sha256(FAKE_HOME_BYTES).hexdigest()

    dst_home = tmp_path / "dst_home"
    dst_home.mkdir()
    rt = tmp_path / "rt2"
    env = {"USERPROFILE": str(dst_home), "BOTCORP_HOME": str(rt)}
    demo_dir = root / "bots" / "demo"
    shutil.rmtree(demo_dir)
    _make_bot(root, "demo")
    args = ["-Bot", "demo", "-Action", "import-bundle", "-Bundle", str(bundle_path), "-Manifest", str(manifest_path)]

    # every target is printed, then the home file is refused without -AllowHome: nothing written
    r = _secrets(root, args, stdin=PASSPHRASE + "\n", env=env)
    assert r.returncode != 0
    assert "target [home] " + str(dst_home / "creds" / "svc.json") in r.stdout
    assert "target [bot] " + str(demo_dir / "token.json") in r.stdout
    assert "AllowHome" in (r.stdout + r.stderr)
    assert not (dst_home / "creds" / "svc.json").exists()
    assert not (demo_dir / "token.json").exists()

    r = _secrets(root, args + ["-AllowHome"], stdin=PASSPHRASE + "\n", env=env)
    assert r.returncode == 0, r.stderr
    assert (dst_home / "creds" / "svc.json").read_bytes() == FAKE_HOME_BYTES
    assert (demo_dir / "token.json").read_bytes() == FAKE_TOKEN_BYTES
    audit = [json.loads(l) for l in (rt / "state" / "secret-access.jsonl").read_text(encoding="utf-8").splitlines() if l]
    imports = [a for a in audit if a["reason"] == "import"]
    assert {a["key"] for a in imports} == {"file:home:creds/svc.json", "file:bot:token.json", "api_key"}

    # existing targets are never overwritten silently
    (dst_home / "creds" / "svc.json").write_bytes(b"changed by the operator\n")
    r = _secrets(root, args + ["-AllowHome"], stdin=PASSPHRASE + "\n", env=env)
    assert r.returncode != 0
    assert "(EXISTS)" in r.stdout and "Force" in (r.stdout + r.stderr)
    assert (dst_home / "creds" / "svc.json").read_bytes() == b"changed by the operator\n"
    r = _secrets(root, args + ["-AllowHome", "-Force"], stdin=PASSPHRASE + "\n", env=env)
    assert r.returncode == 0, r.stderr
    assert (dst_home / "creds" / "svc.json").read_bytes() == FAKE_HOME_BYTES


def test_home_scope_refuses_traversal_absolute_and_a_bot_folder_target(tmp_path):
    root, manifest_path, bundle_path = _home_fixture(tmp_path)
    dst_home = tmp_path / "dst_home"
    dst_home.mkdir()
    env = {"USERPROFILE": str(dst_home), "BOTCORP_HOME": str(tmp_path / "rt3")}
    shutil.rmtree(root / "bots" / "demo")
    _make_bot(root, "demo")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    for bad in ("../evil.txt", "C:/evil.txt", "/evil.txt", ".claude/settings.json", ".botcorp/x"):
        m = json.loads(json.dumps(manifest))
        for f in m["files"]:
            if f["scope"] == "home":
                f["path"] = bad
        p = manifest_path.parent / "bad.manifest.json"
        p.write_text(json.dumps(m), encoding="utf-8")
        r = _secrets(root, ["-Bot", "demo", "-Action", "import-bundle", "-Bundle", str(bundle_path),
                            "-Manifest", str(p), "-AllowHome", "-Force"], stdin=PASSPHRASE + "\n", env=env)
        assert r.returncode != 0, bad
        assert not (root / "bots" / "demo" / "token.json").exists(), bad   # refused BEFORE any write
    assert not (tmp_path / "evil.txt").exists()
    assert not (dst_home / "evil.txt").exists()

    # a home path that resolves into a bot folder (USERPROFILE above the checkout)
    _make_bot(root, "demo2", token_bytes=b"sibling-token-bytes-0123456789")
    env2 = {"USERPROFILE": str(tmp_path), "BOTCORP_HOME": str(tmp_path / "rt4")}
    out2 = tmp_path / "out2"
    r = _secrets(root, ["-Bot", "demo", "-Action", "export-bundle", "-OutDir", str(out2),
                        "-Files", "~/botcorp/bots/demo2/token.json"], stdin=PASSPHRASE + "\n", env=env2)
    assert r.returncode == 0, r.stderr
    (root / "bots" / "demo2" / "token.json").unlink()
    r = _secrets(root, ["-Bot", "demo", "-Action", "import-bundle", "-Bundle", str(out2 / "secrets.bundle.enc"),
                        "-AllowHome", "-Force"], stdin=PASSPHRASE + "\n", env=env2)
    assert r.returncode != 0
    assert "inside a bot folder" in (r.stdout + r.stderr)
    assert not (root / "bots" / "demo2" / "token.json").exists()
