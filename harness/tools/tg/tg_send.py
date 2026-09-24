#!/usr/bin/env python3
"""
tg_send.py — send a Telegram message with auto HTML conversion + split.

Uses Telegram HTML parse mode (not MarkdownV2 — MD2's escape rules are brittle
and produce literal backslashes / broken formatting for oddly-shaped text).
HTML mode only needs `&`, `<`, `>` escaped and the tag set is small + predictable.

The bot writes natural CommonMark; this script converts to Telegram HTML.

Usage:
    python tools/tg/tg_send.py "**Hi** with `code`"
    echo "long text" | python tools/tg/tg_send.py
    python tools/tg/tg_send.py --chat-id <id> --reply-to <message_id> "text"
    python tools/tg/tg_send.py --plain "raw text, no formatting"

Behavior:
    - Token: TELEGRAM_BOT_TOKEN env var, then <config_home>/channels/telegram/.env,
      then <instance_root>/.env
    - Default chat_id: TELEGRAM_CHAT_ID env var, then <instance_root>/.env
    - Converts CommonMark idioms (**bold**, *italic*, _italic_, `code`,
      ```block```, [text](url)) to Telegram HTML
    - Splits at 4000 chars on newline boundaries
    - On HTTP 400 parse error, retries the same text in plain mode

Exit codes:
    0  all chunks sent
    1  bad arguments / config
    2  Telegram API failure (after fallback)
"""

import argparse
import datetime as _dt
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import instance_root, harness_root, config_home, runtime_root, bot_name  # noqa: E402

# MarkdownV2 reserved chars in normal text. Backslash MUST be escaped first
# (and re.sub handles the ordering correctly because the regex matches the
# literal `\` and replaces it with `\\` before moving past — the inserted `\`
# is not re-scanned). Without `\` in the set, any literal backslash in the
# source becomes Telegram's escape prefix for the next char, which throws a
# parse error if that char isn't a reserved one.
MD2_RESERVED = r"\_*[]()~`>#+-=|{}.!"
MD2_RESERVED_RE = re.compile(r"([\\_\*\[\]\(\)~`>#\+\-=\|\{\}\.!])")

MAX_CHUNK = 4000  # safe under TG's 4096 hard cap
TG_API = "https://api.telegram.org/bot{token}/sendMessage"


def _read_env_file(path: Path) -> dict:
    env = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            s = line.strip()
            if not s or s.startswith("#") or "=" not in s:
                continue
            k, v = s.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def resolve_token() -> str:
    if os.environ.get("TELEGRAM_BOT_TOKEN"):
        return os.environ["TELEGRAM_BOT_TOKEN"]
    plugin_env = _read_env_file(config_home() / "channels" / "telegram" / ".env")
    if plugin_env.get("TELEGRAM_BOT_TOKEN"):
        return plugin_env["TELEGRAM_BOT_TOKEN"]
    bot_env = _read_env_file(instance_root() / ".env")
    return bot_env.get("TELEGRAM_BOT_TOKEN", "")


def resolve_chat_id() -> str:
    if os.environ.get("TELEGRAM_CHAT_ID"):
        return os.environ["TELEGRAM_CHAT_ID"]
    bot_env = _read_env_file(instance_root() / ".env")
    return bot_env.get("TELEGRAM_CHAT_ID", "")


def escape_md2(text: str) -> str:
    """Escape reserved chars in normal MarkdownV2 text."""
    return MD2_RESERVED_RE.sub(r"\\\1", text)


def escape_md2_url(text: str) -> str:
    """Inside link parens — only ) and \\ need escaping."""
    return text.replace("\\", "\\\\").replace(")", "\\)")


