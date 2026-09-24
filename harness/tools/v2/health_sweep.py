#!/usr/bin/env python3
"""health_sweep.py — one zero-LLM pass over every health signal on this box.

The supervisor tick already RUNS the monitors, and those alert the OPERATOR.
This sweep is the read side for the BOT: it aggregates every signal into
PASS/FAIL lines the director can act on, so a self-check prompts a fix instead
of only producing another notification nobody reads.

    PYTHONIOENCODING=utf-8 python tools/v2/health_sweep.py          # report
    ... --json                                                      # JSON out

Built-in checks:
  tg-poller       tg_watchdog --probe-only     (409 = ALIVE is the good state)
  supervisor      supervisor.log fresh          (< 10 min; 3-min ticks)
  disk            free space on the repo's volume (FAIL under 10 GB)
  browser-orphans leftover headless Chrome processes (> 6 = a leak)

Add your own to CHECKS. A check is a zero-argument callable returning
`(ok: bool, detail: str)`; anything it raises is caught and reported as a FAIL,
so one broken check can never take the sweep down with it.

Exit code is ALWAYS 0. This is a report, not a gate — FAIL lines carry enough
detail to act on and the director owns the fixing.

## Give a check a budget that matches what it measures

The single most valuable line in this file is the timeout argument to `run()`,
and it is the one that gets guessed. Measure the thing first, then set the
budget above its worst observed run, not near its median.

  - **A check that always fails is worse than no check.** It does not sit
    there being ignored; it teaches you to skim past the one line that
    matters, and it hides the real failure when it finally arrives.
  - **A timeout must not report as a crash.** `TIMED_OUT` is a distinct code
    so a too-short budget reads as "the budget is wrong", not "the tool is
    broken" — give the operator the sentence that names the budget.

When two places bound the same external tool, say in a comment which one is
authoritative, so a future divergence has an answer already written down.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import instance_root, harness_root  # noqa: E402

REPO = instance_root()
PY = sys.executable


def _resolve_curl() -> str:
    """A bare 'curl' fails to spawn (ENOENT) from a session-0 / Scheduled-Task
    environment with a minimal PATH; System32's curl.exe ships on Windows 10+."""
    if os.name == "nt":
        native = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "curl.exe")
        if os.path.isfile(native):
            return native
        return shutil.which("curl") or "curl"
    return shutil.which("curl") or "curl"


CURL_EXE = _resolve_curl()

#: Distinct from the -1 catch-all so a budget problem never reads as a broken
#: tool. See the module docstring — this distinction is the whole fix.
TIMED_OUT = -2


def run(cmd: list[str], timeout: int = 120) -> tuple[int, str]:
    try:
        p = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout,
            cwd=str(REPO), encoding="utf-8", errors="replace",
        )
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except subprocess.TimeoutExpired:
        # Its OWN code, distinct from the -1 catch-all. "monitor unreadable
        # (exit=-1)" is what a too-short timeout looked like for as long as this
        # bug lived, and it reads like the tool is broken rather than like the
        # budget is wrong.
        return TIMED_OUT, f"TimeoutExpired: exceeded {timeout}s"
    except Exception as e:  # noqa: BLE001 — fail-open by contract
        return -1, f"{type(e).__name__}: {e}"


def check_tg_poller() -> tuple[bool, str]:
    rc, out = run([PY, str(harness_root() / "tools" / "v2" / "tg_watchdog.py"), "--probe-only"], timeout=60)
    up = "ALIVE" in out
    verdict = "ALIVE" if up else ("DEAD" if "DEAD" in out else "UNKNOWN")
    # UNKNOWN is a transient non-answer, not an outage — don't page on it.
    return up or verdict == "UNKNOWN", f"poller={verdict}"


def check_supervisor() -> tuple[bool, str]:
    log = REPO / "memory/metrics/supervisor.log"
    if not log.exists():
        return False, "supervisor.log missing"
    age = time.time() - log.stat().st_mtime
    return age < 600, f"log age {int(age)}s (tick=180s)"


#: Below this and the box is close enough to full that builds, caches and log
#: writes start failing in ways that look like unrelated bugs.
DISK_FLOOR_GB = 10.0


def check_disk() -> tuple[bool, str]:
    # The repo's own volume, not a hardcoded drive letter: the answer that
    # matters is "can this bot still write", and on a POSIX box `C:\` is not
    # even a path.
    _total, _used, free = shutil.disk_usage(str(REPO))
    free_gb = free / 1e9
    return free_gb >= DISK_FLOOR_GB, f"{free_gb:.1f} GB free on the repo volume"


def check_browser_orphans() -> tuple[bool, str]:
    """Headless browser processes that outlived their run.

    Filtered to the AUTOMATION browser's own install path. Counting every
    Chrome process would sweep in the operator's ordinary browsing, and a
    check that reports open tabs as a leak gets switched off.
    """
    if os.name != "nt":
        rc, out = run(["pgrep", "-fc", "agent-browser"], timeout=30)
        # pgrep exits 1 with no match, which is the healthy answer here.
        n = int(out.strip() or 0) if rc == 0 else 0
        return n <= 6, f"{n} automation chrome procs"
    rc, out = run(
        ["powershell", "-NoProfile", "-Command",
         "(Get-Process chrome -ErrorAction SilentlyContinue | Where-Object "
         "{$_.Path -like '*agent-browser*'} | Measure-Object).Count"],
        timeout=60,
    )
    try:
        n = int(out.strip().splitlines()[-1])
    except (ValueError, IndexError):
        # Unreadable is not unhealthy. Say so rather than inventing a verdict.
        return True, "count unreadable (skip)"
    return n <= 6, f"{n} automation chrome procs"


def check_http(url: str, timeout: int = 30) -> tuple[bool, str]:
    """Reusable: is a service answering at all?

    ANY HTTP status counts as up, including 401/403. An auth wall proves the
    tunnel and the host are alive, which is what this check is actually
    asking; demanding a 200 would turn every protected endpoint into a false
    alarm.
    """
    rc, out = run(
        [CURL_EXE, "-s", "-o", os.devnull, "-w", "%{http_code}", "--max-time", str(timeout // 2), url],
        timeout=timeout,
    )
    code = out.strip()[-3:]
    return bool(re.fullmatch(r"[1-5]\d\d", code)) and code != "000", f"http={code or 'none'}"


#: (name, callable) — extend with the checks this deployment actually has.
#: An external monitor of your own goes here; read the module docstring on
#: budgets before you pick its timeout.
CHECKS = [
    ("tg-poller", check_tg_poller),
    ("supervisor", check_supervisor),
    ("disk", check_disk),
    ("browser-orphans", check_browser_orphans),
]


def main() -> int:
    as_json = "--json" in sys.argv[1:]
    results = []
    for name, fn in CHECKS:
        try:
            ok, detail = fn()
        except Exception as e:  # noqa: BLE001 — a check must never kill the sweep
            ok, detail = False, f"check crashed: {type(e).__name__}: {e}"
        results.append({"check": name, "ok": ok, "detail": detail})
    fails = [r for r in results if not r["ok"]]
    if as_json:
        print(json.dumps({"ok": not fails, "results": results}, ensure_ascii=False))
    else:
        for r in results:
            print(f"{'PASS' if r['ok'] else 'FAIL'}  {r['check']:<16} {r['detail']}")
        print(f"--- {'ALL GREEN' if not fails else f'{len(fails)} FAILING: ' + ', '.join(r['check'] for r in fails)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
