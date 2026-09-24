"""Tests for tools/v2/alert_triage.py.

Every filesystem path the module touches is redirected into tmp_path, and the
spawn is injected, so no test can launch a headless claude or write runtime
state into the repo. BOT_TG_MUTE=1 (conftest's autouse fixture) is a floor:
the module never sends Telegram itself, but the HUMAN: path shells out to
tg_send.py.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta

import pytest

import alert_triage as at

# Four log-shaped lines, restructured from real alerts.log examples with every
# identifying token (repo/org/account names, session ids, cloud resource ids)
# replaced by an obviously-fake placeholder of the same shape.
WORKLIST = ("2026-09-18T15:45:24\t🗂️ **status digest** | **Open PRs (7)** — mine to review + merge: | "
            "• #134 fix(example-service): honest extraction stats + version provenance (2 board cards) | "
            "• #131 CI: dev deploys on every main push — merges no longer leave dev behind prod | "
            "**Unresolved failed builds (0)**")
BOX_INFO = ("2026-09-16T17:09:45\tBox health: | - [info] 13 node procs — possible stray vite/dev servers | "
            "📍 my-bot (main*) · Fable5.1 Medium · sess abc12345 (35j) · ctx 302K/500K (60%) · 🟢5h 18% · wk 8% ↻18:00")
SERVICE_WARN = ("2026-09-19T14:29:29\t🚨 *service health* — 1 issue(s), worst *WARN* | *builds* (1): | "
             "• (warn) 3 example-org repo workflow(s) RED right now (latest run on main failed): "
             "aaaa1111:deploy(failure,2026-09-10) bbbb2222:deploy(failure,2026-09-10) "
             "cccc3333:deploy(failure,2026-08-31) [↗](https://github.com/orgs/example-org/repositories) | "
             "📍 my-bot (main*) · Fable5.1 High · sess abc12345 (92j) · ctx 91K/500K (18%) · 🟢5h 0% · wk 40% ↻16:10")
BOX_WARN = ("2026-09-16T17:09:45\tBox health (warn): | - [warn] 10 agent-browser Chrome procs (570 MB) — idle 53.3m "
            "(>= 20m, no ab.sh activity) = abandoned session | - [info] 13 node procs — possible stray vite/dev servers | "
            "📍 my-bot (main*) · Fable5.1 Medium · sess abc12345 (35j) · ctx 302K/500K (60%) · 🟢5h 18% · wk 8% ↻18:00")
BACKUP_FAIL = "2026-09-19T03:30:06.892Z example-backup FAIL wrangler d1 execute exited 1"
BACKUP_CONT = ('"text": "A request to the Cloudflare API (/accounts/00000000000000000000000000000ab/d1/'
               'database/00000000-0000-0000-0000-000000000abc/query) failed.",')

NOW = datetime(2026, 9, 20, 12, 0, 0)


@pytest.fixture
def paths(tmp_path, monkeypatch):
    """Redirect every module path into tmp_path; return the dict of them."""
    p = {
        "ALERTS_LOG": tmp_path / "alerts.log",
        "STATE_FILE": tmp_path / "alerts_triage.json",
        "TRIAGE_LOG": tmp_path / "alerts_triage.log",
        "RUNS_DIR": tmp_path / "triage_runs",
        "LOCK_FILE": tmp_path / ".triage.lock",
        "PROMPT_FILE": tmp_path / ".triage_prompt.txt",
    }
    for k, v in p.items():
        monkeypatch.setattr(at, k, v)
    monkeypatch.delenv("BOT_TRIAGE_COOLDOWN_H", raising=False)
    monkeypatch.delenv("BOT_TRIAGE_MAX_PER_DAY", raising=False)
    return p


class Spawn:
    def __init__(self):
        self.calls = []

    def __call__(self, prompt_file, run_file):
        self.calls.append((prompt_file, run_file))
        return 4242


def write_log(paths, *lines):
    paths["ALERTS_LOG"].write_text("\n".join(lines) + "\n", encoding="utf-8")


def state(paths):
    return json.loads(paths["STATE_FILE"].read_text(encoding="utf-8"))


# ---------------------------------------------------------------- fingerprint

def test_fingerprint_strips_stamps_footer_and_numbers():
    a = ("🚨 *service health* — 1 issue(s) | • (warn) 3 example-org workflow(s) RED: x:deploy(failure,2026-09-10) "
         "| 📍 my-bot (main*) · Fable5.1 High · sess abc12345 (92j) · ctx 91K/500K (18%) ↻16:10")
    b = ("🚨 *service health* — 2 issue(s) | • (warn) 7 example-org workflow(s) RED: x:deploy(failure,2026-08-31) "
         "| 📍 my-bot (main*) · Opus5 High · sess def67890 (490j) · ctx 372K/500K (74%) ↻22:00")
    fa, fb = at.fingerprint(a), at.fingerprint(b)
    assert fa == fb
    assert "📍" not in fa and "2026" not in fa and "abc12345" not in fa
    assert fa == fa.lower() and len(fa) <= 160
    assert fa.startswith("🚨 *service health* — issue(s)")


def test_fingerprint_distinguishes_different_conditions():
    assert at.fingerprint("Box health (warn): | - [warn] 10 agent-browser Chrome procs (570 MB)") != \
        at.fingerprint("Box health (warn): | - [warn] 1 orphaned agent-browser daemon procs")


# ---------------------------------------------------------------- classify

def test_classify_real_lines():
    alerts, orphans = at.parse_alerts("\n".join([WORKLIST, BOX_INFO, SERVICE_WARN, BACKUP_FAIL, BACKUP_CONT]))
    assert orphans == 0
    assert [a.head.split(" ")[0] for a in alerts] == ["🗂️", "Box", "🚨", "example-backup"]
    # noise: the digest even though it literally contains "failed builds"
    assert at.ACTIONABLE_RE.search(alerts[0].text) is not None, "precondition: the digest does match the regex"
    assert at.classify(alerts[0].text) is None
    # noise: box health with only [info]
    assert at.classify(alerts[1].text) is None
    # actionable: service health warn — the MATCHED TEXT, not a count
    m = at.classify(alerts[2].text)
    assert m is not None and m.group(0) == "🚨"
    # actionable: the backup failure, with its continuation attached
    assert alerts[3].raw == [BACKUP_FAIL, BACKUP_CONT]
    m = at.classify(alerts[3].text)
    assert m is not None and m.group(0).lower() == "backup"
    assert at.ACTIONABLE_RE.search("wrangler d1 execute exited 1").group(0) == "exited 1"
    # actionable: box health with a [warn] and no other trigger word at all
    m = at.classify(at.parse_alerts(BOX_WARN)[0][0].text)
    assert m is not None and m.group(0) == "(warn)"


def test_human_line_is_noise_so_the_tick_never_retriggers_itself():
    assert at.classify("HUMAN: example backup FAILED twice, token revoked, needs a re-login tonight") is None


def test_orphan_continuation_is_dropped_not_crashed():
    alerts, orphans = at.parse_alerts(BACKUP_CONT + "\n" + BACKUP_FAIL + "\n")
    assert orphans == 1 and len(alerts) == 1 and alerts[0].raw == [BACKUP_FAIL]


# ---------------------------------------------------------------- scan

def test_scan_launches_stamps_and_locks(paths):
    write_log(paths, WORKLIST, SERVICE_WARN, BACKUP_FAIL, BACKUP_CONT)
    sp = Spawn()
    s = at.scan(now=NOW, spawn=sp)
    assert s["launched"] and s["batch"] == 2 and s["noise"] == 1 and len(sp.calls) == 1
    st = state(paths)
    assert st["offset"] == paths["ALERTS_LOG"].stat().st_size
    fps = st["fingerprints"]
    assert len(fps) == 2 and all(e["triaged_at"] == NOW.isoformat(timespec="seconds") for e in fps.values())
    assert st["runs"] == [NOW.isoformat(timespec="seconds")]
    assert paths["LOCK_FILE"].read_text().split()[0] == "4242"
    prompt = paths["PROMPT_FILE"].read_text(encoding="utf-8")
    assert BACKUP_FAIL in prompt and BACKUP_CONT in prompt and "NO_REPLY" in prompt
    assert "2 new alert(s)" in prompt
    assert "\tLAUNCH\t" in paths["TRIAGE_LOG"].read_text(encoding="utf-8")


def test_cooldown_skips_repeat(paths):
    write_log(paths, SERVICE_WARN)
    sp = Spawn()
    at.scan(now=NOW, spawn=sp)
    paths["LOCK_FILE"].unlink()
    # same condition an hour later, different counters/footer
    later = SERVICE_WARN.replace("2026-09-19T14:29:29", "2026-09-20T13:00:00").replace("ctx 91K", "ctx 140K")
    write_log(paths, SERVICE_WARN, later)
    s = at.scan(now=NOW + timedelta(hours=1), spawn=sp)
    assert s["repeats"] == 1 and s["batch"] == 0 and not s["launched"] and len(sp.calls) == 1
    fp = at.fingerprint(SERVICE_WARN.split("\t", 1)[1])
    assert state(paths)["fingerprints"][fp]["count"] == 2
    # ...and past the cooldown it is triaged again
    write_log(paths, SERVICE_WARN, later, later.replace("T13:00:00", "T14:00:00"))
    s = at.scan(now=NOW + timedelta(hours=25), spawn=sp)
    assert s["launched"] and len(sp.calls) == 2


def test_cursor_resets_when_log_is_truncated(paths):
    write_log(paths, SERVICE_WARN)
    paths["STATE_FILE"].write_text(json.dumps({"offset": 99999, "fingerprints": {}, "runs": []}))
    sp = Spawn()
    s = at.scan(now=NOW, spawn=sp)
    assert s["alerts"] == 1 and s["launched"]
    assert state(paths)["offset"] == paths["ALERTS_LOG"].stat().st_size


def test_cursor_only_reads_new_lines_and_keeps_partial_tail(paths):
    write_log(paths, WORKLIST)
    sp = Spawn()
    at.scan(now=NOW, spawn=sp)
    assert not sp.calls
    off = state(paths)["offset"]
    with paths["ALERTS_LOG"].open("a", encoding="utf-8") as fh:
        fh.write(SERVICE_WARN + "\n" + "2026-09-20T03:30:00 half-written line without newline")
    s = at.scan(now=NOW, spawn=sp)
    assert s["alerts"] == 1 and s["launched"]
    data = paths["ALERTS_LOG"].read_bytes()
    assert off < state(paths)["offset"] == data.rfind(b"\n") + 1 < len(data)


def test_dry_run_writes_nothing(paths, capsys):
    write_log(paths, SERVICE_WARN, BACKUP_FAIL, BACKUP_CONT)
    sp = Spawn()
    s = at.scan(now=NOW, dry_run=True, spawn=sp)
    assert s["batch"] == 2 and not sp.calls
    for k in ("STATE_FILE", "LOCK_FILE", "PROMPT_FILE", "TRIAGE_LOG"):
        assert not paths[k].exists(), k
    out = capsys.readouterr().out
    assert "2 would be batched" in out and BACKUP_CONT in out


def test_in_flight_lock_defers_without_advancing_cursor(paths):
    write_log(paths, SERVICE_WARN)
    paths["LOCK_FILE"].write_text(f"1 {(NOW - timedelta(minutes=5)).isoformat()}\n")
    sp = Spawn()
    s = at.scan(now=NOW, spawn=sp)
    assert s.get("deferred") == "in-flight" and not sp.calls and not paths["STATE_FILE"].exists()
    # a stale lock (>30 min) does not block
    paths["LOCK_FILE"].write_text(f"1 {(NOW - timedelta(minutes=31)).isoformat()}\n")
    s = at.scan(now=NOW, spawn=sp)
    assert s["launched"] and len(sp.calls) == 1


def test_day_cap_defers(paths, monkeypatch):
    monkeypatch.setenv("BOT_TRIAGE_MAX_PER_DAY", "1")
    write_log(paths, SERVICE_WARN)
    sp = Spawn()
    assert at.scan(now=NOW, spawn=sp)["launched"]
    paths["LOCK_FILE"].unlink()
    write_log(paths, SERVICE_WARN, BACKUP_FAIL)
    s = at.scan(now=NOW + timedelta(hours=1), spawn=sp)
    assert s.get("deferred") == "day-cap" and len(sp.calls) == 1
    # next day the cap resets
    s = at.scan(now=NOW + timedelta(days=1), spawn=sp)
    assert s["launched"] and len(sp.calls) == 2


def test_busy_session_waives_idle_gate_only_when_oldest_alert_is_stale(paths, monkeypatch):
    monkeypatch.delenv("BOT_TRIAGE_MAX_WAIT_H", raising=False)   # default 6h
    fresh = SERVICE_WARN.replace("2026-09-19T14:29:29", (NOW - timedelta(hours=1)).isoformat(timespec="seconds"))
    stale = BOX_WARN.replace("2026-09-16T17:09:45", (NOW - timedelta(hours=7)).isoformat(timespec="seconds"))
    sp = Spawn()
    # oldest alert 1h < 6h: busy session wins, nothing written
    write_log(paths, fresh)
    s = at.scan(now=NOW, spawn=sp, session_busy=True)
    assert s.get("deferred") == "session-busy" and not sp.calls and not paths["STATE_FILE"].exists()
    # oldest alert 7h >= 6h: waived, launched, run told about the live session
    write_log(paths, fresh, stale)
    s = at.scan(now=NOW, spawn=sp, session_busy=True)
    assert s["launched"] and s["waived"] and len(sp.calls) == 1
    log = paths["TRIAGE_LOG"].read_text(encoding="utf-8")
    assert "idle gate waived: oldest alert 7.0h >= 6h" in log
    prompt = paths["PROMPT_FILE"].read_text(encoding="utf-8")
    assert "live Director session" in prompt and "memory/metrics/" in prompt
    # an idle session never carries the note
    paths["LOCK_FILE"].unlink()
    write_log(paths, fresh, stale, BACKUP_FAIL)
    s = at.scan(now=NOW, spawn=sp, session_busy=False)
    assert s["launched"] and not s["waived"]
    assert "live Director session" not in paths["PROMPT_FILE"].read_text(encoding="utf-8")


def test_alert_age_handles_local_and_utc_stamps():
    assert at.alert_age("2026-09-20T05:00:00", NOW) == timedelta(hours=7)
    utc = at.alert_age("2026-09-20T03:30:06.892Z", NOW)
    assert timedelta(hours=1) < utc < timedelta(hours=24)   # tz-converted, not 0 and not garbage
    assert at.alert_age("not a stamp", NOW) == timedelta(0)


def test_seed_moves_cursor_to_eof(paths):
    write_log(paths, SERVICE_WARN, BACKUP_FAIL)
    at.seed(now=NOW)
    sp = Spawn()
    s = at.scan(now=NOW, spawn=sp)
    assert s["alerts"] == 0 and not sp.calls


def test_main_is_fail_open(paths, monkeypatch):
    monkeypatch.setattr(at, "scan", lambda **kw: (_ for _ in ()).throw(RuntimeError("boom")))
    assert at.main(["scan"]) == 0
    assert at.main(["--dry-run"]) == 0   # bare flags default to `scan`
