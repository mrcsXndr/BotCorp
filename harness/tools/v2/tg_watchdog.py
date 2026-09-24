#!/usr/bin/env python3
"""tg_watchdog.py — detect a dead Telegram long-poller and auto-heal by restart.

WHY this exists: the TG Bot API allows only ONE getUpdates long-poller per bot
token. When a second bot instance steals the slot, the original poller 409s
into a permanent dead state — the claude process stays alive (outbound tg_send
still works) but inbound messages are silently dropped. This watchdog probes
the slot, and when it confirms the poller is dead AND the session is idle, it
triggers the same detached restart dance used by /update (reusing
update_restart.py's machinery), which re-acquires the lock and resumes polling.

Probe classification (getUpdates?timeout=0&offset=-1&limit=1):
  HTTP 409  -> ALIVE   (another poller — our own — holds the slot: healthy)
  HTTP 200  -> (slot free this instant: NOT proof of death — see below)
  other/net -> UNKNOWN (transient/network/token: take no action)

CRITICAL — the official plugin polls in INTERVALS, not one continuous long-poll.
So a healthy poller's slot ALTERNATES: 409 mid-poll, 200 in the gap between
polls (observed live: 200/409/200/409/200 at ~2s spacing). A single 200 — or
even several — therefore does NOT mean dead. We sample the slot PROBE_SAMPLES
times across a window LONGER than the poll cycle:
  - ANY 409 in the window      -> ALIVE (early exit; a live poll exists)
  - EVERY sample is 200         -> DEAD  (slot never claimed across the window)
  - 200s mixed with net-UNKNOWN -> UNKNOWN (ambiguous; take no action)
This defeats the false-DEAD an interval-poller would otherwise trigger.

Flags:
  --probe-only          print ALIVE/DEAD/UNKNOWN and exit; no heal, no alert.
  --dry-run             classify + log the would-do action; no restart, no alert.
  --config-dir <path>   where to find channels/telegram/.env + bot.pid
                         (default: config_home(), i.e. CLAUDE_CONFIG_DIR or ~/.claude)

Token resolution: <config-dir>/channels/telegram/.env's TELEGRAM_BOT_TOKEN=,
else the TELEGRAM_BOT_TOKEN env var. A bad or absent token classifies as
UNKNOWN — never a crash.

Fail-open: any exception in main() is logged and the process exits 0. Never
non-zero, never a spurious restart.
"""
from __future__ import annotations

import datetime
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import instance_root, harness_root, config_home, runtime_root, bot_name  # noqa: E402

# Reuse update_restart.py's proven machinery (proc-walk, restart-spawn,
# terminate, idle gate). Do NOT reinvent any of this.
from update_restart import (  # noqa: E402
    gate_session_idle,
    _live_claude_pid,
    _spawn_restart_detached,
    _terminate_pid,
)

REPO_ROOT = instance_root()
TG_SEND = harness_root() / "tools" / "tg" / "tg_send.py"
HEAL_LOG = runtime_root() / "logs" / bot_name() / "tg_heals.log"


def _env_file(config_dir: Path) -> Path:
    return config_dir / "channels" / "telegram" / ".env"


def _bot_pid_file(config_dir: Path) -> Path:
    return config_dir / "channels" / "telegram" / "bot.pid"


def _owner_lock_file(config_dir: Path) -> Path:
    return config_dir / "botcorp" / "tg_owner.lock"

# Backoff: refuse > MAX_HEALS within WINDOW_MIN rolling minutes.
MAX_HEALS = 3
WINDOW_MIN = 30
# Liveness sampling. The plugin interval-polls, so the slot flaps 409/200 on a
# ~2-4s cycle. Sample across a window LONGER than that cycle: a healthy poller
# WILL show >=1 409; a dead one is all-200 the whole window. 8 samples x 2s
# ~= 16s window (spans several poll cycles).
PROBE_SAMPLES = 8
PROBE_SLEEP_S = 2
PROBE_TIMEOUT_S = 10

ALIVE = "ALIVE"
DEAD = "DEAD"
UNKNOWN = "UNKNOWN"
STOLEN = "STOLEN"  # slot held (409) but NOT by our live claude's tree
FREE = "FREE"  # slot unclaimed this instant (HTTP 200) — internal to _probe_once

