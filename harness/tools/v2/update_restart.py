#!/usr/bin/env python3
"""/update — update Claude Code, and (only if a new version landed) self-restart
the bot session to apply it.

WHY a self-restart dance: the running claude binary is already loaded into
memory, so `claude update` only takes effect on the NEXT launch. And the bot
does `claude --continue`, which resumes the most-recent conversation. If we
relaunch the bot while the current claude is still alive, BOTH processes
attach the same conversation -> state races + double Telegram replies. So the
safe sequence is:

    1. run `claude update`
    2. compare `claude --version` before/after
    3. IF updated:
         - post a TG notice ("restarting to apply vX")
         - spawn daemon/restart.ps1 DETACHED, passing the LIVE claude PID
         - terminate the live claude process
       restart.ps1 then polls until that PID is gone and launches a fresh
       bot window (which --continue-resumes the now-single conversation).
    4. IF already current: report "already on vX", do NOT restart.

Modes:
    (default)      full flow: update + (if needed) notify + spawn restart + kill self
    --dry-run      run version check + `claude update`, print what WOULD happen,
                   but SKIP the TG notice, the restart spawn, and the self-kill
    --check-only   like --dry-run but ALSO skip running `claude update`
                   (pure "what version am I on / is one available" probe)
    --auto         GATED autonomous entrypoint. Runs the full flow ONLY if ALL
                   of: (a) not-checked-today, (b) update-available, (c) session
                   idle. If any gate fails, logs why and exits 0 (no restart).
                   Combine with --dry-run to print the gate decisions WITHOUT
                   restarting. NOT wired to any hook/timer — the Director invokes
                   it deliberately on an autonomous tick once the base is proven.

Exit codes:
    0  handled (updated+restarting, or already current, or dry-run OK)
    2  handled but a step failed (a best-effort notice may have been sent)

# --auto autonomous gate (IMPLEMENTED below; NOT auto-wired to any hook/timer).
# The full flow fires only when ALL THREE gates pass:
#   (a) NOT-CHECKED-TODAY  — daily stamp <config_home>/.botcorp_update_stamp
#       (written by the launcher on launch). If it already reads today's date,
#       skip: launch already ran a check today.
#   (b) UPDATE-AVAILABLE   — `claude update` changed the version (ver_before !=
#       ver_after); computed by the existing flow.
#   (c) SESSION-IDLE       — no in-flight work. Idle signal (cheap, available
#       TODAY, no Director cooperation required): the session transcript dir
#       has NOT been modified within BOT_IDLE_MIN minutes (default 5). A live
#       build / subagent run touches its transcript, so a quiet dir == idle.
#       If the Director later writes an explicit memory/sessions/<id>/.busy
#       marker, a FRESH .busy (mtime within the same window) also forces
#       not-idle. .busy absent => fall back to transcript-mtime alone (does
#       not block).
# Rationale for transcript-mtime over proc-walking children: it needs zero new
# plumbing, can't false-IDLE during an active build (every build touches the
# transcript), and degrades safe (unreadable transcript dir => treated as
# BUSY, so we never restart blind). Gate (c) is the conservative one: when
# unsure, BUSY.
#
# BREAKPOINT MARKER. Transcript-quiet-5-min never holds during long autonomous
# work, and when the Director itself runs `--auto` its own tool call is the
# freshest transcript write — so gate (c) could not pass from inside a
# session, and "Restart to update" sat pending for days. The Director now
# declares a clean breakpoint itself (per .claude/rules/session-lifecycle.md:
# handoff checklist done, nothing in flight, as the LAST action of its turn) by
# dropping .claude/.botcorp_breakpoint. A marker younger than
# BOT_BREAKPOINT_TTL_MIN (default 30) satisfies gate (c) regardless of
# transcript mtime and waives gate (a); a fresh .busy still wins. The
# supervisor tick honours the same marker and runs this flow with
# --claude-pid, and the marker is consumed the moment a restart is spawned.
# Gate (b) also recognises an update that ALREADY landed on disk (CC's own
# background updater): <config_home>/botcorp/status.json's 'version' field
# (written by the statusline) != the on-disk `claude --version` => restart
# pending, even though `claude update` changes nothing. If that status file is
# absent or older than 10 minutes, gate (b) treats it as UNKNOWN — i.e. "no
# update pending" via that path — rather than guessing from a stale read.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import instance_root, harness_root, botcorp_root, config_home, bot_name  # noqa: E402

REPO_ROOT = instance_root()
PS_EXE = os.path.join(
    os.environ.get("SystemRoot", r"C:\Windows"),
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
)


def _resolve_pwsh() -> str:
    """Resolve an absolute path to pwsh (PowerShell 7+). A bare 'pwsh' fails to
    spawn from a session-0 / Scheduled-Task environment where PATH is minimal
    (ENOENT), so try the known install locations before falling back."""
    if os.name != "nt":
        import shutil
        return shutil.which("pwsh") or "pwsh"
    import shutil
    candidates = [
        os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "PowerShell", "7", "pwsh.exe"),
        shutil.which("pwsh"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "WindowsApps", "pwsh.exe"),
    ]
    for c in candidates:
        if c and Path(c).exists():
            return c
    return PS_EXE


# The restart script itself runs under pwsh (PowerShell 7+), per the daemon's
# own convention — distinct from PS_EXE above, which is Windows PowerShell
# used here only for the reliable detached-spawn trick and proc-walking.
# Resolved to an absolute path: a bare 'pwsh' is not found via ENOENT when
# spawned from a session-0 / Scheduled-Task environment with a minimal PATH.
PWSH_EXE = _resolve_pwsh()
RESTART_SCRIPT = botcorp_root() / "daemon" / "restart.ps1"


def _claude_exe() -> str:
    """Resolve the claude binary path. BOTCORP_CLAUDE_EXE (the pinned copy a
    BotCorp launch names), then CLAUDE_CODE_EXECPATH, set by the harness in our
    environment; fall back to the known native-install location."""
    pinned = os.environ.get("BOTCORP_CLAUDE_EXE")
    if pinned and Path(pinned).is_file():
        return pinned
    env_path = os.environ.get("CLAUDE_CODE_EXECPATH")
    if env_path and Path(env_path).exists():
        return env_path
    fallback = Path(os.environ.get("USERPROFILE", "")) / ".local" / "bin" / "claude.exe"
    return str(fallback)


def _claude_version(exe: str) -> str:
    """First line of `claude --version`, e.g. '2.1.170 (Claude Code)'. '' on failure."""
    try:
        r = subprocess.run([exe, "--version"], capture_output=True, text=True,
                           timeout=30, encoding="utf-8")
        out = (r.stdout or "").strip().splitlines()
        return out[0].strip() if out else ""
    except Exception as e:
        print(f"version probe failed: {e}", file=sys.stderr)
        return ""


def _run_update(exe: str) -> str:
    """Run `claude update`. Returns combined output (for logging). Never raises."""
    try:
        r = subprocess.run([exe, "update"], capture_output=True, text=True,
                           timeout=180, encoding="utf-8")
        return ((r.stdout or "") + (r.stderr or "")).strip()
    except Exception as e:
        return f"claude update failed: {e}"


def _proc_map() -> dict[int, tuple[int, str]]:
    """pid -> (ppid, lowercased name) via Get-CimInstance. {} on failure."""
    ps = ("Get-CimInstance Win32_Process | "
          "Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress")
    try:
        r = subprocess.run([PS_EXE, "-NoProfile", "-NonInteractive", "-Command", ps],
                           capture_output=True, text=True, timeout=30, encoding="utf-8")
        data = json.loads(r.stdout)
        if isinstance(data, dict):
            data = [data]
        return {int(d["ProcessId"]): (int(d["ParentProcessId"]),
                (d.get("Name") or "").lower()) for d in data}
    except Exception as e:
        print(f"proc_map failed: {e}", file=sys.stderr)
        return {}


# Set from --claude-pid when the caller is NOT a descendant of the live claude
# (the supervisor tick): the ancestor walk below cannot find it from there.
_CLAUDE_PID_OVERRIDE: int | None = None


def _live_claude_pid() -> int | None:
    """Resolve the LIVE claude session PID = nearest claude.exe ancestor of this
    process. We are a child of the claude that ran /update, so walking parents
    finds the correct one even when multiple claude.exe processes exist
    (e.g. parallel agent sessions). --claude-pid overrides the walk."""
    if _CLAUDE_PID_OVERRIDE:
        return _CLAUDE_PID_OVERRIDE
    m = _proc_map()
    if not m:
        return None
    cur = os.getpid()
    seen: set[int] = set()
    while cur in m and cur not in seen:
        seen.add(cur)
        ppid, name = m[cur]
        if name == "claude.exe":
            return cur
        cur = ppid
    return None


def _old_shell_pid(claude_pid: int) -> int | None:
    """Resolve the launcher SHELL pid = parent of the live claude.exe, but ONLY
    if that parent is powershell.exe / pwsh.exe (the bot's launcher shell = the
    window). The verified launch chain is:
        windowsterminal.exe -> powershell.exe (launcher) -> claude.exe -> children
    Killing this shell closes the OLD window after restart. Returns None if the
    parent is anything else (e.g. code.exe) so we never kill an arbitrary parent.
    """
    m = _proc_map()
    if not m or claude_pid not in m:
        return None
    ppid, _ = m[claude_pid]
    parent = m.get(ppid)
    if not parent:
        return None
    _, pname = parent
    if pname in ("powershell.exe", "pwsh.exe"):
        return ppid
    return None


def _send_tg(text: str) -> None:
    try:
        subprocess.run(
            [sys.executable or "python", str(harness_root() / "tools" / "tg" / "tg_send.py"),
             "--quiet", "--no-status", text],
            capture_output=True, text=True, timeout=15, encoding="utf-8",
        )
    except Exception as e:
        print(f"tg_send failed: {e}", file=sys.stderr)


def _spawn_restart_detached(old_pid: int, dry_run: bool = False,
                            old_shell_pid: int | None = None) -> None:
    """Spawn daemon/restart.ps1 fully detached so it survives THIS process's
    death (we are about to terminate the whole claude tree, this script
    included).

    WHY this exact mechanism: Python's DETACHED_PROCESS creation flag breaks
    `pwsh -File` (the script body silently never runs — no console handle),
    and CREATE_NO_WINDOW does run the script but the child is still killed when
    the parent claude tree is terminated. The reliable Windows fire-and-forget
    is to let PowerShell's own `Start-Process -WindowStyle Hidden` launch the
    poller: that creates a fully OS-orphaned, windowless process that both runs
    the -File script AND survives our death. Verified by test (kill parent ->
    child keeps polling and relaunches). The thin launching powershell exits
    immediately; the orphaned poller lives on.

    old_shell_pid (when present) is the launcher shell (powershell/pwsh) that owns
    the OLD window; it is passed to restart.ps1 as -OldShellPid so the
    DETACHED relauncher closes it AFTER the claude PID exits. We do the close in
    the relauncher (not here) to avoid the cascade-race where this dying python
    is itself a descendant of that shell.
    """
    inner_args = ["-NoProfile", "-File", str(RESTART_SCRIPT),
                  "-Bot", bot_name(), "-OldPid", str(old_pid)]
    if old_shell_pid:
        inner_args += ["-OldShellPid", str(old_shell_pid)]
    if dry_run:
        inner_args.append("-DryRun")
    # Build the Start-Process arg list as a PowerShell single-quoted array.
    ps_arglist = ",".join("'" + a.replace("'", "''") + "'" for a in inner_args)
    launch = (f"Start-Process -FilePath '{PWSH_EXE}' -WindowStyle Hidden "
              f"-ArgumentList {ps_arglist}")
    subprocess.run(
        [PS_EXE, "-NoProfile", "-NonInteractive", "-Command", launch],
        capture_output=True, text=True, timeout=15,
    )


def _terminate_pid(pid: int) -> None:
    """Terminate the live claude process so restart.ps1 can safely relaunch."""
    try:
        subprocess.run([PS_EXE, "-NoProfile", "-NonInteractive", "-Command",
                        f"Stop-Process -Id {pid} -Force -ErrorAction SilentlyContinue"],
                       capture_output=True, text=True, timeout=15)
    except Exception as e:
        print(f"terminate failed: {e}", file=sys.stderr)


# ---------------------------------------------------------------------------
# --auto gate logic (gates a/c; gate b is the existing version-delta check)
# ---------------------------------------------------------------------------

import datetime  # noqa: E402  (local to the gate code)

STAMP_FILE = config_home() / ".botcorp_update_stamp"
IDLE_MIN = float(os.environ.get("BOT_IDLE_MIN", "5"))
# "Roll at this breakpoint" marker the Director drops itself (see module doc).
BREAKPOINT_FILE = REPO_ROOT / ".claude" / ".botcorp_breakpoint"
BREAKPOINT_TTL_MIN = float(os.environ.get("BOT_BREAKPOINT_TTL_MIN", "30"))
# Gate (b): a status.json older than this is not trusted as "no update pending".
STATUS_MAX_AGE_S = 10 * 60


def breakpoint_declared(now: float | None = None) -> tuple[bool, str]:
    """True iff .claude/.botcorp_breakpoint exists and is younger than the TTL. A
    stale marker is ignored (never deleted here: it is consumed only by an
    actual restart, so a missed window cannot silently authorise a later one)."""
    now = now if now is not None else __import__("time").time()
    try:
        if not BREAKPOINT_FILE.exists():
            return False, "no breakpoint marker"
        age_m = round((now - BREAKPOINT_FILE.stat().st_mtime) / 60, 1)
    except OSError as e:
        return False, f"breakpoint marker unreadable ({e})"
    if age_m < BREAKPOINT_TTL_MIN:
        return True, f"Director declared a breakpoint {age_m}m ago (< {BREAKPOINT_TTL_MIN}m TTL)"
    return False, f"breakpoint marker stale ({age_m}m >= {BREAKPOINT_TTL_MIN}m TTL) -> ignored"


def _consume_breakpoint() -> None:
    try:
        BREAKPOINT_FILE.unlink()
    except OSError:
        pass


def _status_version() -> tuple[str | None, str]:
    """Gate (b)'s other half: the version the LIVE session is running, from
    <config_home>/botcorp/status.json's 'version' field (written by the
    statusline). Absent or older than STATUS_MAX_AGE_S -> (None, reason), which
    the caller treats as UNKNOWN — i.e. no update pending via this path —
    rather than acting on a stale or missing read."""
    p = config_home() / "botcorp" / "status.json"
    try:
        age_s = time.time() - p.stat().st_mtime
    except OSError:
        return None, f"status.json missing ({p})"
    if age_s > STATUS_MAX_AGE_S:
        return None, f"status.json stale ({age_s / 60:.1f}m old)"
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:
        return None, f"status.json unreadable ({e})"
    v = data.get("version") or None
    return v, (f"running session = {v}" if v else "status.json has no 'version' field")


def _version_num(s: str) -> str:
    """'2.1.273 (Claude Code)' -> '2.1.273'."""
    return (s or "").strip().split(" ")[0]


def _current_session_id() -> str | None:
    """Resolve the live session id from the marker the SessionStart hook writes."""
    f = REPO_ROOT / ".claude" / ".current_session_id"
    try:
        sid = f.read_text(encoding="utf-8").strip()
        return sid or None
    except OSError:
        return None


def gate_not_checked_today() -> tuple[bool, str]:
    """(a) Pass if the daily stamp is absent or not today's date."""
    today = datetime.date.today().isoformat()
    try:
        last = STAMP_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return True, f"no stamp file ({STAMP_FILE}); treat as not-checked-today"
    if last == today:
        return False, f"already checked today (stamp={last})"
    return True, f"stamp is {last or '(empty)'}, today is {today}"


