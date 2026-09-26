#!/usr/bin/env python3
"""Alert triage tick: consume memory/metrics/alerts.log, fix-or-card headlessly.

Why: monitors write alerts to memory/metrics/alerts.log (tg_send.py --alert,
plus external jobs that append their own lines). The rule said the Director
reads that log "on every autonomous tick" — but there was no autonomous tick,
so the log was only read when a human happened to prompt the session. A
recurring job failed two nights running and the operator forwarded the alerts
themselves: "Fix these, you should monitor your own error messages."

This is that tick. The supervisor runs `scan` every BOT_TRIAGE_EVERY_MIN
(idle-gated, see the supervisor's own triage invocation):

  1. read alerts.log from a byte-offset cursor (state dir's alerts_triage.json)
  2. NOISE (info-only status digests, ...) -> cursor advanced, nothing else
  3. ACTIONABLE (FAIL / CRITICAL / exited N / (warn) / backup ...) -> fingerprinted;
     a fingerprint triaged within BOT_TRIAGE_COOLDOWN_H is a repeat and is skipped
  4. a non-empty batch spawns ONE headless `claude --print` run (detached waiter,
     `run` subcommand) that root-causes, fixes what is confined to this box or a
     repo we own, cards the rest, and answers NO_REPLY unless a human must act
     tonight (a `HUMAN:` line goes through tg_send.py --alert -> pushed only if
     CRITICAL). Nothing deploys, nothing touches a client site, no Telegram.

Approved scope (board card "Triage heartbeat", P1): read-and-triage, fixes
limited to this box and the board; default output NO_REPLY.

Commands:
  scan [--dry-run] [-v]   default; --dry-run prints the batch, writes nothing
  scan --seed             cursor -> EOF, no triage (first deployment on an old log)
  list                    cursor + fingerprint state + lock
  run --prompt-file F --run-file OUT   the detached waiter (spawned by scan)

STRICTLY FAIL-OPEN: any exception -> one stderr line, exit 0.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import instance_root, harness_root, runtime_root, bot_name  # noqa: E402

ROOT = instance_root()
ALERTS_LOG = ROOT / "memory" / "metrics" / "alerts.log"
TRIAGE_LOG = ROOT / "memory" / "metrics" / "alerts_triage.log"
STATE_DIR = runtime_root() / "state" / bot_name()
STATE_FILE = STATE_DIR / "alerts_triage.json"       # cursor + fingerprints
LOCK_FILE = STATE_DIR / "triage.lock"
RUNS_DIR = STATE_DIR / "triage_runs"
PROMPT_FILE = STATE_DIR / "triage_prompt.txt"
TG_SEND = harness_root() / "tools" / "tg" / "tg_send.py"
GH_PROJECTS_PY = harness_root() / "tools" / "v2" / "gh_projects.py"

LOCK_STALE_MIN = 30
BATCH_MAX = 40          # alerts per run; with LINE_MAX keeps -p under the Windows argv cap
LINE_MAX = 500          # chars of each verbatim line shown to the run

# A line that STARTS an alert: `<ISO stamp>` then a tab (tg_send.py) or a space
# (external jobs, e.g. tools-us-org backup.mjs writes `2026-09-19T03:30:06.892Z ...`).
STAMP_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)[\t ]+(.*)$")

# Word-ish, case-insensitive. Verbose mode prints the MATCHED TEXT, never just a
# count, so a substring cannot quietly promote an alert without being seen.
ACTIONABLE_RE = re.compile(
    r"\bFAIL(?:ED)?\b|CRITICAL|🚨|Error|exited [1-9]|DOWN\b|\(warn\)|backup", re.I)

# Known-informational reports, checked BEFORE the actionable regex: a status
# digest (🗂️) can legitimately contain "failed", and a `HUMAN:` line is this
# tick's OWN output echoed back through --alert (it must never re-trigger the
# tick that produced it).
NOISE_RE = re.compile(r"^\s*(?:🗂|HUMAN:)")

# Fingerprint: the alert head with the tg status footer (📍 ... ↻HH:MM), ISO
# stamps/dates and EVERY digit run stripped, lowercased, first 160 chars.
# All digits, not just long ones: the real log showed "10 agent-browser Chrome
# procs (570 MB) — idle 53.3m" recurring hourly with a different count/minute
# each time, and each variant would otherwise be a fresh fingerprint that
# burns a headless run. Over-collapsing costs a repeat count; under-collapsing
# costs an Opus run per tick.
_FP_STRIP = (
    (re.compile(r"📍.*$"), ""),
    (re.compile(r"\d+"), " "),
    (re.compile(r"\s+"), " "),
)

PROMPT_TEMPLATE = """You are the bot's alert triage tick: headless, unattended, nobody is watching.
Repo: {root}. {n} new alert(s) from memory/metrics/alerts.log, verbatim:

{alerts}
{live_note}
For EACH alert:
1. Root-cause it. Use the repos on this box and the logs the alert names. Read the code before concluding.
2. FIX it only if the fix is confined to this box or a repo we own. Then commit + push, ending the commit message with:
   Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
   NEVER: deploy, write to a client site, touch a production system, or send Telegram (BOT_TG_MUTE=1 is set; leave it set).
3. If you cannot fix it, create a board card in Ready carrying the evidence (write the body to a temp file first):
   python {gh_projects} add "<title>" --body-file <path>
   python {gh_projects} move "<title>" Ready
4. ALWAYS append one line per alert to memory/metrics/alerts_triage.log (tab-separated), using the fp shown above the alert:
   <ISO>\tTRIAGED\t<fp>\t<FIXED|CARDED|IGNORED>\t<one-line outcome>

Set PYTHONIOENCODING=utf-8 on python invocations. Do not edit files with scripts; use the Edit tool.
Your final answer must be exactly NO_REPLY - unless a human must act tonight, in which case it is a single line starting HUMAN:.
"""

# Appended when the idle gate was WAIVED: the live Director session may be
# mid-work in this repo, so this run must not commit there (one writer per
# git tree).
LIVE_SESSION_NOTE = """
IMPORTANT: a live Director session may be editing this repo RIGHT NOW. In THAT repo commit nothing
except appends under memory/metrics/ (the auto-commit hook sweeps them). Other repos are fine to commit + push.
"""


class Alert:
    __slots__ = ("stamp", "head", "raw")

    def __init__(self, stamp: str, head: str, raw: str):
        self.stamp = stamp
        self.head = head          # text after the stamp, first line only
        self.raw = [raw]          # verbatim lines incl. continuations

    @property
    def text(self) -> str:
        """Head (stamp stripped) + continuation lines: what gets classified."""
        return " | ".join([self.head] + self.raw[1:])


def _env_num(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except ValueError:
        return default


def _now_iso(now: datetime) -> str:
    return now.isoformat(timespec="seconds")


def fingerprint(head: str) -> str:
    s = head
    for rx, rep in _FP_STRIP:
        s = rx.sub(rep, s)
    return s.strip().lower()[:160]


def classify(text: str):
    """Return the actionable match (re.Match) or None for noise."""
    if NOISE_RE.search(text):
        return None
    return ACTIONABLE_RE.search(text)


def parse_alerts(text: str) -> tuple[list[Alert], int]:
    """Split log text into alerts. Lines without a leading ISO stamp are
    continuation lines and attach to the previous alert; an orphan continuation
    (chunk starts mid-alert) is dropped. Returns (alerts, orphan_count)."""
    alerts: list[Alert] = []
    orphans = 0
    for line in text.split("\n"):
        line = line.rstrip("\r")
        if not line.strip():
            continue
        m = STAMP_RE.match(line)
        if m:
            alerts.append(Alert(m.group(1), m.group(2), line))
        elif alerts:
            alerts[-1].raw.append(line)
        else:
            orphans += 1
    return alerts, orphans


# ---------------------------------------------------------------- state

def _load_state() -> dict:
    try:
        st = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if isinstance(st, dict):
            st.setdefault("offset", 0)
            st.setdefault("fingerprints", {})
            st.setdefault("runs", [])
            return st
    except Exception:
        pass
    return {"offset": 0, "fingerprints": {}, "runs": []}


def _save_state(st: dict, now: datetime) -> None:
    st["updated_at"] = _now_iso(now)
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(st, indent=1, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, STATE_FILE)


def _read_new(offset: int) -> tuple[str, int, int]:
    """Read complete lines from `offset`. Returns (text, new_offset, size).
    Cursor past EOF = the log was truncated/rotated -> start from 0."""
    if not ALERTS_LOG.exists():
        return "", 0, 0
    size = ALERTS_LOG.stat().st_size
    if offset > size:
        offset = 0
    with ALERTS_LOG.open("rb") as fh:
        fh.seek(offset)
        data = fh.read()
    end = data.rfind(b"\n") + 1          # leave a partial trailing line for next time
    return data[:end].decode("utf-8", errors="replace"), offset + end, size


def _lock_in_flight(now: datetime) -> str | None:
    """The lock's content ('pid ts') when a run is in flight, else None."""
    try:
        raw = LOCK_FILE.read_text(encoding="utf-8").strip()
        ts = datetime.fromisoformat(raw.split()[1])
        if now - ts < timedelta(minutes=LOCK_STALE_MIN):
            return raw
    except Exception:
        pass
    return None


