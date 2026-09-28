"""The bot's ONE review board: where its permanent review Artifact lives.

With harness.modules.review_board on, a bot keeps a single private review
Artifact (skill `review-artifact`) and always republishes to the same URL. The
URL is the bot's own runtime state, not config, so it lives in
<BOT_HOME>/.botcorp/review-board.json:

    {"url": ..., "updated": ..., "open": N, "answered": M, "sent_at": ...}

The cockpit links it in the bot header and session start injects one line with
it. Nothing here is a secret: an Artifact link opens only for its owner.

    review_board.py set-url <url> [--replace]   record the board (a second one is refused)
    review_board.py status [--from-page FILE] [--open N] [--answered M] [--sent-at ISO]
    review_board.py show                        the record as JSON
    review_board.py line                        the session-start line ('' when off or none)

Every verb but `line` refuses (exit 2) while the module is off.
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import instance_root, module_enabled  # noqa: E402

MODULE = "review_board"
# A private claude.ai Artifact link. A public share link is not a board.
URL_RE = re.compile(r"^https://claude\.ai/(?:code/)?artifact/[A-Za-z0-9][A-Za-z0-9-]{7,}/?$")
STATE_RE = re.compile(r'<script[^>]*\bid="review-state"[^>]*>(.*?)</script>', re.S)


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def record_path() -> Path:
    return instance_root() / ".botcorp" / "review-board.json"


def read_record() -> dict:
    try:
        rec = json.loads(record_path().read_text(encoding="utf-8"))
        return rec if isinstance(rec, dict) else {}
    except (OSError, ValueError):
        return {}


def write_record(rec: dict) -> None:
    p = record_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(rec, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, p)


def counts_from_page(html: str) -> dict:
    """open / answered / sent_at from the page's review-state block.

    open = listed items with no answer yet, answered = listed items with one
    (items that moved to Done are no longer listed). A page without an `items`
    list (the pre-board shape) gives open None.
    """
    m = STATE_RE.search(html)
    if not m:
        raise ValueError('no <script id="review-state"> block in the page')
    state = json.loads(m.group(1))
    answers = state.get("answers") or {}
    items = state.get("items")
    out = {"sent_at": state.get("sentAt")}
    if isinstance(items, list):
        ids = [str(i) for i in items]
        out["answered"] = sum(1 for i in ids if (answers.get(i) or {}).get("answer"))
        out["open"] = len(ids) - out["answered"]
    else:
        out["answered"] = sum(1 for a in answers.values() if isinstance(a, dict) and a.get("answer"))
        out["open"] = None
    return out


def _flag(argv: list[str], name: str) -> str | None:
    if name in argv:
        i = argv.index(name)
        if i + 1 < len(argv):
            return argv[i + 1]
        raise SystemExit(f"{name} needs a value")
    return None


def cmd_set_url(argv: list[str]) -> int:
    if not argv:
        print("usage: review_board.py set-url <url> [--replace]", file=sys.stderr)
        return 2
    url = argv[0].strip()
    if not URL_RE.match(url):
        print(f"refused: {url!r} is not a claude.ai artifact link (https://claude.ai/artifact/<id> or https://claude.ai/code/artifact/<id>)", file=sys.stderr)
        return 2
    rec = read_record()
    if rec.get("url") and rec["url"] != url and "--replace" not in argv:
        print(f"refused: this bot already has a board at {rec['url']}. Republish to that URL and add the new items there; "
              "--replace only when the operator asked for a new board.", file=sys.stderr)
        return 2
    if rec.get("url") != url:
        rec = {"url": url, "open": None, "answered": None, "sent_at": None}
    rec["updated"] = _now()
    write_record(rec)
    print(json.dumps(rec))
    return 0


def cmd_status(argv: list[str]) -> int:
    rec = read_record()
    if not rec.get("url"):
        print("refused: no board recorded yet (review_board.py set-url <url> after the first publish)", file=sys.stderr)
        return 2
    page = _flag(argv, "--from-page")
    if page:
        try:
            rec.update(counts_from_page(Path(page).read_text(encoding="utf-8")))
        except (OSError, ValueError) as e:
            print(f"refused: {page}: {e}", file=sys.stderr)
            return 2
    for flag, key in (("--open", "open"), ("--answered", "answered")):
        v = _flag(argv, flag)
        if v is not None:
            if not v.isdigit():
                print(f"refused: {flag} takes a count (got {v!r})", file=sys.stderr)
                return 2
            rec[key] = int(v)
    sent = _flag(argv, "--sent-at")
    if sent is not None:
        rec["sent_at"] = sent
    rec["updated"] = _now()
    write_record(rec)
    print(json.dumps(rec))
    return 0


def session_line() -> str:
    if not module_enabled(MODULE):
        return ""
    rec = read_record()
    url = rec.get("url")
    if not (isinstance(url, str) and URL_RE.match(url)):
        return ""
    n = rec.get("open")
    left = f"{n} open" if isinstance(n, int) else "open count not recorded"
    return f"Review board: {url} ({left}). Republish to this URL; never start a second board (skill review-artifact)."


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in ("-h", "--help", "help"):
        print(__doc__)
        return 0 if len(argv) >= 2 else 2
    cmd, rest = argv[1], argv[2:]
    if cmd == "line":
        line = session_line()
        if line:
            print(line)
        return 0
    if not module_enabled(MODULE):
        print(f"refused: the {MODULE} module is off for this bot (harness.modules.{MODULE} in bot.yaml); nothing written", file=sys.stderr)
        return 2
    if cmd == "set-url":
        return cmd_set_url(rest)
    if cmd == "status":
        return cmd_status(rest)
    if cmd == "show":
        print(json.dumps(read_record() or {"url": None}))
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
