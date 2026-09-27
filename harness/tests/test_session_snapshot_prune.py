"""v0.7.3: the janitor prunes session snapshots older than 7 days.

session_summarize.py writes memory/sessions/<YYYY-MM-DD_HHMMSS>.md on every
Stop / PreCompact (hundreds a week) and nothing reads the old ones. The
janitor's -Clean pass (resource_monitor.ps1) now deletes those older than 7
days, aged by the stamp in the file name. It never touches a session folder
(journal + timeline) or any other file there.

The function is lifted out of the SHIPPED script via its own AST (running the
whole monitor with -Clean would reap real processes on this box).
"""
from __future__ import annotations

from test_resource_monitor_bridge import _extract_fn, _ps_str, _run_ps, needs_pwsh


@needs_pwsh
def test_prunes_only_stamped_snapshots_older_than_seven_days(tmp_path):
    d = tmp_path / "sessions"
    (d / "2026-09-01_000000-sid").mkdir(parents=True)
    keep_dir_file = d / "2026-09-01_000000-sid" / "journal.md"
    keep_dir_file.write_text("j", encoding="utf-8")
    old = [d / "2026-09-01_120000.md", d / "2026-09-19_235959.md"]
    fresh = [d / "2026-09-20_000001.md", d / "2026-09-27_080000.md"]
    other = [d / "notes.md", d / "2026-09-01.md", d / "2026-09-01_120000.txt"]
    for f in old + fresh + other:
        f.write_text("x", encoding="utf-8")

    fn = _extract_fn("Remove-OldSessionSnapshots")
    assert fn, "resource_monitor.ps1 no longer defines Remove-OldSessionSnapshots"
    out = _run_ps(f"{fn}\nRemove-OldSessionSnapshots -Dir {_ps_str(str(d))} -Now ([datetime]'2026-09-27T00:00:00')")

    assert out == "2"
    assert not any(f.exists() for f in old)
    assert all(f.exists() for f in fresh + other) and keep_dir_file.exists()


@needs_pwsh
def test_a_missing_sessions_dir_prunes_nothing(tmp_path):
    fn = _extract_fn("Remove-OldSessionSnapshots")
    assert _run_ps(f"{fn}\nRemove-OldSessionSnapshots -Dir {_ps_str(str(tmp_path / 'none'))}") == "0"
