"""R18: doctor's memory health rows (cli/_lib.mjs memoryHealthRows).

Locked behaviour, per bot:
- `session-start context`: WARN when the newest SessionStart additionalContext
  row of the session's transcript was persisted ("Output too large", Claude
  Code injected a 2 KB preview) or is over the 9,500-char budget; a later
  UserPromptSubmit row does not count;
- `session timeline`: WARN when more than 2 newest timelines in a row are
  `phase: 1-structural`;
- `claude.md imports approved`: WARN unless the config home's .claude.json
  record of the bot folder has hasClaudeMdExternalIncludesApproved: true;
- `session context window`: WARN when the window the session's SessionStart
  env recorded (session-env.json) differs from bot.yaml, a PCT override below
  100 included.
The fixtures copy the real row shapes (transcript attachment rows, timeline
front matter, session-env records).
"""
from __future__ import annotations

import json
import re
import subprocess

from test_operator_only import ASSEMBLY, box, cli, needs_node  # noqa: F401

LIB = (ASSEMBLY / "cli" / "_lib.mjs").as_uri()
RESOLVED = {"tokens": 500000, "source": "50% of 1000000 (claude-opus-5-5)", "error": ""}


def _ctx_row(ts: str, event: str, content: str) -> str:
    return json.dumps({"parentUuid": None, "type": "attachment", "timestamp": ts, "attachment": {
        "type": "hook_additional_context", "content": [content], "hookName": f"{event}:startup",
        "toolUseID": "t1", "hookEvent": event}})


def _persisted(size: str) -> str:
    return (f"<persisted-output>\nOutput too large ({size}). Full output saved to: C:\\x\\tool-results\\a.txt\n\n"
            "Preview (first 2KB):\n## Journal")


def _fixture(tmp_path, *, start: str, phases: list[str], approved: bool, sid: str = "sess-1"):
    home, config = tmp_path / "bots" / "t", tmp_path / "bots" / "t" / ".claude-t"
    tdir = config / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(home))
    tdir.mkdir(parents=True)
    (tdir / f"{sid}.jsonl").write_text("\n".join([
        '{"type":"user","message":{"role":"user","content":"hi"}}',
        _ctx_row("2026-09-29T18:00:00.000Z", "SessionStart", "## small, older"),
        _ctx_row("2026-09-29T20:12:36.771Z", "SessionStart", start),
        _ctx_row("2026-09-29T20:40:27.283Z", "UserPromptSubmit", "Reply path: tg_send.py"),
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}',
    ]) + "\n", encoding="utf-8")
    for i, phase in enumerate(phases):  # phases[0] is the newest
        d = home / "memory" / "sessions" / f"s{i}"
        d.mkdir(parents=True)
        (d / "timeline.md").write_text(
            f"---\nsession_id: s{i}\nbuilt_at: 2026-09-{29 - i:02d}T20:11:50Z\nchannel: critic-timeline\nphase: {phase}\n---\n# t\n",
            encoding="utf-8")
    (home / "memory" / "sessions" / "unknown-archived").mkdir(parents=True)  # no timeline.md: skipped
    key = str(home).replace("\\", "/")
    rec = {"hasTrustDialogAccepted": True, **({"hasClaudeMdExternalIncludesApproved": True} if approved else {})}
    (config / ".claude.json").write_text(json.dumps({"projects": {key: rec}}), encoding="utf-8")
    return home, config


def _rows(home, config, **kw) -> dict:
    args = {"home": str(home), "config": str(config), **kw}
    script = ("const m = await import(process.argv[1]);"
              "console.log(JSON.stringify(m.memoryHealthRows(JSON.parse(process.argv[2]))));")
    r = subprocess.run(["node", "--input-type=module", "-e", script, LIB, json.dumps(args)],
                       capture_output=True, text=True, timeout=60, cwd=str(ASSEMBLY))
    assert r.returncode == 0, r.stderr
    return {row["name"]: row for row in json.loads(r.stdout)}


@needs_node
def test_every_memory_row_warns_on_the_broken_state(tmp_path):
    """The state the parity review found: a 47.7 KB persisted start, raw
    timelines, no include approval, a worker on 1M x 50%."""
    home, config = _fixture(tmp_path, start=_persisted("47.7KB"),
                            phases=["1-structural", "1-structural", "1-structural", "2-distilled"], approved=False)
    rows = _rows(home, config, sessionId="sess-1", resolved=RESOLVED, running=True,
                 rec={"session_id": "sess-1", "auto_compact_window": "1000000", "autocompact_pct": "50"})
    assert rows["session-start context"]["level"] == "WARN" and "47.7KB" in rows["session-start context"]["detail"]
    assert rows["session timeline"]["level"] == "WARN" and "newest 3" in rows["session timeline"]["detail"]
    assert rows["claude.md imports approved"]["level"] == "WARN"
    w = rows["session context window"]
    assert w["level"] == "WARN" and "=1000000" in w["detail"] and "PCT_OVERRIDE=50" in w["detail"] and "500000" in w["detail"]


