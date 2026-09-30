#!/usr/bin/env python3
"""usage_monitor.py — record a Claude usage-limit block and TG-alert ONCE per
window, then auto-resume once it lifts.

Why this exists: when the Claude subscription usage limit is reached
mid-session, the CC process itself is blocked and CANNOT send Telegram — so
the operator just sees the bot go silent and "can't continue from here". This
monitor is fed by harness hooks (StopFailure / Notification), which is why it
can still act even though the blocked session itself cannot.

Detection is HOOK-FED first: a StopFailure hook calls
`record-block --stdin` with the failure payload the instant a limit block
happens, and a Notification hook calls `record-notification --stdin` when the
harness's own auto-resume mechanism fires (or reports itself stale/disabled).
The daemon's `--resume-check` also scans the transcript for CC's limit banner,
the fallback for a StopFailure hook that was cancelled or never ran.

Behaviour:
  - `record-block --stdin`: parse a reset time out of the StopFailure error
    message if present, else assume now + 5h. Dedupe against an
    already-announced block (see limit_window.py) and TG-alert once.
  - `record-notification --stdin`: a `quota_auto_resume_fired` notification
    marks the current window resumed; `quota_auto_resume_stale` /
    `quota_auto_resume_disabled` leave the window alone so `--resume-check`
    can still act on it.
  - `--resume-check`: first record a limit banner newer than the last
    recorded block (same dedupe and alert as record-block). Then: past the
    recorded block's reset? Arm the resume prompt
    and print RESUME (exit 10) so the supervisor relaunches. Prints WAIT /
    SELF-RESUMED / STALE otherwise. May still read transcript mtime, purely
    to detect a session that already came back on its own.
  - `--probe-only`: report current state, no send, no stamp.
  - `warn`: a pre-warning BEFORE the block. When the 5h or 7d window in the
    statusline's <config_home>/botcorp/status.json is at WARN_PCT (98%) or
    more, send ONE `tg_send.py --alert` per window (keyed on that window's
    reset instant, with limit_window's tolerance), so alert triage decides
    what the operator sees. Prints WARN <window> <pct> or OK. Meant for the
    daemon tick; not wired yet (tick.ps1 changes wait for the next release):
    `python <harness>/tools/v2/usage_monitor.py warn`, once per tick, next to
    `--resume-check` in Invoke-UsageResume.

STRICTLY FAIL-OPEN: any exception -> log to stderr + exit 0. Never breaks the tick.
"""
from __future__ import annotations
import argparse, glob, json, os, re, subprocess, sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import limit_window  # shared "has this block already been announced?" predicate

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import instance_root, harness_root, config_home, runtime_root, bot_name  # noqa: E402

REPO = str(instance_root())
# Read for the SELF-RESUMED check in --resume-check (a transcript write after
# the reset means a human already got the session going by hand) and by the
# banner fallback (scan_banner).
TRANSCRIPT_DIR = os.environ.get(
    "BOT_TRANSCRIPT_DIR",
    str(config_home() / "projects" / re.sub(r"[^A-Za-z0-9]", "-", REPO)),
)
STATE = str(runtime_root() / "state" / bot_name() / "usage_limit_state.json")
TG_SEND = str(harness_root() / "tools" / "tg" / "tg_send.py")
# The statusline's copy of Claude Code's rate_limits (statusline.js writes it
# every render); older than STATUS_MAX_AGE_S is not trusted, as in status_footer.
STATUS_JSON = str(config_home() / "botcorp" / "status.json")
STATUS_MAX_AGE_S = 30 * 60
WARN_PCT = 98.0  # the hard budget gate in rules/models.md
WINDOWS = (("five_hour", "5h"), ("seven_day", "7d"))

# The reset phrase out of a StopFailure error message, e.g.
# "...resets 7:10pm (Europe/Stockholm)".
RESET_PHRASE_RE = re.compile(
    r"(?:resets?|reset at|will reset at)\s*(?P<reset>[^\"\\\n]{1,40})",
    re.I,
)


def _log(msg: str) -> None:
    print(f"[usage_monitor] {msg}", file=sys.stderr)


def _read_stdin_json() -> dict:
    try:
        raw = sys.stdin.read() if not sys.stdin.isatty() else ""
        return json.loads(raw or "{}")
    except Exception:
        return {}


