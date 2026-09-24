#!/usr/bin/env python3
"""
tg_send_video.py — send a video to Telegram via the Bot API sendVideo endpoint.

Stdlib only. Reads TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID from the bot's .env.
Sends as inline-playable video (not as a document).

Usage:
    python tools/tg/tg_send_video.py /abs/path/clip.mp4 "caption text"
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import instance_root  # noqa: E402

ENV_FILE = instance_root() / ".env"


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


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: tg_send_video.py <video_path> [caption]")

    video_path = Path(sys.argv[1])
    if not video_path.exists():
        sys.exit(f"error: {video_path} not found")
    caption = sys.argv[2] if len(sys.argv) >= 3 else ""

    env = load_env()
    token = env.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = env.get("TELEGRAM_CHAT_ID", "")
    if not token or not chat_id:
        sys.exit("error: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID required in .env")

    boundary = f"----BotVideo{int(time.time()*1000)}"
    video_bytes = video_path.read_bytes()

    body = b""
    body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n{chat_id}\r\n".encode("utf-8")
    body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"supports_streaming\"\r\n\r\ntrue\r\n".encode("utf-8")
    if caption:
        body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"caption\"\r\n\r\n{caption}\r\n".encode("utf-8")
    body += (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"video\"; "
        f"filename=\"{video_path.name}\"\r\nContent-Type: video/mp4\r\n\r\n"
    ).encode("utf-8")
    body += video_bytes
    body += f"\r\n--{boundary}--\r\n".encode("utf-8")

    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendVideo",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        resp = json.loads(urllib.request.urlopen(req, timeout=120).read())
        if resp.get("ok"):
            mid = resp.get("result", {}).get("message_id")
            print(f"sent (id: {mid})")
        else:
            sys.exit(f"send failed: {resp}")
    except Exception as e:
        sys.exit(f"send error: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
