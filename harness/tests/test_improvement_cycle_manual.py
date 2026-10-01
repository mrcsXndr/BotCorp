"""(v0.9.11) The improvement cycle is manual: the doc claims no scheduled job, and none exists.

docs/improvement-cycle.md used to describe a weekly suggest tick, a daily
review tick and a Sunday digest tick that nothing in the daemon ever ran.
"""
from __future__ import annotations

import re
from pathlib import Path

ASSEMBLY = Path(__file__).resolve().parents[2]


def test_the_doc_claims_no_scheduled_step():
    doc = (ASSEMBLY / "docs" / "improvement-cycle.md").read_text(encoding="utf-8")
    assert "manual and on demand" in doc.lower()
    assert not re.search(r"\b(tick|sunday|daily|weekly digest)\b", doc, re.I), "a scheduled step is claimed"


def test_no_daemon_job_reads_the_suggest_block():
    # botyaml.mjs only holds the defaults; nothing schedules a suggest/review/digest run
    hits = [str(p.relative_to(ASSEMBLY)) for p in (ASSEMBLY / "daemon").glob("*.*")
            if p.suffix in (".ps1", ".mjs") and p.name != "botyaml.mjs"
            and re.search(r"suggest\.(weekly|max_prs_per_week|digest_bot)|\.suggest\b", p.read_text(encoding="utf-8", errors="replace"))]
    assert hits == []