def _transcripts_dir() -> Path:
    """Claude Code's transcript dir for this repo — the project slug derived
    exactly as Claude Code derives it (every non-alphanumeric -> '-')."""
    slug = re.sub(r"[^A-Za-z0-9]", "-", str(REPO_ROOT))
    return config_home() / "projects" / slug


def gate_session_idle(now: float | None = None) -> tuple[bool, str]:
    """(c) Idle iff NO Claude Code transcript (.jsonl, recursive — subagents
    and workflows write under subdirs) was touched within IDLE_MIN minutes AND
    no fresh .busy marker. Transcript mtime is the load-bearing signal: CC
    writes it on every message + tool call, unlike the journal which the
    Director only writes sporadically (2026-07-09 21:55: journal 3h stale
    mid-work -> a journal-gated restart nuked a live session; the supervisor's
    Test-SessionBusy was fixed then, this path is the same fix ported —
    2026-07-13 review finding #3). Conservative: when anything can't be
    resolved/read, return BUSY (do not restart blind)."""
    now = now if now is not None else __import__("time").time()
    window = IDLE_MIN * 60
    sid = _current_session_id()
    if not sid:
        return False, "no .current_session_id -> cannot confirm idle, treat as BUSY"
    sess_dir = REPO_ROOT / "memory" / "sessions" / sid
    busy = sess_dir / ".busy"
    try:
        if busy.exists() and (now - busy.stat().st_mtime) < window:
            age = round((now - busy.stat().st_mtime) / 60, 1)
            return False, f".busy marker fresh ({age}m old) -> BUSY"
    except OSError:
        pass  # busy unreadable -> fall through to transcript mtime
    bp_ok, bp_why = breakpoint_declared(now)
    if bp_ok:
        return True, f"{bp_why}; transcript mtime waived -> IDLE"
    tdir = _transcripts_dir()
    try:
        newest: float | None = None
        for p in tdir.rglob("*.jsonl"):
            try:
                m = p.stat().st_mtime
            except OSError:
                continue
            if newest is None or m > newest:
                newest = m
        if newest is None:
            return False, f"no transcripts under {tdir} -> cannot confirm idle, treat as BUSY"
    except OSError:
        return False, f"transcript dir unreadable ({tdir}) -> treat as BUSY"
    age_s = now - newest
    age_m = round(age_s / 60, 1)
    if age_s < window:
        return False, f"newest transcript modified {age_m}m ago (< {IDLE_MIN}m) -> BUSY"
    return True, f"transcripts quiet for {age_m}m (>= {IDLE_MIN}m), no fresh .busy -> IDLE"


