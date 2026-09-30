#!/usr/bin/env python3
"""Status footer — short single-line system summary for TG messages and prompts.

Pulls:
  - folder name + git branch + dirty marker
  - model + effort (status.json / env CLAUDE_CODE_EFFORT_LEVEL / settings)
  - context (from status.json, else the latest session jsonl in ~/.claude/projects)
  - subscription usage (from <config_home>/botcorp/status.json)
  - account, only when it is not the bot's own token (launch-env.json)

ONE convention, identical to harness/tools/infra/statusline.js (format_line here,
formatLine there — change both together). Segments joined by " · ", empty ones dropped:
  mybot (main*) · Opus 5.5 high · ctx 361K/500K (72%) · 🟢 5h 12% · wk 62% ↻02:50 · acct ⇄backup

CLI
---
status_footer.py             # full footer
status_footer.py --short     # folder + model/effort + ctx only
status_footer.py --json      # structured
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import instance_root, harness_root, config_home, bot_name  # noqa: E402

REPO_ROOT = instance_root()
HOME = Path(os.path.expanduser("~"))

# Practical context ceiling before Claude Code auto-compacts. The model window
# is 1M, but compaction fires well before that, so the TG footer % should
# reflect the real headroom — the denominator is the compaction limit, not
# the raw window. This is the last-resort default; _compact_ceiling() prefers
# what the session was actually launched with.
MAX_CONTEXT = 500_000


def _compact_ceiling(size: int = 0) -> int:
    """Where Claude Code compacts, the same rule as statusline.js compactCeiling():
    env CLAUDE_CODE_AUTO_COMPACT_WINDOW (the launch sets it per bot), else the
    config home settings.json autoCompactWindow, else the model window `size`,
    else MAX_CONTEXT; scaled by CLAUDE_AUTOCOMPACT_PCT_OVERRIDE when that is
    1-100, and never above `size` when it is known."""
    try:
        ceiling = int(os.environ.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW") or 0)
    except ValueError:
        ceiling = 0
    if ceiling <= 0:
        try:
            s = json.loads((config_home() / "settings.json").read_text(encoding="utf-8"))
            ceiling = int(s.get("autoCompactWindow") or 0)
        except Exception:
            ceiling = 0
    if ceiling <= 0:
        ceiling = size or MAX_CONTEXT
    try:
        pct = float(os.environ.get("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE") or 0)
    except ValueError:
        pct = 0.0
    if 1 <= pct <= 100:
        ceiling = int(ceiling * pct / 100)
    if size:
        ceiling = min(ceiling, size)
    return ceiling


def _git_status() -> str:
    try:
        branch = subprocess.run(
            ["git", "symbolic-ref", "--short", "HEAD"],
            cwd=REPO_ROOT, capture_output=True, text=True, timeout=2,
        ).stdout.strip()
        dirty = subprocess.run(
            ["git", "--no-optional-locks", "status", "--porcelain"],
            cwd=REPO_ROOT, capture_output=True, text=True, timeout=2,
        ).stdout.strip()
        if not branch:
            return ""
        return f"({branch}{'*' if dirty else ''})"
    except Exception:
        return ""


def format_line(folder: str, git: str, model: str, effort: str, ctx: str, usage: str = "",
                account: str = "", account_reason: str = "", short: bool = False) -> str:
    """The one status-line convention (mirrored by statusline.js formatLine)."""
    parts = [f"{folder} {git}".strip(), f"{model} {effort}".strip(), ctx]
    if not short:
        parts.append(usage)
        if account and account != "own":
            # ⇄ = moved there by a failover or failback
            parts.append(f"acct {'⇄' if account_reason in ('failover', 'failback') else ''}{account}")
    return " · ".join(p for p in parts if p)


def _session_id() -> str:
    f = REPO_ROOT / ".claude" / ".current_session_id"
    if f.exists():
        try:
            return f.read_text(encoding="utf-8").strip()
        except Exception:
            pass
    return ""


def _journal_count(sess: str) -> int:
    if not sess:
        return 0
    jp = REPO_ROOT / "memory" / "sessions" / sess / "journal.md"
    if not jp.exists():
        return 0
    try:
        return sum(1 for line in jp.read_text(encoding="utf-8").splitlines()
                   if line.strip().startswith("- ["))
    except Exception:
        return 0


def _project_hash_dir() -> Path | None:
    """Locate ~/.claude/projects/<hash>/ for the current repo."""
    base = config_home() / "projects"
    if not base.is_dir():
        return None
    # Claude Code encodes path separators + drive colon as hyphens (each ':'
    # or path separator becomes its own '-', so a drive colon followed by a
    # separator produces a double hyphen).
    # Earlier this replaced `:` with empty string, which produced a single-hyphen
    # variant that never matched the double-hyphen dir name — context always 0%.
    cwd_str = str(REPO_ROOT).replace(":", "-").replace("\\", "-").replace("/", "-")
    key = cwd_str.lower().lstrip("-")
    # EXACT name match first — scratchpad/headless sessions create project dirs
    # whose names CONTAIN the repo string as a substring (a helper session's
    # scratchpad dir) and sort before it, so the old substring-first-match read
    # a helper session's transcript (wrong model + tiny ctx in the footer).
    exact = base / ("C" + cwd_str.lstrip("-")[1:])
    for d in base.iterdir():
        if d.is_dir() and d.name.lower() == key:
            return d
    if exact.is_dir():
        return exact
    for d in base.iterdir():
        if d.is_dir() and key in d.name.lower():
            return d
    return None


_LAST_MODEL = ""  # set as a side effect of the same jsonl tail read
_LAST_DISPLAY = ""  # status.json model.display_name, when that was the source


def _context_window() -> tuple[int, int, float]:
    """Return (used_tokens, max_tokens, pct_remaining).

    Reads the latest assistant entry from the most-recent session jsonl in
    ~/.claude/projects/<projdir>/. Sums input_tokens + cache_read +
    cache_creation_input — that's the context the model just saw. Also stashes
    the entry's model id in _LAST_MODEL (the live session model, which can
    differ from the settings.json pin).
    """
    global _LAST_MODEL, _LAST_DISPLAY
    _LAST_DISPLAY = ""
    # Preferred source: the statusline's status.json (CC 2.1.281 stdin carries
    # context_window.current_usage + context_window_size; docs/cc-compat.md i).
    # The transcript tail below is the fallback for a session with no statusline
    # write yet (or a stale one).
    try:
        st = json.loads(STATUS_JSON.read_text(encoding="utf-8"))
        cw = st.get("context_window") or {}
        cu = cw.get("current_usage") or {}
        size = int(cw.get("context_window_size") or 0)
        if size and (time.time() - float(st.get("ts") or 0)) < 600:
            used = int(cu.get("input_tokens") or 0) + int(cu.get("cache_read_input_tokens") or 0) \
                + int(cu.get("cache_creation_input_tokens") or 0)
            _LAST_MODEL = (st.get("model") or {}).get("id") or _LAST_MODEL
            _LAST_DISPLAY = str((st.get("model") or {}).get("display_name") or "")
            ceiling = _compact_ceiling(size)
            return (used, ceiling, max(0.0, 1.0 - used / ceiling))
    except Exception:
        pass
    ceiling = _compact_ceiling()
    proj = _project_hash_dir()
    if proj is None:
        return (0, ceiling, 1.0)
    jsonls = sorted(proj.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not jsonls:
        return (0, ceiling, 1.0)
    latest = jsonls[0]
    last_usage: dict | None = None
    try:
        # Read tail (most recent assistant entry)
        with latest.open("rb") as f:
            f.seek(0, 2)
            size = f.tell()
            tail = min(size, 200_000)
            f.seek(size - tail)
            chunk = f.read().decode("utf-8", errors="replace")
        # Collect recent non-sidechain assistant entries and keep the one with
        # the LARGEST context. Subagent sidechains AND small harness helper
        # turns (Sonnet, ~40K ctx) interleave with the Director's entries in
        # the same jsonl; taking whichever happens to be last made the footer
        # report the wrong model + a tiny context (found: the footer named a
        # different model than the one that actually answered). The Director's
        # real turn always carries
        # the biggest context of the recent window, so max-ctx wins.
        candidates = []
        for line in reversed(chunk.splitlines()):
            if not line.strip():
                continue
            try:
                e = json.loads(line)
                if e.get("isSidechain"):
                    continue
                if e.get("type") == "assistant" and e.get("message", {}).get("usage"):
                    u = e["message"]["usage"]
                    ctx = (
                        (u.get("input_tokens") or 0)
                        + (u.get("cache_read_input_tokens") or 0)
                        + (u.get("cache_creation_input_tokens") or 0)
                    )
                    candidates.append((ctx, u, e["message"].get("model") or ""))
                    if len(candidates) >= 8:
                        break
            except Exception:
                continue
        if candidates:
            _ctx, last_usage, _LAST_MODEL = max(candidates, key=lambda c: c[0])
    except Exception:
        return (0, ceiling, 1.0)
    if not last_usage:
        return (0, ceiling, 1.0)
    used = (
        (last_usage.get("input_tokens") or 0)
        + (last_usage.get("cache_read_input_tokens") or 0)
        + (last_usage.get("cache_creation_input_tokens") or 0)
    )
    remaining = max(0.0, 1.0 - used / ceiling)
    return (used, ceiling, remaining)


def _model_short() -> str:
    """Display name: status.json display_name minus "Claude ", else derived from
    the id ('claude-opus-5-5' -> 'Opus 5.5', 'claude-fable-5-1' -> 'Fable 5.1')."""
    if _LAST_DISPLAY:
        return _LAST_DISPLAY.removeprefix("Claude ").strip()
    mid = _LAST_MODEL.split("[")[0]
    if not mid:
        return ""
    parts = mid.replace("claude-", "").split("-")
    name = parts[0].capitalize()
    nums = [p for p in parts[1:] if p.isdigit() and len(p) < 4][:2]  # drop date suffixes like 20251001
    return f"{name} {'.'.join(nums)}" if nums else name


def _effort() -> str:
    """status.json effort.level (fresh) -> env CLAUDE_CODE_EFFORT_LEVEL -> settings effortLevel."""
    try:
        st = json.loads(STATUS_JSON.read_text(encoding="utf-8"))
        if time.time() - float(st.get("ts") or 0) < 600:
            e = st.get("effort")
            level = e.get("level") if isinstance(e, dict) else e
            if level:
                return str(level).lower()
    except Exception:
        pass
    env = os.environ.get("CLAUDE_CODE_EFFORT_LEVEL")
    if env:
        return env.strip().lower()
    for f in (REPO_ROOT / ".claude" / "settings.json", config_home() / "settings.json"):
        try:
            level = json.loads(f.read_text(encoding="utf-8")).get("effortLevel")
            if level:
                return str(level).lower()
        except Exception:
            continue
    return ""


def _fmt_tokens(n: int) -> str:
    if n >= 1_000_000:
        return f"{n/1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n/1_000:.0f}K"
    return str(n)


STATUS_JSON = config_home() / "botcorp" / "status.json"
USAGE_MAX_AGE_S = 30 * 60


def _usage_status() -> str:
    """Subscription quota (5h/weekly) from <config_home>/botcorp/status.json's
    `rate_limits` field (written by the statusline — this tool no longer
    probes on its own). If it's stale past USAGE_MAX_AGE_S we show nothing
    rather than a wrong number (a six-hour-old "40%" could be a current
    "100%").
    """
    import time as _time
    try:
        s = json.loads(STATUS_JSON.read_text(encoding="utf-8"))
        if _time.time() - (s.get("ts") or 0) > USAGE_MAX_AGE_S:
            return ""
        # Claude Code's own statusline shape, copied verbatim by statusline.js:
        # rate_limits.{five_hour,seven_day}.{used_percentage (0-100), resets_at (ISO)}
        rl = s.get("rate_limits") or {}
        u5 = (rl.get("five_hour") or {}).get("used_percentage")
        u7 = (rl.get("seven_day") or {}).get("used_percentage")
        if u5 is None and u7 is None:
            return ""

        def p(v):
            if v is None:
                return "?"
            n = float(v)
            return (f"{n:.0f}" if abs(n - round(n)) < 0.05 else f"{n:.1f}") + "%"

        worst = max(float(u5 or 0), float(u7 or 0))
        dot = "🔴" if worst >= 90 else "🟡" if worst >= 75 else "🟢"
        from datetime import datetime as _dt
        resets = []
        for r in ((rl.get("five_hour") or {}).get("resets_at"),
                  (rl.get("seven_day") or {}).get("resets_at")):
            if not r:
                continue
            try:
                if isinstance(r, (int, float)):
                    resets.append(_dt.fromtimestamp(float(r)))
                else:
                    resets.append(_dt.fromisoformat(str(r).replace("Z", "+00:00")).astimezone())
            except Exception:
                continue
        hhmm = min(resets).strftime("%H:%M") if resets else ""
        return f"{dot} 5h {p(u5)} · wk {p(u7)}" + (f" ↻{hhmm}" if hhmm else "")
    except Exception:
        return ""


LAUNCH_ENV_JSON = config_home() / "botcorp" / "launch-env.json"


def _account_status() -> tuple[str, str]:
    """(account, reason) of the newest launch record in
    <config_home>/botcorp/launch-env.json, written by daemon/launch.ps1 at every
    launch: `account` is the registry id the launch ran on ('' = the bot's own
    token -> "own"), `account_reason` is why (primary | failover | failback |
    recover; absent on a pre-0.8 record). ("", "") when there is no record."""
    try:
        launches = (json.loads(LAUNCH_ENV_JSON.read_text(encoding="utf-8")).get("launches") or {}).values()
        newest = max((r for r in launches if isinstance(r, dict)), key=lambda r: str(r.get("at") or ""), default=None)
        if newest is None:
            return "", ""
        account = str(newest.get("account") or "") or "own"
        return account, str(newest.get("account_reason") or "")
    except Exception:
        return "", ""


def _tg_status() -> str:
    pidf = config_home() / "channels" / "telegram" / "bot.pid"
    if not pidf.exists():
        return "TG🔴"
    try:
        pid = int(pidf.read_text(encoding="utf-8").strip())
    except Exception:
        return "TG🔴"
    try:
        # Windows: tasklist; POSIX: kill -0
        if os.name == "nt":
            r = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                capture_output=True, text=True, timeout=2,
            )
            return "TG🟢" if str(pid) in r.stdout else "TG🔴"
        else:
            os.kill(pid, 0)
            return "TG🟢"
    except Exception:
        return "TG🔴"


def _harness_version() -> str:
    try:
        p = json.loads((harness_root() / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
        v = p.get("version") or ""
        return f"harness v{v}" if v else ""
    except Exception:
        return ""


def build_footer(short: bool = False, as_json: bool = False) -> str:
    name = bot_name()
    folder = REPO_ROOT.name
    git = _git_status()
    sess = _session_id()
    sess_short = sess[-8:] if sess else ""
    jcount = _journal_count(sess)
    used, mx, rem = _context_window()  # also stashes _LAST_MODEL
    pct_used = round((used / mx) * 100) if mx else 0
    model = _model_short()
    effort = _effort()
    usage = _usage_status()
    account, account_reason = _account_status()
    tg = _tg_status()
    harness_ver = _harness_version()

    if as_json:
        return json.dumps({
            "bot_name": name,
            "folder": folder,
            "git": git,
            "session_id": sess,
            "journal_entries": jcount,
            "context_used": used,
            "context_max": mx,
            "context_pct_used": pct_used,
            "model": model,
            "effort": effort,
            "usage": usage,
            "account": account,
            "account_reason": account_reason,
            "tg": tg,
            "harness_version": harness_ver,
        })

    return format_line(folder, git, model, effort, f"ctx {_fmt_tokens(used)}/{_fmt_tokens(mx)} ({pct_used}%)",
                       usage, account, account_reason, short=short)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--short", action="store_true")
    p.add_argument("--json", action="store_true")
    args = p.parse_args()
    print(build_footer(short=args.short, as_json=args.json))
    return 0


if __name__ == "__main__":
    sys.exit(main())