# Holder verification (STOLEN detection): when the slot probes ALIVE, netstat
# the Telegram API connections and walk each owner's parent chain. 2026-07-13
# incident: a plain `claude` launch (no --channels) auto-started a bridge from
# global enabledPlugins and STOLE the slot — probe said ALIVE while the
# bot's inbound was dead for hours. Samples > 1 because the plugin interval-polls
# (connection gaps between cycles are normal).
HOLDER_SAMPLES = 3
HOLDER_SLEEP_S = 3


def _now_iso() -> str:
    return datetime.datetime.now().isoformat(timespec="seconds")


def _log(line: str) -> None:
    """Append one ISO-stamped line to the heal log. Best-effort."""
    try:
        HEAL_LOG.parent.mkdir(parents=True, exist_ok=True)
        with HEAL_LOG.open("a", encoding="utf-8") as fh:
            fh.write(f"{_now_iso()}  {line}\n")
    except Exception:
        pass


def _read_token(config_dir: Path) -> str | None:
    """<config-dir>/channels/telegram/.env's TELEGRAM_BOT_TOKEN=, else the
    TELEGRAM_BOT_TOKEN env var. Never raises — a bad/absent token just means
    no token, which the caller classifies as UNKNOWN."""
    try:
        for raw in _env_file(config_dir).read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if line.startswith("TELEGRAM_BOT_TOKEN="):
                val = line.split("=", 1)[1].strip().strip('"').strip("'")
                if val:
                    return val
    except OSError:
        pass
    return os.environ.get("TELEGRAM_BOT_TOKEN") or None


def _send_tg(text: str) -> None:
    """Outbound alert. Unaffected by poller death. Let the status footer append
    (no --no-status), per brief."""
    try:
        subprocess.run(
            [sys.executable or "python", str(TG_SEND), "--quiet", text],
            capture_output=True, text=True, timeout=20, encoding="utf-8",
        )
    except Exception as e:
        _log(f"tg_send failed: {e}")


def _probe_once(token: str) -> str:
    """Single getUpdates probe. Returns:
      ALIVE   on HTTP 409 (an active getUpdates holds the slot)
      "FREE"  on HTTP 200 (slot unclaimed THIS instant — not proof of death)
      UNKNOWN on network/timeout/other HTTP."""
    url = (f"https://api.telegram.org/bot{token}/getUpdates"
           f"?timeout=0&offset=-1&limit=1")
    req = urllib.request.Request(url, headers={"User-Agent": "BotCorp-TG-Watchdog/1"})
    try:
        with urllib.request.urlopen(req, timeout=PROBE_TIMEOUT_S) as resp:
            return ALIVE if resp.status == 409 else FREE
    except urllib.error.HTTPError as e:
        if e.code == 409:
            return ALIVE
        return UNKNOWN
    except Exception:
        # Network/timeout/DNS/other -> indeterminate, take no action.
        return UNKNOWN


_HOLDER_PS = r"""
$probeErr = ''
try {
    $ips = [System.Net.Dns]::GetHostAddresses('api.telegram.org') | ForEach-Object IPAddressToString
    if (-not $ips) { $probeErr = 'dns-empty' }
    $pids = Get-NetTCPConnection -State Established -ErrorAction Stop |
        Where-Object { $_.RemoteAddress -in $ips } |
        Select-Object -ExpandProperty OwningProcess -Unique
} catch { $probeErr = "$_" }
$out = @()
foreach ($p in $pids) {
    $chain = @(); $cur = [int]$p
    for ($i = 0; $i -lt 10 -and $cur -gt 4; $i++) {
        $pr = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
        if (-not $pr) { break }
        $chain += [int]$pr.ProcessId
        $cur = [int]$pr.ParentProcessId
    }
    $out += ,@{ pid = [int]$p; chain = $chain }
}
@{ holders = $out; err = $probeErr } | ConvertTo-Json -Compress -Depth 5
"""


