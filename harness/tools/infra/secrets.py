#!/usr/bin/env python3
"""Seal the bot's secrets INTO the repo, encrypted at rest with age.

"In the repo" cannot mean committing credentials as plaintext: a private repo
is one setting away from public, it is cloned to every machine that ever
checks it out, and git history is forever. So the plaintext files stay
gitignored exactly as they are, and what gets committed is an `age`-encrypted
twin of each one.

Why age and not a secrets store: no service to authenticate to, no vendor, no
network at restore time, one static binary, and the ciphertext lives beside the
code it belongs to. Recovery on a bare machine is `git clone` plus one key.

## The key model

age uses a keypair. The RECIPIENT (public key) is not a secret — it can only
encrypt — so it is committed at `secrets/recipient.txt` and anyone can seal a
new secret without being able to read any of them. The IDENTITY (private key)
is the single thing that must be protected. It lives OUTSIDE the repo at
`~/.config/age/<bot_name>.key`, and a copy belongs in the operator's password
manager, because a key that exists only on the box being backed up is not a
backup.

Deliberately NOT a passphrase. A passphrase-encrypted blob sitting in a repo is
an offline target: no rate limit, no lockout, unlimited guesses against a file
the attacker already holds. A generated X25519 key does not have that failure
mode.

## Usage

    secrets.py status            # what is sealed, what has drifted, what is missing
    secrets.py seal [--all|PATH] # encrypt plaintext -> secrets/*.age (commit these)
    secrets.py unseal [--all|PATH] --force   # decrypt back onto disk (bare-metal restore)

`seal` is safe to re-run: it skips files whose plaintext has not changed since
the last seal. `unseal` refuses to clobber an existing plaintext file without
--force, because a stale ciphertext overwriting a freshly-fixed local file is
exactly the silent-data-loss failure mode this is meant to avoid.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import instance_root, bot_name  # noqa: E402

REPO = instance_root()
SECRETS_DIR = REPO / "secrets"
RECIPIENT_FILE = SECRETS_DIR / "recipient.txt"
MANIFEST = SECRETS_DIR / "manifest.json"
IDENTITY = Path(os.environ.get("BOT_AGE_IDENTITY", Path.home() / ".config" / "age" / f"{bot_name()}.key"))

# Every secret the bot needs to run, and where it lives. Paths are relative to
# the repo root unless they start with '~', which is resolved against $HOME —
# the Telegram bot token lives in the channel plugin's own directory, outside
# the repo, and is just as load-bearing as the ones inside it.
#
# Keep this list in sync with what a bare-metal restore actually needs. The
# test for inclusion is: "if this box died, would the bot come back without
# this file?" If no, it belongs here.
SECRETS: list[str] = [
    ".env",
    "credentials.json",
    "token.json",
    ".claude/.oauth_token",
    "~/.claude/channels/telegram/.env",
]


def _resolve(rel: str) -> Path:
    if rel.startswith("~"):
        return Path.home() / rel[2:]
    return REPO / rel


def _sealed_path(rel: str) -> Path:
    """Flatten a source path into a single ciphertext filename.

    '~' becomes 'HOME' and separators become '__' so the sealed directory stays
    flat and a filename round-trips unambiguously back to its source.
    """
    key = rel.replace("~/", "HOME/").replace("\\", "/").replace("/", "__")
    return SECRETS_DIR / f"{key}.age"


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _age_bin() -> str:
    found = shutil.which("age")
    if not found:
        sys.exit(
            "age is not on PATH. Install it (single static binary) from "
            "https://github.com/FiloSottile/age/releases and put age(.exe) / "
            "age-keygen(.exe) on PATH."
        )
    return found


def _recipient() -> str:
    if not RECIPIENT_FILE.exists():
        sys.exit(
            f"no recipient at {RECIPIENT_FILE}.\n"
            f"Generate an identity first:  age-keygen -o {IDENTITY}\n"
            f"then:  age-keygen -y {IDENTITY} > {RECIPIENT_FILE}"
        )
    for line in RECIPIENT_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            return line
    sys.exit(f"{RECIPIENT_FILE} contains no recipient line")


def _load_manifest() -> dict:
    if MANIFEST.exists():
        try:
            return json.loads(MANIFEST.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            # A corrupt manifest must not block a re-seal — the ciphertexts are
            # the real artifact; the manifest is only a change-detection cache.
            return {}
    return {}


def _save_manifest(data: dict) -> None:
    SECRETS_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def cmd_status(_args: argparse.Namespace) -> int:
    manifest = _load_manifest()
    rows = []
    for rel in SECRETS:
        src, sealed = _resolve(rel), _sealed_path(rel)
        if not src.exists():
            state = "MISSING LOCALLY" if sealed.exists() else "absent (nothing to seal)"
        elif not sealed.exists():
            state = "NOT SEALED"
        elif manifest.get(rel, {}).get("sha256") != _sha256(src):
            state = "DRIFTED — reseal"
        else:
            state = "sealed"
        rows.append((state, rel, sealed.name if sealed.exists() else "-"))

    width = max(len(r[0]) for r in rows)
    for state, rel, sealed in rows:
        print(f"{state:<{width}}  {rel}   -> {sealed}")
    print(f"\nrecipient: {_recipient() if RECIPIENT_FILE.exists() else '(none)'}")
    print(f"identity : {IDENTITY} {'present' if IDENTITY.exists() else 'ABSENT — cannot unseal'}")
    return 0


def cmd_seal(args: argparse.Namespace) -> int:
    age, recipient = _age_bin(), _recipient()
    SECRETS_DIR.mkdir(parents=True, exist_ok=True)
    manifest = _load_manifest()
    targets = SECRETS if args.all else [args.path]

    changed = 0
    for rel in targets:
        src = _resolve(rel)
        if not src.exists():
            print(f"skip (absent): {rel}")
            continue
        digest = _sha256(src)
        sealed = _sealed_path(rel)
        if sealed.exists() and manifest.get(rel, {}).get("sha256") == digest and not args.force:
            print(f"unchanged:     {rel}")
            continue
        proc = subprocess.run(
            [age, "-r", recipient, "-o", str(sealed), str(src)],
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            print(f"FAILED:        {rel}: {proc.stderr.strip()}", file=sys.stderr)
            return 1
        manifest[rel] = {"sha256": digest, "sealed": sealed.name, "bytes": src.stat().st_size}
        changed += 1
        print(f"sealed:        {rel} -> secrets/{sealed.name}")

    _save_manifest(manifest)
    print(f"\n{changed} file(s) sealed. Commit secrets/ — the ciphertexts are the backup.")
    return 0


def cmd_unseal(args: argparse.Namespace) -> int:
    age = _age_bin()
    if not IDENTITY.exists():
        sys.exit(
            f"no identity at {IDENTITY} — cannot decrypt.\n"
            "Restore it from the password manager, or set BOT_AGE_IDENTITY."
        )
    targets = SECRETS if args.all else [args.path]

    restored = 0
    for rel in targets:
        sealed, dest = _sealed_path(rel), _resolve(rel)
        if not sealed.exists():
            print(f"skip (never sealed): {rel}")
            continue
        if dest.exists() and not args.force:
            # Refusing here is the whole point: a stale ciphertext must never
            # silently overwrite a freshly-fixed local file with an old copy —
            # a bug you had just fixed would come back looking unfixed.
            print(f"REFUSING to overwrite existing {rel} (use --force)")
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        proc = subprocess.run(
            [age, "-d", "-i", str(IDENTITY), "-o", str(dest), str(sealed)],
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            print(f"FAILED: {rel}: {proc.stderr.strip()}", file=sys.stderr)
            return 1
        restored += 1
        print(f"restored: secrets/{sealed.name} -> {rel}")

    print(f"\n{restored} file(s) restored.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="show what is sealed, drifted or missing").set_defaults(func=cmd_status)

    p_seal = sub.add_parser("seal", help="encrypt plaintext secrets into secrets/*.age")
    p_seal.add_argument("path", nargs="?", help="a single path from the SECRETS list")
    p_seal.add_argument("--all", action="store_true", help="seal every configured secret")
    p_seal.add_argument("--force", action="store_true", help="reseal even if unchanged")
    p_seal.set_defaults(func=cmd_seal)

    p_un = sub.add_parser("unseal", help="decrypt secrets back onto disk (bare-metal restore)")
    p_un.add_argument("path", nargs="?", help="a single path from the SECRETS list")
    p_un.add_argument("--all", action="store_true", help="restore every sealed secret")
    p_un.add_argument("--force", action="store_true", help="overwrite existing plaintext files")
    p_un.set_defaults(func=cmd_unseal)

    args = parser.parse_args()
    if args.cmd in ("seal", "unseal") and not args.all and not args.path:
        parser.error(f"{args.cmd}: give a PATH or --all")
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