def _write_lock(pid: int, now: datetime) -> None:
    LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    LOCK_FILE.write_text(f"{pid} {_now_iso(now)}\n", encoding="utf-8")


def _triage_log(now: datetime, *fields: str) -> None:
    TRIAGE_LOG.parent.mkdir(parents=True, exist_ok=True)
    with TRIAGE_LOG.open("a", encoding="utf-8") as fh:
        fh.write(_now_iso(now) + "\t" + "\t".join(f.replace("\t", " ").replace("\n", " ") for f in fields) + "\n")


def build_prompt(batch: list[tuple[str, Alert, int]], live_session: bool = False) -> str:
    blocks = []
    for i, (fp, alert, count) in enumerate(batch, 1):
        seen = f" (seen {count}x since last triage)" if count > 1 else ""
        blocks.append(f"[{i}] fp={fp[:80]}{seen}\n" + "\n".join(l[:LINE_MAX] for l in alert.raw))
    return PROMPT_TEMPLATE.format(root=ROOT, n=len(batch), alerts="\n\n".join(blocks),
                                  gh_projects=GH_PROJECTS_PY,
                                  live_note=LIVE_SESSION_NOTE if live_session else "")


def alert_age(stamp: str, now: datetime) -> timedelta:
    """Age of an alert from its stamp. tg_send.py writes local naive time;
    external jobs write UTC with a Z. Unparseable -> 0 (never waives on garbage)."""
    try:
        dt = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        if dt.tzinfo is not None:
            dt = dt.astimezone().replace(tzinfo=None)
        return max(now - dt, timedelta(0))
    except ValueError:
        return timedelta(0)


# ---------------------------------------------------------------- scan

def seed(now: datetime | None = None) -> None:
    """Move the cursor to EOF without triaging: first deployment on a box whose
    log already holds weeks of alerts a human has seen."""
    now = now or datetime.now()
    st = _load_state()
    size = ALERTS_LOG.stat().st_size if ALERTS_LOG.exists() else 0
    st["offset"] = size
    _save_state(st, now)
    print(f"seeded: cursor -> {size} (EOF); nothing before this point will be triaged")