def _holder_verdict(claude_pid: int | None = None) -> str:
    """When the slot probes ALIVE, verify WHO holds it. Returns:
      "ours"    — a local TG-API connection's parent chain contains our live
                  claude PID (healthy).
      "foreign" — local TG-API connection(s) exist but none belong to our
                  claude's tree (another local claude/bridge stole the slot).
      "absent"  — no local TG-API connection seen across the sampling window
                  (holder is remote/another machine, or we raced the poll
                  cycle every time). NOT proof of theft — the caller must NOT
                  treat this as STOLEN (2026-07-13 review: benign absences —
                  DNS answer missing our connection's RemoteAddress, racing
                  the poll gap 3x — would otherwise restart a healthy bot).
      "unknown" — could not determine (no claude PID, PS failure) — treat as
                  healthy, take no action (fail-open)."""
    # Precedence: explicit --claude-pid (the supervisor resolves the live
    # claude every tick and passes it — .botcorp_state.json does not always
    # exist, so without this the task context degraded to "unknown"/no-detect),
    # then parent-walk (in-session runs), then the state marker (other contexts).
    our_pid = claude_pid or _live_claude_pid()
    if our_pid is None:
        try:
            st = json.loads((REPO_ROOT / ".claude" / ".botcorp_state.json")
                            .read_text(encoding="utf-8"))
            our_pid = int(st.get("claude_pid") or 0) or None
        except Exception:
            our_pid = None
    if our_pid is None:
        return "unknown"
    # Absolute path: session env can have a clobbered PATH (the settings.json
    # PATH trap) and scheduled tasks can miss user PATH — never rely on it.
    ps_exe = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"),
                          "System32", "WindowsPowerShell", "v1.0",
                          "powershell.exe")
    saw_foreign = False
    saw_any = False
    for i in range(HOLDER_SAMPLES):
        try:
            r = subprocess.run(
                [ps_exe, "-NoProfile", "-Command", _HOLDER_PS],
                capture_output=True, text=True, timeout=45, encoding="utf-8",
            )
            raw = (r.stdout or "").strip()
            if not raw:
                # Script produced nothing at all -> PS-level failure, not
                # "zero connections". Indeterminate.
                _log("holder probe: empty PS output (fail-open)")
                return "unknown"
            envelope = json.loads(raw)
            if envelope.get("err"):
                # Cmdlet failure inside the script (e.g. Get-NetTCPConnection
                # access denied) — an empty holder list would be a LIE here.
                _log(f"holder probe: PS err sentinel: {envelope['err'][:200]}")
                return "unknown"
            holders = envelope.get("holders") or []
            if isinstance(holders, dict):
                holders = [holders]
            for h in holders:
                saw_any = True
                if our_pid in (h.get("chain") or []):
                    return "ours"
                saw_foreign = True
        except Exception as e:
            _log(f"holder probe failed (fail-open): {e!r}")
            return "unknown"
        if i < HOLDER_SAMPLES - 1:
            time.sleep(HOLDER_SLEEP_S)
    if saw_foreign:
        return "foreign"
    return "absent" if not saw_any else "unknown"


def classify(token: str) -> str:
    """Sample the poll slot across a window LONGER than the plugin's poll cycle.
    The plugin interval-polls, so a healthy slot flaps 409/200 — a single (or
    several) 200 does NOT mean dead. Verdict:
      - ANY 409 seen          -> ALIVE  (early exit: a live poll exists)
      - EVERY sample is 200    -> DEAD  (slot never claimed the whole window)
      - 200s + any net-UNKNOWN -> UNKNOWN (ambiguous; take no action)."""
    saw_unknown = False
    for i in range(PROBE_SAMPLES):
        r = _probe_once(token)
        if r == ALIVE:
            return ALIVE
        if r == UNKNOWN:
            saw_unknown = True
        # r == FREE (200) just continues sampling
        if i < PROBE_SAMPLES - 1:
            time.sleep(PROBE_SLEEP_S)
    # No 409 in the entire window.
    return UNKNOWN if saw_unknown else DEAD


def _recent_heal_count(now: float | None = None) -> int:
    """Count heal actions logged within the rolling WINDOW_MIN window."""
    now = now if now is not None else time.time()
    cutoff = now - WINDOW_MIN * 60
    count = 0
    try:
        for raw in HEAL_LOG.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or " heal" not in line:
                continue
            stamp = line.split("  ", 1)[0]
            try:
                ts = datetime.datetime.fromisoformat(stamp).timestamp()
            except ValueError:
                continue
            if ts >= cutoff:
                count += 1
    except OSError:
        return 0
    return count


