#!/usr/bin/env python3
"""TG slash-command handler.

When the Director receives a Telegram message that starts with `/cmd`,
this script intercepts it (via the user-prompt-submit hook) and runs
the matching action. Reply is sent via tools/tg/tg_send.py.

Cannot force Claude Code's CLI `/compact` from outside the harness — but
the on-disk Slack-pattern channels (Journal + Timeline) ARE under our
control, so `/compact` here means: distill journal → timeline, summarize,
mark a checkpoint. Next session start picks up the clean state.

Supported commands:
  /status            — system status (cwd, git, ctx, sess, TG)
  /journal [n]       — last N journal entries (default 30)
  /timeline          — current critic timeline (head)
  /compact           — distill journal → timeline + checkpoint marker
  /board             — the task board, live
  /costs [Nd]        — per-session cost rollup
  /update            — update Claude Code; self-restart the bot if a new version landed
  /help              — list commands

Bot-level commands: <BOT_HOME>/tools/tg_commands_local.py exporting a
`HANDLERS` dict with the same handler signature is merged in at dispatch
time; the bot wins on a name collision.

Exit codes:
  0  command handled (caller should block the prompt from main thread)
  1  not a recognised command (caller should let the prompt pass)
  2  command handled but failed (caller still blocks; reply was sent)
"""
from __future__ import annotations

import importlib.util
import os
import shlex
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import instance_root, harness_root  # noqa: E402

REPO_ROOT = instance_root()
HARNESS_ROOT = harness_root()
PY_EXE = sys.executable or "python"

KNOWN = {"/status", "/journal", "/timeline", "/compact", "/board",
         "/costs", "/update", "/help"}


def _send_tg(text: str, reply_to: str | None = None) -> int:
    cmd = [PY_EXE, str(HARNESS_ROOT / "tools" / "tg" / "tg_send.py"), "--quiet"]
    if reply_to:
        cmd += ["--reply-to", reply_to]
    cmd.append(text)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=15, encoding="utf-8")
        return r.returncode
    except Exception as e:
        print(f"tg_send failed: {e}", file=sys.stderr)
        return 2


def _current_session() -> str:
    f = REPO_ROOT / ".claude" / ".current_session_id"
    if f.exists():
        try:
            return f.read_text(encoding="utf-8").strip()
        except Exception:
            pass
    return ""


def cmd_status(args: list[str], reply_to: str | None) -> int:
    r = subprocess.run(
        [PY_EXE, str(HARNESS_ROOT / "tools" / "v2" / "status_footer.py")],
        capture_output=True, text=True, timeout=5, encoding="utf-8",
    )
    body = (r.stdout or "(status unavailable)").strip()
    return _send_tg(body, reply_to)


def cmd_journal(args: list[str], reply_to: str | None) -> int:
    n = 30
    if args:
        try:
            n = max(1, min(200, int(args[0])))
        except ValueError:
            pass
    sess = _current_session()
    if not sess:
        return _send_tg("journal: no active session id", reply_to)
    jp = REPO_ROOT / "memory" / "sessions" / sess / "journal.md"
    if not jp.exists():
        return _send_tg(f"journal: no entries yet for {sess}", reply_to)
    lines = jp.read_text(encoding="utf-8").splitlines()
    entries = [ln for ln in lines if ln.strip().startswith("- [")]
    tail = entries[-n:]
    body = "\n".join(tail) if tail else "_(empty)_"
    out = f"**Journal** — last {len(tail)} of {len(entries)} entries\n\n```\n{body}\n```"
    return _send_tg(out, reply_to)


def cmd_timeline(args: list[str], reply_to: str | None) -> int:
    sess = _current_session()
    if not sess:
        return _send_tg("timeline: no active session id", reply_to)
    tp = REPO_ROOT / "memory" / "sessions" / sess / "timeline.md"
    if not tp.exists():
        return _send_tg(f"timeline: not yet built for {sess}. Run `/compact` first.", reply_to)
    body = tp.read_text(encoding="utf-8")
    if len(body) > 3500:
        body = body[:3500] + "\n\n…(truncated, see file)"
    return _send_tg(body, reply_to)