def scan(now: datetime | None = None, dry_run: bool = False, verbose: bool = False,
         spawn=None, session_busy: bool = False) -> dict:
    now = now or datetime.now()
    spawn = spawn or _spawn_waiter
    cooldown = timedelta(hours=_env_num("BOT_TRIAGE_COOLDOWN_H", 24))
    max_per_day = int(_env_num("BOT_TRIAGE_MAX_PER_DAY", 6))
    max_wait = timedelta(hours=_env_num("BOT_TRIAGE_MAX_WAIT_H", 6))

    st = _load_state()
    text, new_offset, size = _read_new(int(st.get("offset", 0)))
    alerts, orphans = parse_alerts(text)
    fps: dict = st["fingerprints"]
    batch: list[tuple[str, Alert, int]] = []
    seen_in_batch: dict[str, int] = {}
    noise = repeats = 0

    for a in alerts:
        m = classify(a.text)
        if m is None:
            noise += 1
            if verbose:
                print(f"  NOISE       {a.head[:100]}")
            continue
        fp = fingerprint(a.head)
        e = fps.setdefault(fp, {"first_seen": a.stamp, "count": 0, "triaged_at": None,
                                "sample": a.head[:200]})
        e["last_seen"] = a.stamp
        e["count"] = int(e.get("count", 0)) + 1
        tri = e.get("triaged_at")
        in_cooldown = False
        if tri:
            try:
                in_cooldown = now - datetime.fromisoformat(tri) < cooldown
            except ValueError:
                pass
        if in_cooldown:
            repeats += 1
            e["repeats_since_triage"] = int(e.get("repeats_since_triage", 0)) + 1
            if verbose:
                print(f"  REPEAT      matched {m.group(0)!r}  {a.head[:90]}")
            continue
        if fp in seen_in_batch:
            i = seen_in_batch[fp]
            batch[i] = (fp, batch[i][1], batch[i][2] + 1)
            continue
        if verbose:
            print(f"  ACTIONABLE  matched {m.group(0)!r}  {a.head[:90]}")
        seen_in_batch[fp] = len(batch)
        batch.append((fp, a, 1))

    summary = {"read_bytes": new_offset - int(st.get("offset", 0)) if size else 0,
               "alerts": len(alerts), "noise": noise, "repeats": repeats,
               "orphans": orphans, "batch": len(batch), "launched": False,
               "cursor": new_offset, "size": size}
    if dry_run:
        print(f"[dry-run] {summary['alerts']} new alert(s): {noise} noise, {repeats} repeat(s) "
              f"in cooldown, {len(batch)} would be batched (cursor {st.get('offset', 0)}->{new_offset} "
              f"of {size}, not written)")
        for fp, a, count in batch:
            print(f"--- fp={fp[:80]} (x{count})")
            for line in a.raw:
                print("    " + line)
        return summary

    if not batch:
        st["offset"] = new_offset
        _save_state(st, now)
        print(f"scan: {len(alerts)} alert(s), {noise} noise, {repeats} repeat(s), nothing to triage")
        return summary

    # Launch gates. When a gate holds, write NOTHING (cursor + counters stay), so
    # the same alerts are re-read and batched on a later tick instead of lost.
    #
    # Idle gate + staleness waiver. The supervisor passes --session-busy when
    # the live session is mid-work (Test-SessionBusy). The Director can be busy
    # for DAYS at a stretch, so an alert that simply waits for idle can wait
    # indefinitely — the exact failure this tick exists to end. Once the OLDEST
    # alert in the batch has waited BOT_TRIAGE_MAX_WAIT_H, the gate is waived
    # and the run is told a live session may be editing this repo.
    waived = False
    if session_busy:
        oldest = max(alert_age(a.stamp, now) for _fp, a, _c in batch)
        oldest_h = oldest.total_seconds() / 3600
        if oldest >= max_wait:
            waived = True
            msg = f"idle gate waived: oldest alert {oldest_h:.1f}h >= {max_wait.total_seconds() / 3600:g}h"
            print(f"scan: {msg}")
            _triage_log(now, "WAIVER", msg)
        else:
            print(f"scan: {len(batch)} to triage but the session is busy (oldest alert "
                  f"{oldest_h:.1f}h < BOT_TRIAGE_MAX_WAIT_H={max_wait.total_seconds() / 3600:g}h); deferring")
            summary["deferred"] = "session-busy"
            return summary
    summary["waived"] = waived
    lock = _lock_in_flight(now)
    if lock:
        print(f"scan: {len(batch)} to triage but a run is in flight ({lock}); deferring")
        summary["deferred"] = "in-flight"
        return summary
    today = now.date().isoformat()
    runs_today = [r for r in st["runs"] if str(r).startswith(today)]
    if len(runs_today) >= max_per_day:
        print(f"scan: {len(batch)} to triage but {len(runs_today)} run(s) today >= "
              f"BOT_TRIAGE_MAX_PER_DAY={max_per_day}; deferring")
        summary["deferred"] = "day-cap"
        return summary

    overflow = batch[BATCH_MAX:]
    batch = batch[:BATCH_MAX]
    prompt = build_prompt(batch, live_session=waived)
    PROMPT_FILE.parent.mkdir(parents=True, exist_ok=True)
    PROMPT_FILE.write_text(prompt, encoding="utf-8")
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    run_file = RUNS_DIR / (now.strftime("%Y%m%dT%H%M%S") + ".txt")

    _write_lock(os.getpid(), now)
    for fp, _a, _c in batch:
        fps[fp]["triaged_at"] = _now_iso(now)
        fps[fp]["repeats_since_triage"] = 0
    st["runs"] = [r for r in st["runs"] if str(r) >= (now - timedelta(days=2)).date().isoformat()]
    st["runs"].append(_now_iso(now))
    st["offset"] = new_offset
    _save_state(st, now)

    pid = spawn(PROMPT_FILE, run_file)
    if pid:
        _write_lock(int(pid), now)
    _triage_log(now, "LAUNCH", f"{len(batch)} alert(s)", str(run_file.name),
                "; ".join(fp[:60] for fp, _a, _c in batch))
    if overflow:   # cursor moved past them; they are NOT stamped, so a recurrence is triaged
        _triage_log(now, "OVERFLOW", f"{len(overflow)} alert(s) beyond BATCH_MAX={BATCH_MAX} dropped",
                    "; ".join(fp[:60] for fp, _a, _c in overflow))
    print(f"scan: launched triage run for {len(batch)} alert(s) -> {run_file}")
    summary["launched"] = True
    return summary


