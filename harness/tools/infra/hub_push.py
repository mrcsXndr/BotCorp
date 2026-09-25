#!/usr/bin/env python3
"""hub_push.py — generalised push of this bot's status to ANY hub.

Replaces a one-hardcoded-destination usage-hub tool with a config-driven
push: `integrations.hub.url` in bot.yaml names the endpoint, `HUB_TOKEN` (set
by the daemon from the vault; this tool never reads the vault itself) is the
bearer token. Exactly three payload kinds go out, each <= 4 KB and cleaned to
a documented whitelist of numbers/short enums — see docs/hub-ingest-api.md.
Nothing here ever sends a path, a token, or free text.

bot.yaml is parsed by the ONE yaml parser in this tree (daemon/botyaml.mjs —
PowerShell/Python both shell out to it rather than re-implementing YAML).

Usage
-----
  hub_push.py              # build + POST (self-throttled by integrations.hub.interval_s)
  hub_push.py --dry-run    # build + print every payload, POST nothing

Design: fail-open. A bad hub, a missing bot.yaml, or a network error prints a
diagnostic to stderr and exits 0 — this runs off the automation scheduler and
must never block or fail a tick.
"""
from __future__ import annotations

import csv
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import instance_root, runtime_root, config_home, bot_name, botcorp_root, module_enabled  # noqa: E402

ACTIVITY_LIMIT = 50
MAX_PAYLOAD_BYTES = 4096

BOTS_ITEM_KEYS = {
    "name", "harness_version", "cc_version", "session_id", "model", "ctx_pct",
    "rate_limits", "tg_poller", "last_turn_age_s", "board_ready", "usd_today",
    "alerts_open", "last_update",
}
RATE_LIMIT_KEYS = {"five_h_pct", "seven_d_pct", "resets_at"}
ACTIVITY_ITEM_KEYS = {"ts", "kind", "name", "model", "duration_s", "usd", "outcome"}
USAGE_KEYS = {"usd_today", "usd_7d", "subagent_usd_7d", "windows"}

# A last-resort scan (--dry-run only): the real safety is that every payload
# is BUILT from a whitelist, never sanitised after the fact.
_LEAK_RE = re.compile(r"(token|C:\\\\|/Users/)", re.IGNORECASE)


# ---- bot.yaml (via the one parser: daemon/botyaml.mjs) ---------------------

def _resolve_node() -> str:
    return os.environ.get("BOT_NODE") or "node"


def _load_bot_yaml(bot_home: Path) -> dict:
    yaml_path = bot_home / "bot.yaml"
    if not yaml_path.exists():
        return {}
    script = botcorp_root() / "daemon" / "botyaml.mjs"
    try:
        out = subprocess.run(
            [_resolve_node(), str(script), str(yaml_path)],
            capture_output=True, text=True, timeout=15, check=False,
        )
        if out.returncode != 0:
            print(f"[hub_push] bot.yaml unreadable: {out.stderr.strip()}", file=sys.stderr)
            return {}
        return json.loads(out.stdout)
    except Exception as e:
        print(f"[hub_push] bot.yaml read failed: {e!r}", file=sys.stderr)
        return {}


# ---- source readers ----------------------------------------------------------

def _box_name() -> str:
    return os.environ.get("COMPUTERNAME") or socket.gethostname()