def html_escape(s: str) -> str:
    """Escape only the 3 chars Telegram HTML cares about. Inside <code> and <pre>
       the same 3 chars need escaping; everything else passes through clean."""
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def to_html(text: str) -> str:
    """
    Convert natural CommonMark text to Telegram HTML.

    Recognizes:
        ```fenced code blocks```          → <pre><code>...</code></pre>
        `inline code`                      → <code>...</code>
        [link text](https://url)           → <a href="url">link text</a>
        **bold**                           → <b>bold</b>
        *italic* / _italic_                → <i>italic</i>
        # heading / ## subhead             → <b>heading</b> (TG has no h-tags)

    Everything else passes through with HTML-escaping (& < > → entities).
    Em-dashes, emoji, bullets, etc all render fine.
    """
    placeholders: list[str] = []

    def stash(s: str) -> str:
        idx = len(placeholders)
        placeholders.append(s)
        return f"\x00P{idx}P\x00"

    # Step 1 — fenced code blocks
    def repl_block(m):
        lang = (m.group(1) or "").strip()
        body = html_escape(m.group(2))
        if lang:
            return stash(f'<pre><code class="language-{html_escape(lang)}">{body}</code></pre>')
        return stash(f'<pre>{body}</pre>')
    text = re.sub(r"```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```", repl_block, text)

    # Step 2 — inline code
    def repl_inline(m):
        return stash(f"<code>{html_escape(m.group(1))}</code>")
    text = re.sub(r"`([^`\n]+)`", repl_inline, text)

    # Step 3 — links [text](url)
    def repl_link(m):
        link_text = html_escape(m.group(1))
        url = html_escape(m.group(2))
        return stash(f'<a href="{url}">{link_text}</a>')
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", repl_link, text)

    # Step 4 — bold (**text** OR __text__)
    def repl_bold(m):
        return stash(f"<b>{html_escape(m.group(1) or m.group(2))}</b>")
    text = re.sub(r"\*\*([^*\n]+)\*\*|__([^_\n]+)__", repl_bold, text)

    # Step 5 — italic (*text* OR _text_, but not adjacent to word chars to avoid
    # snake_case false positives)
    def repl_italic(m):
        return stash(f"<i>{html_escape(m.group(1) or m.group(2))}</i>")
    text = re.sub(r"(?<![*\w])\*([^*\n]+)\*(?!\w)|(?<![_\w])_([^_\n]+)_(?!\w)",
                  repl_italic, text)

    # Step 6 — markdown headings → bold (TG HTML has no <h1>/<h2>)
    def repl_heading(m):
        return stash(f"<b>{html_escape(m.group(2))}</b>")
    text = re.sub(r"(?m)^(#{1,6})\s+(.+)$", repl_heading, text)

    # Step 7 — escape everything else (only & < >)
    text = html_escape(text)

    # Step 8 — restore placeholders (fixed-point loop for nesting)
    for _ in range(10):
        changed = False
        for i, original in enumerate(placeholders):
            marker = f"\x00P{i}P\x00"
            if marker in text:
                text = text.replace(marker, original)
                changed = True
        if not changed:
            break

    return text


# Back-compat alias — old callers may import to_markdownv2.
to_markdownv2 = to_html


def split_chunks(text: str, max_len: int = MAX_CHUNK) -> list[str]:
    """Split on newline boundaries, keeping each chunk <= max_len."""
    if len(text) <= max_len:
        return [text]
    chunks = []
    while len(text) > max_len:
        # Prefer last \n\n then last \n then hard cut
        cut = text.rfind("\n\n", 0, max_len)
        if cut < max_len // 2:
            cut = text.rfind("\n", 0, max_len)
        if cut < max_len // 2:
            cut = max_len
        chunks.append(text[:cut].rstrip())
        text = text[cut:].lstrip("\n")
    if text:
        chunks.append(text)
    return chunks


