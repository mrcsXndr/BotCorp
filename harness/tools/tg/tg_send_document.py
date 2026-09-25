#!/usr/bin/env python3
"""
tg_send_document.py — send a document/file to Telegram via the Bot API.

Stdlib only. Token and default chat resolve as in tg_send.py (the session env
first, then the bot's .env, bot.yaml chat_id, the only allowlisted id).
BOT_TG_MUTE=1 sends nothing.

Usage:
    python tools/tg/tg_send_document.py <file_path> [caption]
    python tools/tg/tg_send_document.py /path/to/script.js "Statusline script"
"""

import json
import mimetypes
import os
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tg_send import NO_CHAT_HINT, resolve_chat_id, resolve_token  # noqa: E402


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: tg_send_document.py <file_path> [caption]")

    doc_path = Path(sys.argv[1])
    if not doc_path.exists():
        sys.exit(f"error: {doc_path} not found")
    caption = sys.argv[2] if len(sys.argv) >= 3 else ""

    if os.environ.get("BOT_TG_MUTE", "0") == "1":
        print(f"[BOT_TG_MUTE] suppressed TG document: {doc_path.name}", file=sys.stderr)
        return
    token = resolve_token()
    chat_id = resolve_chat_id()
    if not token:
        sys.exit("error: no TELEGRAM_BOT_TOKEN (env, <config home>/channels/telegram/.env, <bot>/.env)")
    if not chat_id:
        sys.exit(f"error: {NO_CHAT_HINT}")

    boundary = f"----BotDoc{int(time.time()*1000)}"
    doc_bytes = doc_path.read_bytes()
    mime, _ = mimetypes.guess_type(str(doc_path))
    if not mime:
        mime = "application/octet-stream"

    body = b""
    body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n{chat_id}\r\n".encode("utf-8")
    if caption:
        body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"caption\"\r\n\r\n{caption}\r\n".encode("utf-8")
    body += (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"document\"; "
        f"filename=\"{doc_path.name}\"\r\nContent-Type: {mime}\r\n\r\n"
    ).encode("utf-8")
    body += doc_bytes
    body += f"\r\n--{boundary}--\r\n".encode("utf-8")

    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendDocument",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        resp = json.loads(urllib.request.urlopen(req, timeout=60).read())
        if resp.get("ok"):
            mid = resp.get("result", {}).get("message_id")
            print(f"sent (id: {mid})")
        else:
            sys.exit(f"send failed: {resp}")
    except Exception as e:
        sys.exit(f"send error: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