def cmd_compact(args: list[str], reply_to: str | None) -> int:
    """On-disk compaction-equivalent: distill journal → timeline + checkpoint.

    Runs DETACHED: this handler lives inside the UserPromptSubmit hook, which
    settings.json time-boxes to 15s — but the LLM distill takes up to 180s.
    Running it synchronously here got the hook killed mid-distill and the
    operator saw "distilling…" then nothing. run_hidden.py spawns the whole
    chain (summary → distill → checkpoint → TG confirmation) windowless and
    fire-and-forget; the confirmation message arrives when it finishes."""
    sess = _current_session()
    if not sess:
        return _send_tg("/compact: no active session id", reply_to)

    chain = (
        f'"{PY_EXE}" "{HARNESS_ROOT / "tools" / "infra" / "session_summarize.py"}" --quiet; '
        f'"{PY_EXE}" "{HARNESS_ROOT / "tools" / "v2" / "timeline.py"}" build {sess}; '
        f'"{PY_EXE}" "{HARNESS_ROOT / "tools" / "v2" / "journal.py"}" append {sess} '
        f'decision "TG /compact: timeline distilled, checkpoint marker for next-session resumption"; '
        f'"{PY_EXE}" "{HARNESS_ROOT / "tools" / "tg" / "tg_send.py"}" '
        f'"/compact done — timeline distilled for {sess[-8:]}. Next session start loads it."'
    )
    try:
        subprocess.run(
            [PY_EXE, str(HARNESS_ROOT / "tools" / "v2" / "run_hidden.py"), "--",
             "C:/Program Files/Git/bin/bash.exe", "-c", chain],
            timeout=15, capture_output=True,
        )
    except Exception as e:
        return _send_tg(f"/compact: failed to spawn distill: {e}", reply_to)

    return _send_tg(
        f"/compact: distilling session {sess[-8:]} in the background (~1-3 min) — "
        "I'll confirm here when the timeline is fresh.",
        reply_to,
    )


def cmd_update(args: list[str], reply_to: str | None) -> int:
    """Update Claude Code and self-restart the bot IF a new version landed.

    Supports `/update dry-run` and `/update check` for safe operator testing —
    these never kill the session. A bare `/update` runs the full flow:
    update_restart.py sends its own TG notice and terminates this session when
    an update lands, so we ack first and then hand off (don't capture output on
    the real path — the process may die mid-run)."""
    sub = (args[0].lower() if args else "")
    script = str(HARNESS_ROOT / "tools" / "v2" / "update_restart.py")

    # Under BotCorp the daemon's gate owns Claude Code updates (daemon/cc.ps1).
    if os.environ.get("BOTCORP_CLAUDE_EXE") and sub not in ("check", "check-only", "status"):
        return _send_tg("Claude Code is pinned by BotCorp: botcorp cc status", reply_to)

    if sub in ("dry-run", "dryrun", "dry"):
        _send_tg("/update: dry-run (no restart)…", reply_to)
        r = subprocess.run([PY_EXE, script, "--dry-run"],
                           capture_output=True, text=True, timeout=240, encoding="utf-8")
        body = (r.stdout or r.stderr or "(no output)").strip()
        if len(body) > 3500:
            body = body[:3500] + "\n…(truncated)"
        return _send_tg(f"**/update dry-run**\n```\n{body}\n```", reply_to)

    if sub in ("check", "check-only", "status"):
        r = subprocess.run([PY_EXE, script, "--check-only"],
                           capture_output=True, text=True, timeout=60, encoding="utf-8")
        body = (r.stdout or r.stderr or "(no output)").strip()
        return _send_tg(f"**/update check**\n```\n{body}\n```", reply_to)

    # Full flow. Ack first; update_restart.py owns the "restarting" / "already
    # current" reply and (if updated) terminates this session.
    _send_tg("/update: checking for a Claude Code update…", reply_to)
    try:
        subprocess.run([PY_EXE, script], timeout=300,
                       capture_output=True, text=True, encoding="utf-8")
    except Exception as e:
        return _send_tg(f"/update failed: {e}", reply_to)
    return 0


def cmd_costs(args: list[str], reply_to: str | None) -> int:
    """Roll up memory/metrics/sessions.csv. `/costs [Nd]` filters to last N days."""
    cmd = [PY_EXE, str(HARNESS_ROOT / "tools" / "v2" / "cost_report.py"), "--tg"]
    if args:
        n = args[0].rstrip("dD")
        if n.isdigit():
            cmd += ["--days", n]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=15, encoding="utf-8")
        body = (r.stdout or "").strip() or "costs: no data"
    except Exception as e:
        body = f"costs: failed ({e})"
    return _send_tg(body, reply_to)


_BOARD_MUTATORS = {"move", "set", "sync"}


def _board_env() -> dict:
    """Subprocess env for gh_projects.py: PYTHONIOENCODING + the GH_PROJECT_*
    config. The bot process doesn't load the repo .env into its environment, so
    fill any missing GH_PROJECT* var (owner/number/type + optional token) from
    the .env file. Anything already in os.environ wins."""
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    envfile = REPO_ROOT / ".env"
    if envfile.exists():
        try:
            for line in envfile.read_text(encoding="utf-8").splitlines():
                s = line.strip()
                if not s or s.startswith("#") or "=" not in s:
                    continue
                k, v = s.split("=", 1)
                k = k.strip()
                if k.startswith("GH_PROJECT") and not env.get(k):
                    env[k] = v.strip()
        except Exception:
            pass
    return env