# --- resume support -------------------------------------------------------
# The alert text has always PROMISED "I'll pick back up automatically after the
# reset". These helpers turn the promise into a mechanism.

RESUME_FILE = os.path.join(REPO, ".claude", ".botcorp_resume_prompt")

# "9:50pm (Europe/Stockholm)" / "7:10 pm" / "05:00am". CC prints the reset in the
# BOX's local timezone, so local time is the correct frame — no tzdata needed
# (zoneinfo is frequently absent on Windows and a missing tz must not break the
# resume path).
_CLOCK = re.compile(r"(?P<h>\d{1,2})(?::(?P<m>\d{2}))?\s*(?P<ap>am|pm)?", re.I)


def reset_to_local_dt(reset_text: str, ref: datetime):
    """Absolute local datetime for a banner reset string, or None.

    `ref` is when the limit was hit (used to roll to the next day when the reset
    clock time has already passed that day)."""
    m = _CLOCK.search(reset_text or "")
    if not m:
        return None
    hour = int(m.group("h"))
    minute = int(m.group("m") or 0)
    ap = (m.group("ap") or "").lower()
    if ap == "pm" and hour != 12:
        hour += 12
    elif ap == "am" and hour == 12:
        hour = 0
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return None
    ref_local = ref.astimezone()
    cand = ref_local.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if cand <= ref_local:
        cand += timedelta(days=1)
    return cand


def write_resume_prompt(reset_text: str) -> bool:
    """Seed the next launch with a directive so the fresh session actually WORKS
    instead of sitting at an empty prompt. The launcher consumes and deletes
    this file, appending it as claude's first prompt."""
    try:
        os.makedirs(os.path.dirname(RESUME_FILE), exist_ok=True)
        body = (
            "You were cut off mid-work by a Claude usage limit (reset: "
            f"{reset_text}). The limit has now reset. Resume immediately: read "
            "memory/TDL.md '## Open' and the session journal, tell the operator "
            "on Telegram in one line what you are picking up, then continue "
            "that work. Do not wait for further instruction."
        )
        with open(RESUME_FILE, "w", encoding="utf-8") as fh:
            fh.write(body)
        return True
    except Exception as e:
        _log(f"resume prompt write failed: {e}")
        return False


# How late is too late to auto-resume. Past this the world has moved on (box was
# asleep, someone worked the session by hand) and relaunching would destroy a
# live context for no gain. .claude/rules/session-lifecycle.md: when unsure,
# DON'T roll.
RESUME_MAX_LATE_MIN = int(os.environ.get("BOT_RESUME_MAX_LATE_MIN", "120"))


def newest_transcript_mtime():
    """Local-tz mtime of the most recently written transcript, or None.

    A write AFTER the reset means the session already came back on its own
    (the usual case: the operator typed something). Relaunching then would
    nuke live work."""
    try:
        files = glob.glob(os.path.join(TRANSCRIPT_DIR, "*.jsonl"))
        if not files:
            return None
        return datetime.fromtimestamp(max(os.path.getmtime(f) for f in files)).astimezone()
    except Exception:
        return None


def load_state() -> dict:
    try:
        return json.load(open(STATE, encoding="utf-8"))
    except Exception:
        return {}


def save_state(d: dict) -> None:
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    # atomic-ish
    tmp = STATE + ".tmp"
    json.dump(d, open(tmp, "w", encoding="utf-8"))
    os.replace(tmp, STATE)