# ---------------------------------------------------------------- spawn + run

def _claude_exe() -> str:
    """BOTCORP_CLAUDE_EXE (the bot's pinned Claude Code), then the native
    install: a stale npm shim on PATH can shadow it (mirrors
    daemon/_common.ps1 Resolve-ClaudeExe)."""
    pinned = os.environ.get("BOTCORP_CLAUDE_EXE")
    if pinned and os.path.isfile(pinned):
        return pinned
    name = "claude.exe" if os.name == "nt" else "claude"
    native = os.path.join(os.environ.get("USERPROFILE", ""), ".local", "bin", name)
    if os.path.isfile(native):
        return native
    return shutil.which("claude") or native


def _no_window_flags() -> dict:
    if os.name != "nt":
        return {"start_new_session": True}
    DETACHED_PROCESS = 0x00000008
    CREATE_NEW_PROCESS_GROUP = 0x00000200
    CREATE_NO_WINDOW = 0x08000000
    return {"creationflags": DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW}


def _spawn_waiter(prompt_file: Path, run_file: Path) -> int:
    """Fire-and-forget a detached `run` (this file) so the supervisor tick is
    not held for the length of an LLM run; the waiter owns the hard timeout."""
    cmd = [sys.executable, str(Path(__file__).resolve()), "run",
           "--prompt-file", str(prompt_file), "--run-file", str(run_file)]
    p = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, close_fds=True, cwd=str(ROOT),
                         **_no_window_flags())
    return p.pid


