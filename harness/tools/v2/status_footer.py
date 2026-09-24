#!/usr/bin/env python3
"""Status footer — short single-line system summary for TG messages and prompts.

Pulls:
  - bot name + git branch + dirty marker
  - session id (short) + journal entry count
  - context %% (from the latest session jsonl in ~/.claude/projects)
  - tg channel health (from ~/.claude/channels/telegram/bot.pid)
  - subscription usage (from <config_home>/botcorp/status.json)
  - harness version (from harness/.claude-plugin/plugin.json)

Output format (one line):
  📍 my-bot (main*) · sess 20260509-... · ctx 287K/1M (29%) · TG🟢 · harness v1.0.0

CLI
---
status_footer.py             # full footer
status_footer.py --short     # bot name + ctx only
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
# the raw window.
MAX_CONTEXT = 500_000


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


def _context_window() -> tuple[int, int, float]:
    """Return (used_tokens, max_tokens, pct_remaining).

    Reads the latest assistant entry from the most-recent session jsonl in
    ~/.claude/projects/<projdir>/. Sums input_tokens + cache_read +
    cache_creation_input — that's the context the model just saw. Also stashes
    the entry's model id in _LAST_MODEL (the live session model, which can
    differ from the settings.json pin).
    """
    global _LAST_MODEL
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
            return (used, size, max(0.0, 1.0 - used / size))
    except Exception:
        pass
    proj = _project_hash_dir()
    if proj is None:
        return (0, MAX_CONTEXT, 1.0)
    jsonls = sorted(proj.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not jsonls:
        return (0, MAX_CONTEXT, 1.0)
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
        return (0, MAX_CONTEXT, 1.0)
    if not last_usage:
        return (0, MAX_CONTEXT, 1.0)
    used = (
        (last_usage.get("input_tokens") or 0)
        + (last_usage.get("cache_read_input_tokens") or 0)
        + (last_usage.get("cache_creation_input_tokens") or 0)
    )
    max_tokens = MAX_CONTEXT  # compaction ceiling, not the raw 1M window
    remaining = max(0.0, 1.0 - used / max_tokens)
    return (used, max_tokens, remaining)


def _model_short() -> str:
    """'claude-opus-4-8' -> 'Opus4.8', 'claude-fable-5' -> 'Fable5' (+ effort)."""
    mid = _LAST_MODEL
    if not mid:
        return ""
    core = mid.replace("claude-", "")
    parts = core.split("-")
    name = parts[0].capitalize()
    nums = [p for p in parts[1:] if p.isdigit()][:2]  # drop date suffixes like 20251001
    ver = ".".join(nums)
    label = f"{name}{ver}" if ver else name
    try:
        settings = json.loads((REPO_ROOT / ".claude" / "settings.json").read_text(encoding="utf-8"))
        effort = (settings.get("effortLevel") or "").capitalize()
        if effort:
            label += f" {effort}"
    except Exception:
        pass
    return label


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
        return f"{dot}5h {p(u5)} · wk {p(u7)}" + (f" ↻{hhmm}" if hhmm else "")
    except Exception:
        return ""


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
    git = _git_status()
    sess = _session_id()
    sess_short = sess[-8:] if sess else ""
    jcount = _journal_count(sess)
    used, mx, rem = _context_window()  # also stashes _LAST_MODEL
    pct_used = int((used / mx) * 100) if mx else 0
    model = _model_short()
    usage = _usage_status()
    tg = _tg_status()
    harness_ver = _harness_version()

    if as_json:
        return json.dumps({
            "bot_name": name,
            "git": git,
            "session_id": sess,
            "journal_entries": jcount,
            "context_used": used,
            "context_max": mx,
            "context_pct_used": pct_used,
            "model": model,
            "usage": usage,
            "tg": tg,
            "harness_version": harness_ver,
        })

    parts = [f"📍 {name} {git}".strip()]
    if model:
        parts.append(model)
    if not short:
        if sess_short:
            parts.append(f"sess {sess_short} ({jcount}j)")
    parts.append(f"ctx {_fmt_tokens(used)}/{_fmt_tokens(mx)} ({pct_used}%)")
    if usage:
        parts.append(usage)
    if not short:
        parts.append(tg)
        if harness_ver:
            parts.append(harness_ver)
    return " · ".join(parts)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--short", action="store_true")
    p.add_argument("--json", action="store_true")
    args = p.parse_args()
    print(build_footer(short=args.short, as_json=args.json))
    return 0


if __name__ == "__main__":
    sys.exit(main())