def send_tg(reset: str, dry: bool) -> bool:
    text = limit_window.announce_text(reset)
    if dry:
        print("[DRY-RUN] would TG-send:\n" + text)
        return True
    py = sys.executable
    try:
        r = subprocess.run([py, TG_SEND, text], capture_output=True, text=True,
                           timeout=30, env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        ok = r.returncode == 0
        if not ok:
            _log(f"tg_send failed rc={r.returncode} {r.stderr[:200]}")
        return ok
    except Exception as e:
        _log(f"tg_send exception: {e}")
        return False


def window_id(reset: str, entry_ts: datetime) -> str:
    """Identity of ONE limit block.

    The reset TEXT alone is not unique — "9:50pm (Europe/Stockholm)" is the same
    string every day, so deduping on it meant the second block with a repeating
    reset time was silently swallowed: no alert, no blocked_until, and therefore
    no auto-resume. Pin the block to the minute it was hit."""
    return f"{reset}|{entry_ts.astimezone(timezone.utc):%Y-%m-%dT%H:%M}"


def _consume(state: dict, reset: str, why: str) -> None:
    """Mark a limit window handled WITHOUT relaunching, so it can never fire later."""
    state["resumed_for"] = reset
    state["resumed_at"] = datetime.now(timezone.utc).astimezone().isoformat()
    state["resume_skipped"] = why
    try:
        save_state(state)
    except Exception as e:
        _log(f"state save failed: {e}")
    _log(f"resume window {reset!r} consumed without relaunch: {why}")


def resume_check(state: dict, dry: bool) -> int:
    """Past the reset of a recorded block? Arm the resume and tell the supervisor.

    Exit 10 = RESUME (relaunch). Exit 0 = nothing to do. Fail-open: any doubt
    means do nothing, because a spurious relaunch throws away a live session
    (the invariant in .claude/rules/session-lifecycle.md)."""
    until_s = state.get("blocked_until")
    reset = state.get("last_alerted_reset")
    # Key on the window id (reset text + hit minute) so a repeating reset time
    # can't make yesterday's resume look like today's.
    wid = state.get("last_alerted_window") or reset
    if not until_s or not wid:
        print("NONE")
        return 0
    if state.get("resumed_for") == wid:
        print("ALREADY-RESUMED")
        return 0
    try:
        until = datetime.fromisoformat(until_s)
    except Exception:
        _log(f"unparseable blocked_until {until_s!r} - clearing")
        state.pop("blocked_until", None)
        save_state(state)
        print("NONE")
        return 0
    if until.tzinfo is None:
        until = until.astimezone()
    now_local = datetime.now(timezone.utc).astimezone()
    if now_local < until:
        mins = (until - now_local).total_seconds() / 60.0
        print(f"WAIT {mins:.0f}m")
        return 0

    # The session already resumed by itself (a human prompted it after the
    # reset). Consume the window so we never relaunch over live work.
    tmtime = newest_transcript_mtime()
    if tmtime and tmtime > until:
        _consume(state, wid, "self-resumed")
        print("SELF-RESUMED")
        return 0

    late = (now_local - until).total_seconds() / 60.0
    if late > RESUME_MAX_LATE_MIN:
        _consume(state, wid, f"stale ({late:.0f}m late)")
        print("STALE")
        return 0

    if dry:
        print(f"[DRY-RUN] would RESUME (block lifted {until.isoformat()})")
        return 0
    if not write_resume_prompt(reset):
        print("NONE")
        return 0
    state["resumed_for"] = wid
    state["resumed_at"] = now_local.isoformat()
    state.pop("resume_skipped", None)
    try:
        save_state(state)
    except Exception as e:
        _log(f"state save failed: {e}")
    send_resume_tg(reset)
    _log(f"usage limit window {wid!r} has passed - arming resume")
    print("RESUME")
    return 10


def send_resume_tg(reset: str) -> None:
    text = (
        f"✅ *Usage limit reset* ({reset}) - restarting and picking the work "
        f"back up now."
    )
    try:
        subprocess.run([sys.executable, TG_SEND, text], capture_output=True,
                       text=True, timeout=30,
                       env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    except Exception as e:
        _log(f"resume tg failed: {e}")


def _parse_block_reset(message: str, now: datetime) -> tuple[str, datetime]:
    """Reset time out of a StopFailure error message, else now + 5h.

    A StopFailure payload's `error.message` sometimes carries the same human
    reset phrase the old transcript banner did ("...resets 7:10pm
    (Europe/Stockholm)"); when it doesn't, 5h is the standard weekly/5-hour
    window's shortest span, so it is the conservative default (better to
    resume-check a bit early and find WAIT than to never check at all)."""
    m = RESET_PHRASE_RE.search(message or "")
    if m:
        reset_text = m.group("reset").strip().strip(".")
        until = reset_to_local_dt(reset_text, now)
        if until:
            return reset_text, until
    until = (now + timedelta(hours=5)).astimezone()
    return until.strftime("%H:%M"), until


# "You've reached your Fable limit. /model to switch models." A limit on ONE
# model: the session goes on with another model and there is no reset window
# to wait out, so it is not a usage block (09-27..09-29: three subagent hits).
MODEL_LIMIT_RE = re.compile(r"reached your .{1,40} limit.*?/model", re.I | re.S)


def _block_message(payload) -> str:
    """The human text of a StopFailure payload.

    Claude Code 2.1.284 sends `error` as a STRING code ("rate_limit"), the
    banner text in `last_assistant_message` ("You've hit your session limit ·
    resets 6:30am (Europe/Stockholm)") and the raw API body in `error_details`.
    A dict `error` with a `message`, and `message`/`detail`, are still read."""
    if not isinstance(payload, dict):
        return ""
    err = payload.get("error")
    return str(
        payload.get("last_assistant_message")
        or payload.get("message")
        or (err.get("message") if isinstance(err, dict) else None)
        or payload.get("detail")
        or payload.get("error_details")
        or ""
    )


def _record(state: dict, reset: str, until: datetime, hit_at: datetime,
            dry_run: bool, source: str) -> bool:
    """Dedupe, stamp blocked_until, TG-alert once. True when a new block was
    recorded. The stamp never depends on the send: a blocked session's
    tg_send.py can fail (a limit blocks it too, or the backlog gate refuses),
    and --resume-check needs blocked_until either way."""
    if limit_window.already_announced(state, until):
        _log(f"block resetting {until.isoformat()} already announced; staying quiet")
        return False

    wid = window_id(reset, hit_at)
    # A dry-run stamps nothing: it must never suppress a later live alert.
    if not dry_run:
        state["last_alerted_reset"] = reset
        state["last_alerted_window"] = wid
        state["last_alerted_at"] = hit_at.isoformat()
        state["blocked_until"] = until.isoformat()
        state["source"] = source
        state.pop("resumed_for", None)
        state.pop("resume_skipped", None)
        try:
            save_state(state)
        except Exception as e:
            _log(f"state save failed: {e}")
    sent = send_tg(reset, dry_run)
    _log(f"recorded usage-limit block ({source}), resets {reset}"
         + (" (dry-run, state not stamped)" if dry_run else "")
         + ("" if sent else " (alert not sent; blocked_until stamped for --resume-check)"))
    return True


def cmd_record_block(dry_run: bool) -> int:
    """Hook mode: a StopFailure payload on stdin (shape in _block_message).
    Parses the reset time, dedupes against an already-announced block
    (cross-tool safe via limit_window.already_announced), stamps
    blocked_until, then TG-alerts once. A one-model limit is logged only."""
    message = _block_message(_read_stdin_json())
    if MODEL_LIMIT_RE.search(message) and not RESET_PHRASE_RE.search(message):
        _log(f"one-model limit, not a usage block: {message[:80]!r}")
        return 0
    now = datetime.now(timezone.utc)
    reset, until = _parse_block_reset(message, now)
    _record(load_state(), reset, until, now, dry_run, "usage_monitor")
    return 0


# The banner fallback looks this far back. The 5-hour window is the shortest
# block; an older banner's reset has passed and needs no stamp.
BANNER_LOOKBACK_H = 6
BANNER_TAIL_BYTES = 1 << 20


def _banner_entries(path: str):
    """(hit time, text) for each limit banner in the tail of one transcript.

    CC writes a limit as an assistant entry with `isApiErrorMessage: true`,
    `error: "rate_limit"` and the banner as its text content."""
    with open(path, "rb") as fh:
        fh.seek(0, os.SEEK_END)
        fh.seek(max(0, fh.tell() - BANNER_TAIL_BYTES))
        data = fh.read().decode("utf-8", "replace")
    for line in data.splitlines():
        if '"rate_limit"' not in line:
            continue
        try:
            d = json.loads(line)
            if not (d.get("isApiErrorMessage") and d.get("error") == "rate_limit"):
                continue
            ts = datetime.fromisoformat(str(d["timestamp"]).replace("Z", "+00:00"))
            content = (d.get("message") or {}).get("content")
            if isinstance(content, list):
                text = " ".join(str(c.get("text") or "") for c in content if isinstance(c, dict))
            else:
                text = str(content or "")
        except Exception:
            continue
        yield ts, text


def scan_banner(state: dict, dry_run: bool) -> bool:
    """Record the newest limit banner that no hook recorded.

    Only banners newer than the last recorded block count (the hook stamps its
    run time, after CC wrote the banner), and only ones whose reset is still
    ahead: a passed window needs no alert, and stamping it would relaunch."""
    now = datetime.now(timezone.utc)
    since = now - timedelta(hours=BANNER_LOOKBACK_H)
    last = None
    try:
        last = datetime.fromisoformat(str(state.get("last_alerted_at")))
        if last.tzinfo is None:
            last = last.astimezone()
    except Exception:
        pass
    best = None
    for f in glob.glob(os.path.join(TRANSCRIPT_DIR, "*.jsonl")):
        try:
            if os.path.getmtime(f) < since.timestamp():
                continue
            for ts, text in _banner_entries(f):
                if ts <= since or (last and ts <= last):
                    continue
                m = RESET_PHRASE_RE.search(text)  # a one-model limit has none
                if m and (best is None or ts > best[0]):
                    best = (ts, m.group("reset").strip().strip("."))
        except Exception as e:
            _log(f"banner scan skipped {os.path.basename(f)}: {e}")
    if best is None:
        return False
    ts, reset = best
    until = reset_to_local_dt(reset, ts)
    if not until or until <= now:
        return False
    return _record(state, reset, until, ts, dry_run, "banner")


# Notification matcher_value family the harness's own quota-auto-resume
# mechanism reports. "fired" means it already relaunched the session itself;
# "stale"/"disabled" mean it did NOT act, so --resume-check must still.
NOTIF_FIRED = "quota_auto_resume_fired"
NOTIF_STALE = "quota_auto_resume_stale"
NOTIF_DISABLED = "quota_auto_resume_disabled"


def cmd_record_notification(dry_run: bool) -> int:
    """Hook mode: a Notification payload with `matcher_value` on stdin."""
    payload = _read_stdin_json()
    matcher = payload.get("matcher_value") or payload.get("matcherValue") or ""
    state = load_state()
    wid = state.get("last_alerted_window")

    if matcher == NOTIF_FIRED:
        if wid:
            state["resumed_for"] = wid
            state["resumed_at"] = datetime.now(timezone.utc).astimezone().isoformat()
            state.pop("resume_skipped", None)
            if not dry_run:
                try:
                    save_state(state)
                except Exception as e:
                    _log(f"state save failed: {e}")
        _log(f"notification {matcher!r} -> window {wid!r} marked resumed"
             + (" (dry-run, state not stamped)" if dry_run else ""))
    elif matcher in (NOTIF_STALE, NOTIF_DISABLED):
        _log(f"notification {matcher!r} -> leaving window {wid!r} for --resume-check")
    else:
        _log(f"notification {matcher!r} unrecognised -> no action")
    return 0


def _reset_epoch(value) -> float | None:
    """A rate-limit resets_at (unix seconds, or an ISO string) as unix seconds."""
    try:
        if isinstance(value, (int, float)):
            return float(value)
        s = str(value).strip()
        if s.replace(".", "", 1).isdigit():
            return float(s)
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def read_rate_limits() -> tuple[dict, float | None]:
    """({window: (used_pct, reset_epoch|None)}, status.json age in seconds).
    ({}, age) when status.json is missing, stale or has no rate_limits."""
    try:
        s = json.load(open(STATUS_JSON, encoding="utf-8"))
        age = datetime.now(timezone.utc).timestamp() - float(s.get("ts") or 0)
    except Exception:
        return {}, None
    if age > STATUS_MAX_AGE_S:
        return {}, age
    out = {}
    for key, _label in WINDOWS:
        w = (s.get("rate_limits") or {}).get(key) or {}
        try:
            out[key] = (float(w["used_percentage"]), _reset_epoch(w.get("resets_at")))
        except (KeyError, TypeError, ValueError):
            continue
    return out, age


def _local_hhmm(epoch: float | None) -> str:
    return datetime.fromtimestamp(epoch).astimezone().strftime("%a %H:%M") if epoch else "?"


def cmd_warn(dry_run: bool) -> int:
    """At WARN_PCT or more of a window: one --alert per window, then quiet."""
    limits, _age = read_rate_limits()
    state = load_state()
    warned = state.get("warned") if isinstance(state.get("warned"), dict) else {}
    hits = []
    for key, label in WINDOWS:
        if key not in limits:
            continue
        pct, reset = limits[key]
        if pct < WARN_PCT:
            continue
        hits.append(f"{label} {pct:.0f}%")
        if reset is None:
            _log(f"{label} at {pct:.0f}% but no resets_at: cannot tell the window apart, not warning")
            continue
        prev = warned.get(key)
        if isinstance(prev, (int, float)) and abs(prev - reset) <= limit_window.TOLERANCE_MIN * 60:
            continue  # this window was already warned about
        text = (f"Claude usage at {pct:.0f}% of the {label} window (resets {_local_hhmm(reset)}). "
                f"The account blocks at 100%: finish the work in flight and start nothing large "
                f"(rules/models.md budget gates).")
        if dry_run:
            print("[DRY-RUN] would alert: " + text)
            continue
        try:
            r = subprocess.run([sys.executable, TG_SEND, "--alert", text], capture_output=True, text=True,
                               timeout=30, env={**os.environ, "PYTHONIOENCODING": "utf-8"})
            if r.returncode != 0:
                _log(f"tg_send --alert failed rc={r.returncode} {r.stderr[:200]}")
                continue
        except Exception as e:
            _log(f"tg_send --alert exception: {e}")
            continue
        warned[key] = reset
        state["warned"] = warned
        try:
            save_state(state)
        except Exception as e:
            _log(f"state save failed: {e}")
    print("WARN " + ", ".join(hits) if hits else "OK")
    return 0


def usage_summary() -> str:
    """The /usage reply: both windows, the block state, how fresh the reading is."""
    limits, age = read_rate_limits()
    lines = ["**Claude usage**"]
    if not limits:
        why = "no status.json yet" if age is None else (
            f"status.json is {age / 60:.0f} min old (stale)" if age > STATUS_MAX_AGE_S else "no rate_limits in status.json")
        lines.append(f"no current reading: {why}")
    for key, label in WINDOWS:
        if key in limits:
            pct, reset = limits[key]
            flag = " (at the warn line)" if pct >= WARN_PCT else ""
            lines.append(f"{label}: {pct:.0f}%, resets {_local_hhmm(reset)}{flag}")
    if limits and age is not None:
        lines.append(f"read {age / 60:.0f} min ago")
    st = load_state()
    if st.get("blocked_until") and not st.get("resumed_for"):
        lines.append(f"blocked until {st['blocked_until']} (auto-resume armed)")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", nargs="?", default=None,
                    choices=["record-block", "record-notification", "warn"],
                    help="hook-fed subcommand; omit for --probe-only/--resume-check")
    ap.add_argument("--stdin", action="store_true",
                    help="read the hook payload JSON from stdin (record-block/record-notification; the default)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--probe-only", action="store_true",
                    help="report current state, send nothing, stamp nothing")
    ap.add_argument("--resume-check", action="store_true",
                    help="if a recorded limit window has now passed, arm the resume "
                         "prompt and print RESUME (exit 10) so the supervisor relaunches")
    args = ap.parse_args()

    if args.cmd == "record-block":
        return cmd_record_block(args.dry_run)
    if args.cmd == "record-notification":
        return cmd_record_notification(args.dry_run)
    if args.cmd == "warn":
        return cmd_warn(args.dry_run)

    state = load_state()

    if args.probe_only:
        print(json.dumps({
            "last_alerted_reset": state.get("last_alerted_reset"),
            "last_alerted_window": state.get("last_alerted_window"),
            "blocked_until": state.get("blocked_until"),
            "resumed_for": state.get("resumed_for"),
        }))
        return 0

    if args.resume_check:
        try:
            scan_banner(state, args.dry_run)
        except Exception as e:
            _log(f"banner scan failed (fail-open): {e}")
        return resume_check(state, args.dry_run)

    print("usage_monitor: nothing to do — pass record-block, record-notification, warn, "
          "--probe-only, or --resume-check", file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # STRICTLY FAIL-OPEN
        _log(f"fatal (fail-open): {e}")
        sys.exit(0)