def run(prompt_file: Path, run_file: Path, now: datetime | None = None) -> int:
    """Run headless claude on the prompt with a HARD timeout (tree-killed on
    overrun), capture stdout to run_file, escalate a HUMAN: line via
    tg_send.py --alert, release the lock. Mirrors the harness's own debrief hook:
      - --setting-sources user skips the PROJECT settings: the repo-local
        enabledPlugins would otherwise load the telegram plugin in this
        throwaway session, which STEALS the getUpdates slot from the real bot.
        NEVER pass --plugin-dir/--settings here for the same reason.
      - the prompt goes in over STDIN, never argv — a card body or log line
        full of shell-special characters must never round-trip through a
        command line.
      - --dangerously-skip-permissions because nobody can answer a prompt.
      - no console window (CREATE_NO_WINDOW) so nothing pops on the desktop."""
    now = now or datetime.now()
    model = os.environ.get("BOT_TRIAGE_MODEL") or "claude-opus-5-5"
    timeout_s = int(_env_num("BOT_TRIAGE_TIMEOUT_MIN", 25) * 60)
    prompt = prompt_file.read_text(encoding="utf-8")
    env = dict(os.environ, BOT_TG_MUTE="1", PYTHONIOENCODING="utf-8")
    cmd = [_claude_exe(), "--print", "--model", model, "--dangerously-skip-permissions",
           "--setting-sources", "user", "-p"]
    out = err = ""
    outcome = "rc=?"
    try:
        p = subprocess.Popen(cmd, cwd=str(ROOT), env=env, stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                             encoding="utf-8", errors="replace",
                             **({"creationflags": 0x08000000} if os.name == "nt" else {}))
        try:
            out, err = p.communicate(input=prompt, timeout=timeout_s)
            outcome = f"rc={p.returncode}"
        except subprocess.TimeoutExpired:
            if os.name == "nt":
                taskkill = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"),
                                         "System32", "taskkill.exe")
                subprocess.run([taskkill, "/PID", str(p.pid), "/T", "/F"],
                               capture_output=True)
            else:
                p.kill()
            out, err = p.communicate()
            outcome = f"KILLED after {timeout_s}s"
    except Exception as e:
        outcome = f"launch failed: {e!r}"
    finally:
        try:
            run_file.parent.mkdir(parents=True, exist_ok=True)
            body = out or ""
            if err:
                body += "\n--- stderr ---\n" + err
            run_file.write_text(f"# {outcome} model={model}\n{body}", encoding="utf-8")
        except Exception:
            pass
        first = (out or "").strip().splitlines()[:1]
        first_line = first[0].strip() if first else ""
        _triage_log(datetime.now(), "RUN", outcome, run_file.name, first_line[:160])
        if first_line.startswith("HUMAN:"):
            try:
                subprocess.run([sys.executable, str(TG_SEND), "--alert", first_line[:600]],
                               capture_output=True, timeout=60, cwd=str(ROOT))
            except Exception:
                pass
        try:
            LOCK_FILE.unlink()
        except Exception:
            pass
    return 0


# ---------------------------------------------------------------- list

def list_state(now: datetime | None = None) -> None:
    now = now or datetime.now()
    st = _load_state()
    size = ALERTS_LOG.stat().st_size if ALERTS_LOG.exists() else 0
    today = now.date().isoformat()
    lock = _lock_in_flight(now)
    print(f"cursor {st.get('offset', 0)} / {size} bytes  runs today "
          f"{len([r for r in st['runs'] if str(r).startswith(today)])}  "
          f"lock {'in-flight ' + lock if lock else 'free'}")
    fps = sorted(st["fingerprints"].items(), key=lambda kv: kv[1].get("last_seen", ""), reverse=True)
    for fp, e in fps:
        print(f"  x{e.get('count', 0):<3} last {e.get('last_seen', '?')[:19]}  "
              f"triaged {str(e.get('triaged_at'))[:19]}  {fp[:90]}")


# ---------------------------------------------------------------- cli

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    sub = ap.add_subparsers(dest="cmd")
    s = sub.add_parser("scan", help="read new alerts; launch a triage run if warranted (default)")
    s.add_argument("--dry-run", action="store_true", help="print the batch, write nothing")
    s.add_argument("-v", "--verbose", action="store_true", help="print every line's class + matched text")
    s.add_argument("--seed", action="store_true", help="move the cursor to EOF without triaging")
    s.add_argument("--session-busy", action="store_true",
                   help="the live session is mid-work: defer unless the oldest alert has waited "
                        "BOT_TRIAGE_MAX_WAIT_H (6)")
    sub.add_parser("list", help="show cursor/fingerprint/lock state")
    r = sub.add_parser("run", help="(internal) the detached waiter spawned by scan")
    r.add_argument("--prompt-file", required=True)
    r.add_argument("--run-file", required=True)
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] not in ("scan", "list", "run", "-h", "--help"):
        argv.insert(0, "scan")   # `scan` is the default subcommand
    args = ap.parse_args(argv)
    try:
        if args.cmd == "list":
            list_state()
        elif args.cmd == "run":
            return run(Path(args.prompt_file), Path(args.run_file))
        elif getattr(args, "seed", False):
            seed()
        else:
            scan(dry_run=getattr(args, "dry_run", False), verbose=getattr(args, "verbose", False),
                 session_busy=getattr(args, "session_busy", False))
    except Exception as e:  # fail-open: a broken tick must never break the supervisor
        print(f"alert_triage: {e!r}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