def cmd_board(args: list[str], reply_to: str | None) -> int:
    """The task board, live in TG — backed by GitHub Projects v2 (gh_projects.py).

    Bare `/board` renders it; `move|set|sync|poll` pass through to the client.
    After a mutating edit we append the refreshed board so the reply shows both
    the confirmation and the new state.
    """
    script = str(HARNESS_ROOT / "tools" / "v2" / "gh_projects.py")
    env = _board_env()

    sub = args[0].lower() if args else ""
    if sub in ("help", "-h", "--help"):
        body = (
            "**/board — task board** (GitHub Projects v2 · single source of truth)\n"
            "• `/board` — show the board (grouped by Status)\n"
            "• `/board move <item> \"<status>\"` — set the Status column\n"
            "• `/board set <item> Priority P1` · `/board set <item> Size M`\n"
            "• `/board sync` — push memory/tasks/board.json onto the Project\n"
            "• `/board poll` — report status changes since the last snapshot\n"
            "_item = a unique title-substring or the item id. Views (columns) are UI-only — the API can't create them._"
        )
        return _send_tg(body, reply_to)

    if not args or sub in ("show", "render", "list"):
        cli = [PY_EXE, script, "render"]
    else:
        cli = [PY_EXE, script] + args

    try:
        r = subprocess.run(cli, capture_output=True, text=True, timeout=45,
                           encoding="utf-8", env=env)
    except Exception as e:
        return _send_tg(f"/board failed: {e}", reply_to)

    out = (r.stdout or r.stderr or "(no output)").strip()

    # After an edit, append the refreshed board so the operator sees the new state.
    if sub in _BOARD_MUTATORS and r.returncode == 0:
        try:
            rr = subprocess.run([PY_EXE, script, "render"], capture_output=True,
                                text=True, timeout=45, encoding="utf-8", env=env)
            if rr.stdout:
                out = f"✅ {out}\n\n{rr.stdout.strip()}"
        except Exception:
            pass

    return _send_tg(out, reply_to)


def cmd_help(args: list[str], reply_to: str | None) -> int:
    body = (
        "**TG slash commands**\n"
        "• `/status` — system status\n"
        "• `/journal [n]` — last N journal entries (default 30)\n"
        "• `/timeline` — current distilled timeline\n"
        "• `/compact` — distill journal → timeline + checkpoint\n"
        "• `/board` — the GitHub Projects task board, live (edit with `/board help`)\n"
        "• `/costs [Nd]` — per-session cost rollup (optional last-N-days filter)\n"
        "• `/update` — update Claude Code; self-restart the bot if a new version landed\n"
        "  (`/update dry-run` and `/update check` are safe, no restart)\n"
        "• `/help` — this list\n"
    )
    local = sorted(c for c in _local_handlers() if c not in HANDLERS)
    if local:
        body += "**Bot commands**\n" + "".join(f"• `{c}`\n" for c in local)
    return _send_tg(body, reply_to)


def _local_handlers() -> dict:
    """<BOT_HOME>/tools/tg_commands_local.py -> its HANDLERS (lower-cased keys),
    {} when absent or broken: a bad bot file must never take the core commands
    down with it."""
    f = REPO_ROOT / "tools" / "tg_commands_local.py"
    if not f.is_file():
        return {}
    try:
        spec = importlib.util.spec_from_file_location("tg_commands_local", f)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        h = getattr(mod, "HANDLERS", {})
        return {str(k).lower(): v for k, v in h.items() if callable(v)}
    except Exception as e:
        print(f"tg_commands_local: load failed: {e}", file=sys.stderr)
        return {}


HANDLERS = {
    "/status": cmd_status,
    "/journal": cmd_journal,
    "/timeline": cmd_timeline,
    "/compact": cmd_compact,
    "/board": cmd_board,
    "/costs": cmd_costs,
    "/update": cmd_update,
    "/help": cmd_help,
}


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: tg_commands.py <full prompt text>|- [reply_to_message_id]", file=sys.stderr)
        return 1
    # `-` = prompt on stdin. The hook always uses it: on Windows/Git Bash, MSYS
    # rewrites a leading-slash argv ("/help") into a Windows path, and a long
    # prompt overflows argv; stdin has neither problem.
    raw = sys.stdin.read().strip() if argv[1] == "-" else argv[1].strip()
    reply_to = argv[2] if len(argv) >= 3 and argv[2] else None

    if not raw.startswith("/"):
        return 1

    # Tokenize. Tolerate leading "/cmd args..."
    try:
        toks = shlex.split(raw)
    except ValueError:
        toks = raw.split()
    if not toks:
        return 1
    cmd = toks[0].lower()
    args = toks[1:]

    handlers = {**HANDLERS, **_local_handlers()}
    if cmd not in handlers:
        return 1

    handler = handlers[cmd]
    rc = handler(args, reply_to)
    return 0 if rc == 0 else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