def send_chunk(
    token: str, chat_id: str, text: str, parse_mode: str | None,
    reply_to: str | None,
) -> dict:
    payload = {"chat_id": chat_id, "text": text, "disable_web_page_preview": True}
    if parse_mode:
        payload["parse_mode"] = parse_mode
    if reply_to:
        payload["reply_to_message_id"] = int(reply_to)
        payload["allow_sending_without_reply"] = True

    req = urllib.request.Request(
        TG_API.format(token=token),
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        return {"ok": False, "http_status": e.code, "error": body}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def send_photo(token: str, chat_id: str, path: str, reply_to: int | None) -> dict:
    """sendPhoto via multipart (no caption — the formatted text message with the
    status footer is sent separately, so attachments never bypass the footer:
    raw plugin replies were once seen to drop footer+formatting)."""
    import mimetypes
    import uuid
    boundary = uuid.uuid4().hex
    with open(path, "rb") as f:
        img = f.read()
    fields = {"chat_id": chat_id}
    if reply_to:
        fields["reply_to_message_id"] = str(reply_to)
        fields["allow_sending_without_reply"] = "true"
    parts = []
    for k, v in fields.items():
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
        )
    ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
    fname = os.path.basename(path)
    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"photo\"; filename=\"{fname}\"\r\n"
        f"Content-Type: {ctype}\r\n\r\n".encode() + img + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)
    req = urllib.request.Request(
        TG_API.format(token=token).replace("/sendMessage", "/sendPhoto"),
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"ok": False, "http_status": e.code, "error": e.read().decode("utf-8", errors="replace")}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _unanswered_state_path() -> Path:
    return runtime_root() / "state" / bot_name() / "tg_unanswered.json"


def _unanswered_load() -> dict:
    try:
        return json.loads(_unanswered_state_path().read_text(encoding="utf-8"))
    except Exception:
        return {"count": 0, "since": None, "last": []}


def _unanswered_save(state: dict) -> None:
    try:
        p = _unanswered_state_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(state, indent=2), encoding="utf-8")
    except Exception:
        pass


def _unanswered_ok(args) -> bool:
    """False when the unanswered backlog is at the limit and this send is not exempt.

    Prints what to do instead rather than only refusing, because the refusal
    lands in an automated script's log where nobody is reading prose.
    """
    limit = int(os.environ.get("BOT_TG_UNANSWERED_MAX", "4") or 4)
    if limit <= 0 or getattr(args, "force", False):
        return True
    state = _unanswered_load()
    if state.get("count", 0) < limit:
        return True
    print(
        f"error: {state['count']} messages sent since the operator last replied "
        f"(limit {limit}).\n"
        "  Nothing more goes to their phone until they answer. Instead:\n"
        "  - a problem  -> triage and FIX it, report later in one place\n"
        "  - a decision -> add it to a review artifact "
        "(skill: review-artifact), one page, one link\n"
        f"  - they replied -> python tools/tg/tg_send.py --answered\n"
        "  - genuinely cannot wait -> --force (and expect to justify it)",
        file=sys.stderr,
    )
    return False


