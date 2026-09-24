#!/usr/bin/env python3
"""
tg_log.py — the bot's own Telegram chat log.

Telegram's Bot API keeps no history: a message is seen once, as it arrives,
and is gone. So the bot keeps its own, one JSON line per message under
memory/tg/<chat_id>.jsonl (gitignored — other people's messages).

    ingest                      stdin = a prompt; every <channel source="telegram">
                                tag in it is appended (idempotent on chat+message id)
    out <chat_id> <message_id>  record one of our own sends (stdin or --text)
    note <chat_id> <message_id> --path <p> [--transcript-file <f>]
                                attach the local path / transcript of handled media

Line shape (in):  {ts, direction:"in", chat_id, message_id, user, user_id, kind,
                   text, reply_to_message_id?, image_path?, attachment_file_id?,
                   attachment_mime?, attachment_name?, attachment_size?}
Line shape (out): {ts, direction:"out", chat_id, message_id, user:"bot", kind:"text", text}
Line shape (note):{ts, direction:"note", chat_id, message_id, path?, transcript?}

Every entry point is fail-open: a broken log must never block a prompt, so
`ingest` exits 0 on any error. Callers in tg_send.py wrap the import too.
"""

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import instance_root  # noqa: E402


def _log_dir() -> Path:
    # Resolved per call, not at import: a test (or tool) that imports this
    # module before BOT_HOME is set must not pin the log dir to the cwd.
    return instance_root() / "memory" / "tg"


# The channel plugin can source-tag a message as either "telegram" or
# "plugin:telegram:telegram" depending on version (found in the wild: matching
# only one spelling silently stopped inbound logging for a week). Accept both.
TAG_RE = re.compile(
    r'<channel\s+source="(?:plugin:telegram:)?telegram"([^>]*)>(.*?)</channel>', re.DOTALL
)
ATTR_RE = re.compile(r'([a-zA-Z_]+)="([^"]*)"')

MEDIA_ATTRS = (
    "image_path", "attachment_file_id", "attachment_mime",
    "attachment_name", "attachment_size", "reply_to_message_id",
)


def log_path(chat_id: str) -> Path:
    safe = re.sub(r"[^0-9A-Za-z_-]", "_", str(chat_id)) or "unknown"
    return _log_dir() / f"{safe}.jsonl"


def read_log(chat_id: str) -> list[dict]:
    p = log_path(chat_id)
    if not p.exists():
        return []
    out = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except Exception:
            continue
    return out


def _append(chat_id: str, entry: dict) -> None:
    _log_dir().mkdir(parents=True, exist_ok=True)
    with open(log_path(chat_id), "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def _seen(chat_id: str, message_id: str) -> bool:
    return any(
        e.get("direction") == "in" and str(e.get("message_id")) == str(message_id)
        for e in read_log(chat_id)
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_prompt(prompt: str) -> list[dict]:
    """All inbound Telegram messages in a prompt, as log entries."""
    entries = []
    for m in TAG_RE.finditer(prompt):
        attrs = dict(ATTR_RE.findall(m.group(1)))
        chat_id = attrs.get("chat_id")
        message_id = attrs.get("message_id")
        if not chat_id or not message_id:
            continue
        if attrs.get("image_path"):
            kind = "photo"
        elif attrs.get("attachment_kind"):
            kind = attrs["attachment_kind"]
        elif attrs.get("attachment_file_id"):
            kind = "document"
        else:
            kind = "text"
        e = {
            "ts": attrs.get("ts") or _now(),
            "direction": "in",
            "chat_id": chat_id,
            "message_id": message_id,
            "user": attrs.get("user", ""),
            "user_id": attrs.get("user_id", ""),
            "kind": kind,
            "text": m.group(2).strip("\n"),
        }
        for k in MEDIA_ATTRS:
            if attrs.get(k):
                e[k] = attrs[k]
        entries.append(e)
    return entries


def ingest(prompt: str) -> int:
    """Append every unseen inbound message. Returns the number written."""
    n = 0
    for e in parse_prompt(prompt):
        if _seen(e["chat_id"], e["message_id"]):
            continue
        _append(e["chat_id"], e)
        n += 1
    return n


def log_out(chat_id: str, message_id, text: str) -> None:
    _append(str(chat_id), {
        "ts": _now(), "direction": "out", "chat_id": str(chat_id),
        "message_id": str(message_id), "user": "bot", "kind": "text", "text": text,
    })


def log_note(chat_id: str, message_id: str, path: str | None, transcript: str | None) -> None:
    e = {"ts": _now(), "direction": "note", "chat_id": str(chat_id),
         "message_id": str(message_id)}
    if path:
        e["path"] = path
    if transcript is not None:
        e["transcript"] = transcript
    _append(str(chat_id), e)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("ingest")
    o = sub.add_parser("out")
    o.add_argument("chat_id")
    o.add_argument("message_id")
    o.add_argument("--text", help="sent text (stdin if omitted)")
    n = sub.add_parser("note")
    n.add_argument("chat_id")
    n.add_argument("message_id")
    n.add_argument("--path", help="local path of the downloaded/handled media")
    n.add_argument("--transcript-file", help="file holding the transcript text")
    args = p.parse_args()

    if args.cmd == "ingest":
        try:
            count = ingest(sys.stdin.read())
            print(f"logged {count}")
        except Exception as exc:  # fail-open: never block the prompt
            print(f"tg_log: ingest skipped: {exc}", file=sys.stderr)
        return 0
    if args.cmd == "out":
        text = args.text if args.text is not None else sys.stdin.read()
        log_out(args.chat_id, args.message_id, text)
        return 0
    if args.cmd == "note":
        transcript = None
        if args.transcript_file:
            transcript = Path(args.transcript_file).read_text(encoding="utf-8", errors="replace").strip()
        log_note(args.chat_id, args.message_id, args.path, transcript)
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
