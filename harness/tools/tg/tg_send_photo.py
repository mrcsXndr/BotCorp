#!/usr/bin/env python3
"""
tg_send_photo.py — send a photo to Telegram via the Bot API.

Stdlib only. Reads TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID from the bot's .env.

Usage:
    python tools/tg/tg_send_photo.py <photo_path> [caption]
    python tools/tg/tg_send_photo.py /path/to/screenshot.png "Look at this"
"""

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import instance_root  # noqa: E402

ENV_FILE = instance_root() / ".env"

# Reuse tg_send.py's CommonMark->HTML converter so photo captions render the same
# as text messages (bold/italic/links/code), instead of showing literal **markdown**.
sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from tg_send import to_html as _to_html
except Exception:  # pragma: no cover - fail open to plain text
    _to_html = None


def load_env() -> dict:
    env = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            s = line.strip()
            if not s or s.startswith("#") or "=" not in s:
                continue
            k, v = s.split("=", 1)
            env[k.strip()] = v.strip()
    return env


CAPTION_LIMIT = 1000  # Telegram's hard limit is 1024; leave headroom for the truncation marker.


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: tg_send_photo.py <photo_path> [caption]")

    photo_path = Path(sys.argv[1])
    if not photo_path.exists():
        sys.exit(f"error: {photo_path} not found")
    caption = sys.argv[2] if len(sys.argv) >= 3 else ""

    # Telegram caps photo captions at 1024 chars. Truncate at a word boundary
    # so we never hit the API limit blind. Caller can pre-trim if they need
    # the full text — this is a safety net.
    if len(caption) > CAPTION_LIMIT:
        cut = caption.rfind(" ", 0, CAPTION_LIMIT - 12)
        if cut < CAPTION_LIMIT // 2:
            cut = CAPTION_LIMIT - 12
        caption = caption[:cut].rstrip() + " [truncated]"

    env = load_env()
    token = env.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = env.get("TELEGRAM_CHAT_ID", "")
    if not token or not chat_id:
        sys.exit("error: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID required in .env")

    photo_bytes = photo_path.read_bytes()
    # HTML-render the caption (truncation above ran on the raw text so we never
    # cut a tag). parse_mode is dropped in the plain fallback below.
    caption_html = _to_html(caption) if (caption and _to_html) else caption

    def build_body(cap: str, parse_mode: str | None) -> tuple[bytes, str]:
        boundary = f"----BotPhoto{int(time.time()*1000)}"
        body = b""
        body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n{chat_id}\r\n".encode("utf-8")
        if cap:
            body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"caption\"\r\n\r\n{cap}\r\n".encode("utf-8")
        if parse_mode:
            body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"parse_mode\"\r\n\r\n{parse_mode}\r\n".encode("utf-8")
        body += (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"photo\"; "
            f"filename=\"{photo_path.name}\"\r\nContent-Type: image/png\r\n\r\n"
        ).encode("utf-8")
        body += photo_bytes
        body += f"\r\n--{boundary}--\r\n".encode("utf-8")
        return body, boundary

    def post(cap: str, parse_mode: str | None):
        body, boundary = build_body(cap, parse_mode)
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{token}/sendPhoto",
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        return json.loads(urllib.request.urlopen(req, timeout=30).read())

    try:
        # Try HTML first; if Telegram rejects the entities, fall back to the raw
        # (unconverted) caption as plain text so the message still goes out.
        try:
            resp = post(caption_html, "HTML" if (caption and _to_html) else None)
            if not resp.get("ok"):
                raise ValueError(resp)
        except (urllib.error.HTTPError, ValueError):
            resp = post(caption, None)
        if resp.get("ok"):
            print(f"sent (id: {resp.get('result', {}).get('message_id')})")
        else:
            sys.exit(f"send failed: {resp}")
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        sys.exit(f"send error: HTTP {e.code} — {err[:400]}")
    except Exception as e:
        sys.exit(f"send error: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