def main() -> int:
    p = argparse.ArgumentParser(description="Send a Telegram message with auto MD2 + split")
    p.add_argument("text", nargs="?", help="Message text. Reads stdin if omitted.")
    p.add_argument("--chat-id", help="Chat ID (default: TELEGRAM_CHAT_ID)")
    p.add_argument("--reply-to", help="Reply to this message_id (threads under it)")
    p.add_argument("--plain", action="store_true",
                   help="Send as plain text (skip MD2 conversion + escaping)")
    p.add_argument("--quiet", action="store_true", help="Suppress output on success")
    p.add_argument("--no-status", action="store_true",
                   help="Skip the status footer (default: append unless BOT_TG_STATUS=0)")
    p.add_argument("--photo", action="append", default=[],
                   help="Attach an image (repeatable). Sent AFTER the text message, threaded "
                        "under it, so formatting + status footer are never bypassed.")
    p.add_argument("--alert", action="store_true",
                   help="This is an automated monitor alert. It goes to memory/metrics/alerts.log "
                        "for the operator's agent to triage, NOT straight to their phone. Set "
                        "BOT_TG_ALERTS=1 to push them anyway.")
    p.add_argument("--answered", action="store_true",
                   help="The operator replied: clear the unanswered backlog and exit. Run this "
                        "on every inbound TG message.")
    p.add_argument("--force", action="store_true",
                   help="Send even when the unanswered backlog is at the limit. For something "
                        "that genuinely cannot wait for a reply, not for one more update.")
    p.add_argument("--unanswered", action="store_true",
                   help="Print the unanswered backlog and exit.")
    args = p.parse_args()

    if args.answered:
        _unanswered_save({"count": 0, "since": None, "last": []})
        print("unanswered backlog cleared")
        return 0
    if args.unanswered:
        st = _unanswered_load()
        print(f"{st.get('count', 0)} unanswered since {st.get('since') or 'never'}")
        for line in st.get("last", []):
            print(f"  - {line}")
        return 0

    text = args.text if args.text is not None else sys.stdin.read()
    if not text or not text.strip():
        print("error: empty text", file=sys.stderr)
        return 1

    body_text = text  # what the bot said, before the footer — this is what gets logged

    # Append status footer (default on; opt-out via flag or env)
    if not args.no_status and os.environ.get("BOT_TG_STATUS", "1") != "0":
        try:
            import subprocess as _sp
            python_exe = sys.executable or "python"
            footer_script = harness_root() / "tools" / "v2" / "status_footer.py"
            if footer_script.exists():
                # Cold-start (post-crash, box busy) footer work can be slow; give
                # it a real leash and a visible fallback instead of just vanishing.
                r = _sp.run(
                    [python_exe, str(footer_script)],
                    capture_output=True, text=True, timeout=10, encoding="utf-8",
                )
                footer = (r.stdout or "").strip()
                if footer:
                    text = text.rstrip() + "\n\n" + footer
                else:
                    text = text.rstrip() + f"\n\n📍 {bot_name()} · footer unavailable"
        except Exception:
            text = text.rstrip() + f"\n\n📍 {bot_name()} · footer unavailable"

    # Global mute. A test that drives a code path with a real TG send in it
    # messages a real person — a per-test stub is still the right thing to
    # write, but it is a thing a future test can forget. This is the floor
    # underneath it: set BOT_TG_MUTE=1 and nothing reaches the API, whatever
    # the caller does. Deliberately at THIS layer, because every tool in the
    # repo sends through here. Automated alerts do not go to a person.
    #
    # Repeating the same handful of automated conditions hourly does not make
    # them need a human, it just makes the messages that DO need one harder to
    # find. So an alert lands in a log the operator's agent reads and acts on.
    # If the fix genuinely needs a decision, that decision belongs in a review
    # artifact alongside the others, not in a 3am push.
    if args.alert:
        # Log EVERY alert, including the ones that also get pushed, so the
        # triage log is a complete record rather than only the quiet half.
        try:
            log = instance_root() / "memory" / "metrics" / "alerts.log"
            log.parent.mkdir(parents=True, exist_ok=True)
            stamp = _dt.datetime.now().isoformat(timespec="seconds")
            one_line = " | ".join(l.strip() for l in text.strip().splitlines() if l.strip())
            with log.open("a", encoding="utf-8") as fh:
                fh.write(f"{stamp}\t{one_line[:600]}\n")
        except Exception:
            pass

        # Severity gates the silence. Routing ALL alerts to a log is too broad
        # when something is actually critical — a "LIVE site DOWN" sitting
        # unread in a log the operator's agent only reads on a tick is a worse
        # failure than the noise quieting a repeated warning was meant to fix.
        #
        # Word-boundary, and the matched text is printed rather than a count, so
        # a substring cannot quietly promote or demote an alert.
        crit = re.search(r"(?<![A-Za-z])CRITICAL(?![A-Za-z])", text, re.I)
        push = crit is not None or os.environ.get("BOT_TG_ALERTS", "0") == "1"
        if not push:
            print("[alert] logged for triage, not sent", file=sys.stderr)
            return 0
        # A critical alert is the "genuinely cannot wait" case the backlog guard
        # carves out, so it is not held behind an unanswered count.
        args.force = True
        print(f"[alert] logged AND sending (matched {crit.group(0)!r})" if crit
              else "[alert] logged AND sending (BOT_TG_ALERTS=1)", file=sys.stderr)

    # Unanswered-backlog guard.
    #
    # No message in a flood is individually wrong, which is exactly why a
    # style rule alone does not stop it: the judgement is made one message at
    # a time, and one more is always defensible. So the count lives outside
    # the judgement. Past the threshold the send fails loudly and says what to
    # do instead: put decisions in a review artifact and fix everything else
    # silently.
    #
    # Deliberately at THIS layer: a flood is mostly automated health and
    # worklist pushes from other scripts, and they all send through here.
    # Checked BEFORE the mute: the guard answers "should this be sent at all",
    # the mute answers "may it reach the API". Asking them in that order also
    # means the guard is exercisable under BOT_TG_MUTE=1, so it can be tested
    # without messaging a real person.
    if not _unanswered_ok(args):
        return 3

    if os.environ.get("BOT_TG_MUTE", "0") == "1":
        print("[BOT_TG_MUTE] suppressed TG send:\n" + text[:2000], file=sys.stderr)
        return 0

    token = resolve_token()
    chat_id = args.chat_id or resolve_chat_id()
    if not token or not chat_id:
        print("error: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID required", file=sys.stderr)
        return 1

    if args.plain:
        chunks = split_chunks(text)
        parse_mode = None
    else:
        html = to_html(text)
        chunks = split_chunks(html)
        parse_mode = "HTML"

    sent_ids = []
    for i, chunk in enumerate(chunks):
        # First chunk threads under reply_to (if set), rest don't
        reply_to = args.reply_to if i == 0 else None
        result = send_chunk(token, chat_id, chunk, parse_mode, reply_to)
        if not result.get("ok"):
            # Fall back to plain text once if it was a parse error
            if parse_mode == "HTML" and "parse" in str(result.get("error", "")).lower():
                # Log the converted text + the API error so future failures are debuggable.
                print(f"  html parse failed on chunk {i+1}, falling back to plain", file=sys.stderr)
                print(f"    api error: {str(result.get('error', ''))[:300]}", file=sys.stderr)
                print(f"    converted text head: {chunk[:200]!r}", file=sys.stderr)
                # Re-split the ORIGINAL text in plain mode and resend everything
                plain_chunks = split_chunks(text)
                sent_ids = []
                for j, pc in enumerate(plain_chunks):
                    rt = args.reply_to if j == 0 else None
                    r = send_chunk(token, chat_id, pc, None, rt)
                    if not r.get("ok"):
                        print(f"  plain fallback also failed: {r}", file=sys.stderr)
                        return 2
                    sent_ids.append(r["result"]["message_id"])
                break
            print(f"  send failed: {result}", file=sys.stderr)
            return 2
        sent_ids.append(result["result"]["message_id"])

    # Counted only on a send that actually reached the API, so a failed send
    # cannot use up the budget, and counted once per call rather than per chunk:
    # splitting one long answer is a formatting detail, not another interruption.
    _st = _unanswered_load()
    _st["count"] = _st.get("count", 0) + 1
    _st["since"] = _st.get("since") or _dt.datetime.now().isoformat(timespec="seconds")
    _st["last"] = (_st.get("last", []) + [text.strip().splitlines()[0][:90]])[-10:]
    _unanswered_save(_st)

    # Outbound side of the bot's own chat log (memory/tg/<chat_id>.jsonl) —
    # the plugin's `reply` tool cannot be hooked, so this is the logged path.
    # Fail-open: a log problem must never turn a delivered message into exit 2.
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from tg_log import log_out
        if sent_ids:
            log_out(chat_id, sent_ids[0], body_text)
    except Exception:
        pass

    # Photos ride AFTER the text, threaded under the first sent message.
    for photo in args.photo:
        if not os.path.exists(photo):
            print(f"  photo not found: {photo}", file=sys.stderr)
            continue
        r = send_photo(token, chat_id, photo, sent_ids[0] if sent_ids else None)
        if r.get("ok"):
            sent_ids.append(r["result"]["message_id"])
        else:
            print(f"  photo send failed: {str(r.get('error', ''))[:200]}", file=sys.stderr)

    if not args.quiet:
        for mid in sent_ids:
            print(mid)
    return 0


if __name__ == "__main__":
    sys.exit(main())