def _status_snapshot() -> dict:
    path = config_home() / "botcorp" / "status.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _bot_state() -> dict:
    path = runtime_root() / "state" / f"{bot_name()}.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _sessions_rows() -> list[dict]:
    path = instance_root() / "memory" / "metrics" / "sessions.csv"
    if not path.exists():
        return []
    try:
        with path.open(newline="", encoding="utf-8") as fh:
            return list(csv.DictReader(fh))
    except Exception:
        return []


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out: list[dict] = []
    try:
        with path.open(encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except Exception:
                    continue
    except Exception:
        pass
    return out


def _iso_to_epoch(s: str) -> float:
    if not s:
        return 0.0
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def _today_str() -> str:
    return date.today().isoformat()


def _sum_usd_today(sessions: list[dict], today: str | None = None) -> float:
    today = today or _today_str()
    total = 0.0
    for row in sessions:
        ts = row.get("ts_end") or row.get("ts_start") or ""
        if str(ts).startswith(today):
            try:
                total += float(row.get("usd_est") or 0)
            except Exception:
                pass
    return total


def _subagent_usd_7d() -> float:
    path = instance_root() / "memory" / "metrics" / "subagents.csv"
    if not path.exists():
        return 0.0
    cutoff = date.today() - timedelta(days=7)
    total = 0.0
    try:
        with path.open(newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                try:
                    d = date.fromisoformat((row.get("date") or "")[:10])
                except Exception:
                    continue
                if d < cutoff:
                    continue
                if (row.get("agent_type") or "main") == "main":
                    continue
                try:
                    total += float(row.get("usd") or 0)
                except Exception:
                    pass
    except Exception:
        pass
    return total


def _count_alerts_open() -> int:
    """Best-effort: alert lines from alerts.log in the last 24h. Not a true
    open/resolved count (the log has no resolution marker) — a size proxy
    for "how much is currently noisy", documented as such in observability.md."""
    path = instance_root() / "memory" / "metrics" / "alerts.log"
    if not path.exists():
        return 0
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    n = 0
    try:
        with path.open(encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                ts_str = line.split(" ", 1)[0]
                try:
                    ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                    if ts.tzinfo is None:
                        ts = ts.replace(tzinfo=timezone.utc)
                except Exception:
                    n += 1
                    continue
                if ts >= cutoff:
                    n += 1
    except Exception:
        return 0
    return n


# ---- whitelist cleaners -------------------------------------------------------

def _clean_bots_item(item: dict) -> dict:
    out = {k: v for k, v in item.items() if k in BOTS_ITEM_KEYS}
    if isinstance(out.get("rate_limits"), dict):
        out["rate_limits"] = {k: v for k, v in out["rate_limits"].items() if k in RATE_LIMIT_KEYS}
    return out


def _clean_activity_item(item: dict) -> dict:
    return {k: v for k, v in item.items() if k in ACTIVITY_ITEM_KEYS}


_ENVELOPE_KEYS = {"kind", "ts", "box"}


def _clean_usage(payload: dict) -> dict:
    out = {k: v for k, v in payload.items() if k in USAGE_KEYS or k in _ENVELOPE_KEYS}
    if isinstance(out.get("windows"), dict):
        out["windows"] = {k: v for k, v in out["windows"].items() if k in RATE_LIMIT_KEYS}
    return out


def _fit_kb(payload: dict, list_key: str, limit_bytes: int = MAX_PAYLOAD_BYTES) -> dict:
    while payload.get(list_key) and len(json.dumps(payload)) > limit_bytes:
        payload[list_key] = payload[list_key][:-1]
    return payload


# ---- payload builders ----------------------------------------------------------

def build_bots_payload() -> dict:
    status = _status_snapshot()
    state = _bot_state()
    sessions = _sessions_rows()
    bot_home = instance_root()
    cfg = _load_bot_yaml(bot_home)

    model = status.get("model")
    if isinstance(model, dict):
        model = model.get("display_name") or model.get("id") or ""

    ctx = status.get("context_window") or {}
    ctx_pct = ctx.get("remaining_percentage")

    rl = status.get("rate_limits") or {}
    five = rl.get("five_hour") or {}
    seven = rl.get("seven_day") or {}
    resets_at = five.get("resets_at") or seven.get("resets_at")

    last_update = status.get("ts")
    last_turn_age_s = None
    if isinstance(last_update, (int, float)):
        last_turn_age_s = max(0, int(time.time() - last_update))

    board_ready = bool(((cfg.get("harness") or {}).get("modules") or {}).get("board"))

    item = {
        "name": bot_name(),
        "harness_version": status.get("harness_version") or "",
        "cc_version": status.get("version") or "",
        "session_id": status.get("session_id") or "",
        "model": model or "",
        "ctx_pct": round(ctx_pct) if isinstance(ctx_pct, (int, float)) else None,
        "rate_limits": {
            "five_h_pct": five.get("used_percentage"),
            "seven_d_pct": seven.get("used_percentage"),
            "resets_at": resets_at,
        },
        "tg_poller": str(state.get("poller") or "unknown").lower(),
        "last_turn_age_s": last_turn_age_s,
        "board_ready": board_ready,
        "usd_today": round(_sum_usd_today(sessions), 4),
        "alerts_open": _count_alerts_open(),
        "last_update": last_update,
    }
    payload = {"kind": "bots", "ts": time.time(), "box": _box_name(), "bots": [_clean_bots_item(item)]}
    return payload


def build_activity_payload() -> dict:
    bot = bot_name()
    state_dir = runtime_root() / "state" / bot
    items: list[dict] = []

    for r in _read_jsonl(state_dir / "subagents.jsonl"):
        if r.get("event") != "stop":
            continue
        exit_code = r.get("exit_code")
        outcome = "ok" if exit_code in (0, "0", None) else "error"
        items.append({
            "ts": _iso_to_epoch(r.get("ts", "")),
            "kind": "subagent",
            "name": str(r.get("agent_type") or "")[:40],
            "model": "",
            "duration_s": None,
            "usd": None,
            "outcome": outcome,
        })

    for r in _read_jsonl(state_dir / "runs.jsonl"):
        if str(r.get("result") or "").startswith("skipped"):
            continue  # a skipped prompt fire ran nothing (daemon/automations.ps1)
        items.append({
            "ts": _iso_to_epoch(r.get("end") or r.get("start") or ""),
            "kind": "automation",
            "name": str(r.get("automation") or "")[:40],
            "model": "",
            "duration_s": r.get("duration_s"),
            "usd": None,
            "outcome": "ok" if r.get("exit") == 0 else "error",
        })

    for row in _sessions_rows():
        start = _iso_to_epoch(row.get("ts_start", ""))
        end = _iso_to_epoch(row.get("ts_end", ""))
        dur = (end - start) if (start and end and end >= start) else None
        try:
            usd = float(row.get("usd_est") or 0) or None
        except Exception:
            usd = None
        items.append({
            "ts": end or start,
            "kind": "session",
            "name": str(row.get("project") or bot)[:40],
            "model": (row.get("model_mix") or "").split("|")[0].split(":")[0][:40],
            "duration_s": dur,
            "usd": usd,
            "outcome": "ok",
        })

    items.sort(key=lambda x: x.get("ts") or 0, reverse=True)
    items = [_clean_activity_item(i) for i in items[:ACTIVITY_LIMIT]]
    payload = {"kind": "activity", "ts": time.time(), "box": _box_name(), "bot": bot, "items": items}
    return _fit_kb(payload, "items")


def build_usage_payload() -> dict:
    sessions = _sessions_rows()
    usd_today = _sum_usd_today(sessions)
    cutoff = time.time() - 7 * 86400
    usd_7d = 0.0
    for row in sessions:
        ts = _iso_to_epoch(row.get("ts_end") or row.get("ts_start") or "")
        if ts >= cutoff:
            try:
                usd_7d += float(row.get("usd_est") or 0)
            except Exception:
                pass

    status = _status_snapshot()
    rl = status.get("rate_limits") or {}
    five = rl.get("five_hour") or {}
    seven = rl.get("seven_day") or {}

    payload = {
        "kind": "usage",
        "ts": time.time(),
        "box": _box_name(),
        "usd_today": round(usd_today, 4),
        "usd_7d": round(usd_7d, 4),
        "subagent_usd_7d": round(_subagent_usd_7d(), 4),
        "windows": {
            "five_h_pct": five.get("used_percentage"),
            "seven_d_pct": seven.get("used_percentage"),
            "resets_at": five.get("resets_at") or seven.get("resets_at"),
        },
    }
    return _clean_usage(payload)


def _scan_for_leaks(payload: dict) -> list[str]:
    hits: list[str] = []

    def walk(v):
        if isinstance(v, dict):
            for k, vv in v.items():
                if _LEAK_RE.search(str(k)):
                    hits.append(str(k))
                walk(vv)
        elif isinstance(v, list):
            for vv in v:
                walk(vv)
        else:
            s = str(v)
            if _LEAK_RE.search(s):
                hits.append(s)

    walk(payload)
    return hits


# ---- throttle + POST -----------------------------------------------------------

def _throttle_path() -> Path:
    return runtime_root() / "state" / bot_name() / "hub_push.json"


def _should_push(interval_s: int) -> bool:
    p = _throttle_path()
    try:
        if p.exists():
            last = json.loads(p.read_text(encoding="utf-8")).get("last_push_ts", 0)
            if time.time() - float(last) < interval_s:
                return False
    except Exception:
        pass
    return True


def _stamp_push() -> None:
    p = _throttle_path()
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".json.tmp")
        tmp.write_text(json.dumps({"last_push_ts": time.time()}), encoding="utf-8")
        os.replace(tmp, p)
    except Exception as e:
        print(f"[hub_push] could not stamp throttle state: {e!r}", file=sys.stderr)


def _post(url: str, token: str, payload: dict) -> dict | None:
    body = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=body, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            try:
                return json.loads(raw) if raw else {}
            except Exception:
                return {}
    except Exception as e:
        print(f"[hub_push] POST failed (fail-open): {e!r}", file=sys.stderr)
        return None


def main(argv: list[str]) -> int:
    try:
        if not module_enabled("hub"):
            print("[hub_push] module 'hub' disabled; skipping", file=sys.stderr)
            return 0

        dry_run = "--dry-run" in argv
        cfg = _load_bot_yaml(instance_root())
        hub_cfg = (cfg.get("integrations") or {}).get("hub") or {}
        url = hub_cfg.get("url")
        interval_s = int(hub_cfg.get("interval_s") or 300)

        if not url:
            print("[hub_push] no integrations.hub.url configured; nothing to push", file=sys.stderr)
            return 0

        if not dry_run and not _should_push(interval_s):
            print(f"[hub_push] throttled (interval_s={interval_s}); skipping", file=sys.stderr)
            return 0

        payloads = [build_bots_payload(), build_activity_payload(), build_usage_payload()]

        if dry_run:
            for p in payloads:
                print(json.dumps(p, indent=2))
                leaks = _scan_for_leaks(p)
                if leaks:
                    print(f"[hub_push] WARNING: possible leak in {p.get('kind')} payload: {leaks}", file=sys.stderr)
                size = len(json.dumps(p))
                if size > MAX_PAYLOAD_BYTES:
                    print(f"[hub_push] WARNING: {p.get('kind')} payload is {size}B (> {MAX_PAYLOAD_BYTES}B cap)", file=sys.stderr)
            return 0

        token = os.environ.get("HUB_TOKEN", "")
        pushed = False
        for p in payloads:
            resp = _post(url, token, p)
            if resp is not None:
                pushed = True
        if pushed:
            _stamp_push()
        return 0
    except Exception as e:  # absolute fail-open guard
        print(f"[hub_push] unexpected error (fail-open): {e!r}", file=sys.stderr)
        return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
