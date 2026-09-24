#!/usr/bin/env python3
"""tg_pair — pre-authorize a Telegram chat id with the official channel plugin.

Merges <chat_id> into the `allowFrom` list of
<config-dir>/channels/telegram/access.json, so the owner's FIRST message is
accepted without the /telegram:access pairing dance. For a direct message the
chat id equals the sender's user id, which is exactly what allowFrom holds.

Idempotent: existing entries, groups, policy AND any pending pairing are
preserved; re-running with the same id is a no-op. The setup wizard calls
this automatically when you provide a chat id; you can also run it by hand.

Usage: python tools/tg/tg_pair.py <chat_id> [--config-dir <path>]
Exit:  0 ok, 1 write failure, 2 bad usage
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import config_home  # noqa: E402


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("chat_id", nargs="?")
    ap.add_argument("--config-dir", default=None,
                     help="Claude Code config dir (default: config_home())")
    try:
        args = ap.parse_args(argv)
    except SystemExit:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    if not args.chat_id or not args.chat_id.strip():
        print(__doc__.strip(), file=sys.stderr)
        return 2
    chat_id = args.chat_id.strip()

    base = Path(args.config_dir).expanduser() if args.config_dir else config_home()
    access_path = base / "channels" / "telegram" / "access.json"

    data: dict = {"dmPolicy": "pairing", "allowFrom": [], "groups": {}, "pending": {}}
    try:
        with open(access_path, encoding="utf-8") as f:
            loaded = json.load(f)
        if isinstance(loaded, dict):
            data.update(loaded)
    except (OSError, ValueError):
        pass  # missing/corrupt file -> start from the defaults above

    allow = data.get("allowFrom")
    if not isinstance(allow, list):
        allow = data["allowFrom"] = []
    if chat_id not in {str(a) for a in allow}:
        allow.append(chat_id)

    try:
        os.makedirs(access_path.parent, exist_ok=True)
        with open(access_path, "w", encoding="utf-8", newline="\n") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
    except OSError as e:
        print(f"tg_pair: could not write {access_path}: {e}", file=sys.stderr)
        return 1

    print(f"tg_pair: chat id {chat_id} authorized in {access_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