def run_auto(dry_run: bool, exe: str) -> int:
    """Gated autonomous flow. Evaluate gates (a) and (c) up front (cheap, no
    side effects), then run the version-check flow as gate (b). Only if ALL
    pass do we proceed to the real update+restart. Always exits 0 unless a
    real update step fails."""
    g_a_pass, g_a_why = gate_not_checked_today()
    g_c_pass, g_c_why = gate_session_idle()
    bp_ok, _ = breakpoint_declared()
    if bp_ok and not g_a_pass:
        # The Director asked for this roll explicitly; "launch already checked
        # today" only guards against needless re-checks, not against a wanted one.
        g_a_pass, g_a_why = True, f"waived by breakpoint marker ({g_a_why})"

    print("=== --auto gate evaluation ===")
    print(f"  (a) not-checked-today : {'PASS' if g_a_pass else 'FAIL'} — {g_a_why}")
    print(f"  (c) session-idle      : {'PASS' if g_c_pass else 'FAIL'} — {g_c_why}")

    if not (g_a_pass and g_c_pass):
        # Short-circuit before touching `claude update` — gate b not even checked.
        print("  (b) update-available  : SKIPPED (a/c did not both pass)")
        print("--auto: gate(s) failed -> no update/restart. exit 0.")
        return 0

    print("  (a)+(c) passed; now checking (b) update-available via version delta...")
    running, running_why = _status_version()
    ver_before = _claude_version(exe)
    update_out = _run_update(exe)
    ver_after = _claude_version(exe)
    updated = bool(ver_before and ver_after and ver_before != ver_after)
    # An update CC's own updater already landed: the binary on disk is newer
    # than the version the live session is running. `claude update` reports
    # nothing new, yet the session still needs the restart. If the status file
    # is stale/absent, `running` is None and this half of gate (b) is UNKNOWN.
    pending = bool(running and ver_after and running != _version_num(ver_after))
    print(f"  (b) update-available  : {'PASS' if (updated or pending) else 'FAIL'} — "
          f"{ver_before or '?'} -> {ver_after or '?'}; {running_why}"
          f"{' (restart PENDING)' if pending else ''}")
    if update_out:
        print(f"--- claude update output ---\n{update_out}")

    if not (updated or pending):
        print("--auto: no new version -> no restart. exit 0.")
        return 0

    old_pid = _live_claude_pid()
    shell_pid = _old_shell_pid(old_pid) if old_pid else None
    if updated:
        notice = f"/update(auto): updated {ver_before} -> {ver_after}. Restarting the bot to apply."
    else:
        notice = f"/update(auto): {ver_after} is on disk, session runs {running}. Restarting the bot to apply."
    if dry_run:
        print("DRY-RUN(auto): all gates passed + update landed. WOULD:")
        print(f"  - TG notice: {notice}")
        print(f"  - spawn restart.ps1 -OldPid {old_pid} (detached, -Continue relaunch)")
        if shell_pid:
            print(f"  - pass -OldShellPid {shell_pid} (relauncher closes old window)")
        print(f"  - terminate live claude pid {old_pid}")
        if old_pid:
            _spawn_restart_detached(old_pid, dry_run=True, old_shell_pid=shell_pid)
        return 0
    if old_pid is None:
        msg = (f"/update(auto): updated {ver_before} -> {ver_after}, but could NOT resolve "
               f"the live claude PID. NOT auto-restarting — restart the bot manually.")
        print(msg)
        _send_tg(msg)
        return 2
    _send_tg(notice)
    _consume_breakpoint()   # one marker authorises one roll
    _spawn_restart_detached(old_pid, dry_run=False, old_shell_pid=shell_pid)
    print(f"spawned restart.ps1 -OldPid {old_pid} (shell={shell_pid}); terminating self ({old_pid})")
    _terminate_pid(old_pid)
    return 0