def heal(dry_run: bool, claude_pid: int | None = None) -> int:
    """Confirmed-DEAD path: enforce backoff, check idle gate, then restart.
    claude_pid: same explicit PID used for detection (--claude-pid) so heal
    and detection can never disagree on the target (review finding #4).
    Always returns 0 (heal is best-effort; never a hard failure)."""
    recent = _recent_heal_count()
    if recent >= MAX_HEALS:
        _log(f"heal cap hit ({recent}/{WINDOW_MIN}m) — refusing restart")
        if not dry_run:
            _send_tg("TG poller dead but heal cap hit "
                     f"(3/30m) — restart the bot manually")
        return 0

    idle, why = gate_session_idle()
    if not idle:
        _log(f"deferred: BUSY — {why}")
        if not dry_run:
            _send_tg("TG poller down, deferring restart (session busy)")
        return 0

    old_pid = claude_pid or _live_claude_pid()
    if dry_run:
        _log(f"DRY-RUN heal: would restart -OldPid {old_pid} "
             f"(idle: {why})")
        return 0

    if old_pid is None:
        _log("heal: could NOT resolve live claude PID — not restarting blind")
        _send_tg("TG poller dead — could not resolve the claude PID, "
                 "restart the bot manually")
        return 0

    _log(f"heal: poller DEAD + idle -> restart -OldPid {old_pid}")
    _send_tg("TG poller dead — auto-healing (restart)")
    _spawn_restart_detached(old_pid, dry_run=False)
    _terminate_pid(old_pid)
    return 0


def main(argv: list[str]) -> int:
    probe_only = "--probe-only" in argv[1:]
    dry_run = "--dry-run" in argv[1:]
    claude_pid: int | None = None
    if "--claude-pid" in argv[1:]:
        try:
            claude_pid = int(argv[argv.index("--claude-pid") + 1]) or None
        except (IndexError, ValueError):
            claude_pid = None
    config_dir = config_home()
    if "--config-dir" in argv[1:]:
        try:
            config_dir = Path(argv[argv.index("--config-dir") + 1])
        except IndexError:
            pass

    token = _read_token(config_dir)
    if not token:
        # No token -> cannot probe -> UNKNOWN, take no action (fail-open).
        if probe_only:
            print(UNKNOWN)
        else:
            _log("UNKNOWN: no TELEGRAM_BOT_TOKEN — no action")
        return 0

    verdict = classify(token)

    # ALIVE only proves SOMEONE polls — verify it's OUR claude's tree. A
    # foreign holder (2026-07-13: plain-claude auto-started bridge) means our
    # inbound is dead while the probe looks healthy.
    if verdict == ALIVE:
        holder = _holder_verdict(claude_pid)
        if holder == "foreign":
            # STOLEN requires POSITIVE evidence: a local TG-API connection
            # whose parent chain does NOT contain our claude. "absent" is NOT
            # enough — benign absences (DNS/RemoteAddress mismatch, racing
            # the poll gap) would restart a healthy bot (review finding #1).
            verdict = STOLEN
            _log("slot ALIVE but holder=foreign -> STOLEN")
        elif holder == "absent":
            _log("slot ALIVE, holder=absent (no local TG conn seen) — "
                 "treating as healthy, no action")

    if probe_only:
        print(verdict)
        return 0

    if verdict == ALIVE:
        # Healthy: stay quiet (don't spam the heal log on every tick).
        return 0
    if verdict == UNKNOWN:
        _log("UNKNOWN: indeterminate probe — no action")
        return 0

    if verdict == STOLEN:
        _log("STOLEN: poll slot held by a foreign process — healing (restart "
             "reclaims; the thief's plugin gives up after one 409)")
        if not dry_run:
            _send_tg("⚠️ TG poll slot STOLEN by another claude session on this "
                     "box — my inbound is dead. Auto-healing (restart reclaims); "
                     "close stray `claude` windows to prevent re-theft.")
        return heal(dry_run=dry_run, claude_pid=claude_pid)

    # verdict == DEAD
    return heal(dry_run=dry_run, claude_pid=claude_pid)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception as e:  # fail-open: never non-zero, never a spurious restart
        _log(f"FAIL-OPEN: unhandled exception: {e!r}")
        sys.exit(0)