@needs_node
def test_every_memory_row_passes_on_the_healthy_state(tmp_path):
    home, config = _fixture(tmp_path, start="## TDL Open\n" + "x" * 9000,
                            phases=["1-structural", "1-structural", "2-distilled"], approved=True)
    rows = _rows(home, config, sessionId="sess-1", resolved=RESOLVED, running=True,
                 rec={"session_id": "sess-1", "auto_compact_window": "500000", "autocompact_pct": "100"})
    assert {n: r["level"] for n, r in rows.items()} == {
        "session-start context": "PASS", "session timeline": "PASS",
        "claude.md imports approved": "PASS", "session context window": "PASS"}, rows
    assert "9012 chars" in rows["session-start context"]["detail"]


@needs_node
def test_an_unpersisted_start_over_the_budget_warns(tmp_path):
    home, config = _fixture(tmp_path, start="y" * 9600, phases=[], approved=True)
    rows = _rows(home, config)
    assert rows["session-start context"]["level"] == "WARN" and "9600 chars" in rows["session-start context"]["detail"]
    assert rows["session timeline"]["level"] == "INFO"
    assert rows["session context window"]["level"] == "INFO"  # no resolved window passed


@needs_node
def test_the_session_transcript_wins_over_a_newer_one(tmp_path):
    home, config = _fixture(tmp_path, start=_persisted("20KB"), phases=[], approved=True)
    tdir = next((config / "projects").iterdir())
    (tdir / "headless.jsonl").write_text(_ctx_row("2026-09-30T01:00:00.000Z", "SessionStart", "tiny") + "\n", encoding="utf-8")
    assert _rows(home, config, sessionId="sess-1")["session-start context"]["level"] == "WARN"
    assert _rows(home, config, sessionId="gone")["session-start context"]["level"] == "PASS"  # falls back to the newest file


@needs_node
def test_window_verdict_edges(tmp_path):
    home, config = _fixture(tmp_path, start="ok", phases=[], approved=True)
    def w(**kw):
        return _rows(home, config, **kw)["session context window"]
    assert w(resolved=RESOLVED, running=False)["level"] == "INFO"
    assert w(resolved=RESOLVED, running=True, rec={"session_id": "s"})["level"] == "INFO"  # a record from an older hook
    assert w(resolved=RESOLVED, running=True, rec={"auto_compact_window": None, "autocompact_pct": None})["level"] == "WARN"
    assert w(resolved=RESOLVED, running=True, rec={"auto_compact_window": "500000", "autocompact_pct": "50"})["level"] == "WARN"
    assert w(resolved={"tokens": None, "source": "auto", "error": ""}, running=True, rec={})["level"] == "INFO"


@needs_node
def test_doctor_shows_the_memory_rows(box):
    rt, bots, env = box
    home = bots / "t"
    config = home / ".claude-t"
    tdir = config / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(home))
    tdir.mkdir(parents=True)
    (tdir / "s.jsonl").write_text(_ctx_row("2026-09-29T20:12:36.771Z", "SessionStart", _persisted("11.3KB")) + "\n", encoding="utf-8")
    for i in range(3):
        d = home / "memory" / "sessions" / f"s{i}"
        d.mkdir(parents=True)
        (d / "timeline.md").write_text(f"---\nbuilt_at: 2026-09-2{i}T00:00:00Z\nphase: 1-structural\n---\n", encoding="utf-8")
    r = cli(env, "doctor", "--no-tg-probe", "--no-accounts", "--json", timeout=300)
    rows = {c["name"]: c for c in json.loads(r.stdout)}
    assert rows["t: session-start context"]["level"] == "WARN"
    assert rows["t: session timeline"]["level"] == "WARN"
    assert rows["t: claude.md imports approved"]["level"] == "WARN" and "botcorp sync t" in rows["t: claude.md imports approved"]["detail"]
    assert rows["t: session context window"]["level"] == "INFO"  # not running


@needs_node
def test_curated_memory_mirror_warns_only_beside_an_auto_index(tmp_path):
    home, config = _fixture(tmp_path, start="ok", phases=[], approved=True)
    mem = home / "memory"
    (mem / "MEMORY.md").write_text("\n".join(f"- note {i}" for i in range(40)) + "\n", encoding="utf-8")
    assert "curated memory mirror" not in _rows(home, config)          # no auto index yet
    (mem / "auto").mkdir()
    (mem / "auto" / "MEMORY.md").write_text("# Memory Index\n", encoding="utf-8")
    row = _rows(home, config)["curated memory mirror"]
    assert row["level"] == "WARN" and "never loaded" in row["detail"]
    (mem / "MEMORY.md").write_text("# pointer\n", encoding="utf-8")    # a stub is fine
    assert "curated memory mirror" not in _rows(home, config)
