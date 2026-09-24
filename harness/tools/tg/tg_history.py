#!/usr/bin/env python3
"""
tg_history.py — recall from the bot's own Telegram log (memory/tg/<chat_id>.jsonl,
written by tg_log.py). One compact line per message.

    tail   <chat_id> [N]              last N messages (default 20)
    search <chat_id> "<text>"         case-insensitive substring match
    show   <chat_id> <message_id>     full text + any media notes (path/transcript)
    quote  <chat_id> <message_id>     a --reply-to ready tg_send.py snippet

Line format: <ts> <in|out> #<message_id> <user> [<kind>] <text, one line>
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tg_log import read_log  # noqa: E402


def _messages(chat_id: str) -> list[dict]:
    return [e for e in read_log(chat_id) if e.get("direction") in ("in", "out")]


def _notes(chat_id: str, message_id: str) -> list[dict]:
    return [e for e in read_log(chat_id)
            if e.get("direction") == "note" and str(e.get("message_id")) == str(message_id)]


def _line(e: dict, width: int = 200) -> str:
    text = " ".join((e.get("text") or "").split())
    if len(text) > width:
        text = text[: width - 1] + "…"
    kind = e.get("kind", "text")
    tag = "" if kind == "text" else f" [{kind}]"
    return f"{e.get('ts','')} {e.get('direction','?'):<3} #{e.get('message_id','')} {e.get('user','')}{tag} {text}"


def cmd_tail(chat_id: str, n: int) -> int:
    for e in _messages(chat_id)[-n:]:
        print(_line(e))
    return 0


def cmd_search(chat_id: str, needle: str) -> int:
    needle = needle.lower()
    hits = 0
    for e in _messages(chat_id):
        hay = (e.get("text") or "").lower()
        for note in _notes(chat_id, e.get("message_id", "")):
            hay += " " + (note.get("transcript") or "").lower()
        if needle in hay:
            print(_line(e))
            hits += 1
    return 0 if hits else 1


def _find(chat_id: str, message_id: str) -> dict | None:
    for e in _messages(chat_id):
        if str(e.get("message_id")) == str(message_id):
            return e
    return None


def cmd_show(chat_id: str, message_id: str) -> int:
    e = _find(chat_id, message_id)
    if not e:
        print(f"no message #{message_id} in chat {chat_id}", file=sys.stderr)
        return 1
    print(_line(e, width=10**6))
    for k in ("reply_to_message_id", "image_path", "attachment_file_id",
              "attachment_mime", "attachment_name", "attachment_size"):
        if e.get(k):
            print(f"  {k}: {e[k]}")
    for note in _notes(chat_id, message_id):
        if note.get("path"):
            print(f"  path: {note['path']}")
        if note.get("transcript"):
            print(f"  transcript: {note['transcript']}")
    return 0


def cmd_quote(chat_id: str, message_id: str) -> int:
    e = _find(chat_id, message_id)
    if not e:
        print(f"no message #{message_id} in chat {chat_id}", file=sys.stderr)
        return 1
    text = " ".join((e.get("text") or "").split())
    if len(text) > 120:
        text = text[:119] + "…"
    print(f'python tools/tg/tg_send.py --chat-id {chat_id} --reply-to {message_id} '
          f'"> {e.get("user","")}: {text}\n\n<your reply>"')
    return 0


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 1
    cmd, chat_id, rest = argv[0], argv[1], argv[2:]
    if cmd == "tail":
        return cmd_tail(chat_id, int(rest[0]) if rest else 20)
    if cmd == "search" and rest:
        return cmd_search(chat_id, " ".join(rest))
    if cmd == "show" and rest:
        return cmd_show(chat_id, rest[0])
    if cmd == "quote" and rest:
        return cmd_quote(chat_id, rest[0])
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