def run_restart_only(dry_run: bool) -> int:
    """SMOKE TEST entrypoint: exercise ONLY the self-restart dance — no update.
    Proves that the live window can relaunch itself (spawn detached
    restart.ps1, which waits for our PID to exit then `--continue`s).
    --dry-run logs the would-do and spawns restart.ps1 in -DryRun (no kill)."""
    old_pid = _live_claude_pid()
    if old_pid is None:
        msg = "/update --restart-only: could NOT resolve the live claude PID — aborting (no restart)."
        print(msg)
        if not dry_run:
            _send_tg(msg)
        return 2

    shell_pid = _old_shell_pid(old_pid)

    if dry_run:
        print(f"DRY-RUN(restart-only): WOULD spawn restart.ps1 -OldPid {old_pid} then terminate {old_pid}.")
        if shell_pid:
            print(f"DRY-RUN(restart-only): resolved launcher shell PID {shell_pid}; WOULD pass -OldShellPid {shell_pid} (relauncher closes old window).")
        else:
            print("DRY-RUN(restart-only): launcher shell PID NOT resolved (parent not powershell/pwsh); old window will be left as-is.")
        _spawn_restart_detached(old_pid, dry_run=True, old_shell_pid=shell_pid)
        print("DRY-RUN(restart-only): spawned restart.ps1 -DryRun (logs 'would relaunch', no kill).")
        return 0

    notice = ("/update --restart-only (SMOKE TEST): restarting the bot now to verify "
              "self-restart. Back in ~30s, --continue-resuming this conversation.")
    print(notice)
    _send_tg(notice)
    _spawn_restart_detached(old_pid, dry_run=False, old_shell_pid=shell_pid)
    print(f"spawned restart.ps1 -OldPid {old_pid} (shell={shell_pid}); terminating self ({old_pid})")
    _terminate_pid(old_pid)
    return 0


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="update_restart")
    ap.add_argument("--dry-run", action="store_true",
                    help="run update + version check; SKIP notice/restart/kill")
    ap.add_argument("--check-only", action="store_true",
                    help="version probe only; do NOT run `claude update` either")
    ap.add_argument("--auto", action="store_true",
                    help="gated autonomous flow (gates a/b/c); combine with --dry-run")
    ap.add_argument("--restart-only", action="store_true",
                    help="SMOKE TEST: skip the update entirely; just exercise the "
                         "self-restart dance (spawn detached restart.ps1 + kill "
                         "this claude). Combine with --dry-run to log without killing.")
    ap.add_argument("--claude-pid", type=int, default=0,
                    help="live claude.exe pid when the caller is not its descendant "
                         "(the supervisor tick); overrides the ancestor walk")
    args = ap.parse_args(argv[1:])
    if args.claude_pid > 0:
        global _CLAUDE_PID_OVERRIDE
        _CLAUDE_PID_OVERRIDE = args.claude_pid

    if args.restart_only:
        return run_restart_only(dry_run=args.dry_run)

    exe = _claude_exe()
    if not Path(exe).exists():
        msg = f"/update: claude binary not found at {exe}"
        print(msg)
        if not (args.dry_run or args.check_only or args.auto):
            _send_tg(msg)
        return 2

    if args.auto:
        return run_auto(dry_run=args.dry_run, exe=exe)

    ver_before = _claude_version(exe)

    if args.check_only:
        print(f"check-only: current version = {ver_before or '(unreadable)'}")
        print("check-only: skipping `claude update` and restart")
        return 0

    update_out = _run_update(exe)
    ver_after = _claude_version(exe)
    updated = bool(ver_before and ver_after and ver_before != ver_after)

    print(f"version before: {ver_before or '(unreadable)'}")
    print(f"version after:  {ver_after or '(unreadable)'}")
    print(f"updated: {updated}")
    if update_out:
        print(f"--- claude update output ---\n{update_out}")

    if not updated:
        status = f"/update: already current ({ver_after or ver_before or 'unknown'})"
        print(status)
        if not args.dry_run:
            _send_tg(status)
        return 0

    # --- updated: prepare self-restart -------------------------------------
    old_pid = _live_claude_pid()
    shell_pid = _old_shell_pid(old_pid) if old_pid else None
    notice = f"/update: updated {ver_before} -> {ver_after}. Restarting the bot to apply (will --continue this conversation)."

    if args.dry_run:
        print("DRY-RUN: an update landed. WOULD do:")
        print(f"  - TG notice: {notice}")
        print(f"  - spawn restart.ps1 -OldPid {old_pid} (detached)")
        if shell_pid:
            print(f"  - pass -OldShellPid {shell_pid} (relauncher closes old window)")
        print(f"  - terminate live claude pid {old_pid}")
        if old_pid:
            print("DRY-RUN: spawning restart.ps1 in -DryRun (it will log a 'would relaunch', no kill)")
            _spawn_restart_detached(old_pid, dry_run=True, old_shell_pid=shell_pid)
        else:
            print("DRY-RUN: could NOT resolve live claude pid (would abort restart in real run)")
        return 0

    if old_pid is None:
        # Can't safely restart without knowing which claude to kill/wait-on.
        msg = (f"/update: updated {ver_before} -> {ver_after}, but could NOT resolve "
               f"the live claude PID. NOT auto-restarting — restart the bot manually to apply.")
        print(msg)
        _send_tg(msg)
        return 2

    _send_tg(notice)
    _spawn_restart_detached(old_pid, dry_run=False, old_shell_pid=shell_pid)
    # Give the detached child a moment to start its PID-poll before we die.
    print(f"spawned restart.ps1 -OldPid {old_pid} (shell={shell_pid}); terminating self ({old_pid})")
    _terminate_pid(old_pid)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
