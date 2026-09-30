"""QA pack B 8: the leftovers from pack A.

Locked behaviour:
- `remote_control` is gone from the cockpit's source (cards.ts, settings.ts),
  its built bundle and docs/cockpit.md, like everywhere else since pack A;
"""
from __future__ import annotations

from test_operator_only import ASSEMBLY

WEB = ASSEMBLY / "cockpit" / "web"


def test_remote_control_is_gone_from_the_cockpit_and_its_doc():
    src = [str(p.relative_to(ASSEMBLY)) for p in (WEB / "src").rglob("*")
           if p.is_file() and p.suffix in (".ts", ".tsx") and ".test." not in p.name
           and "remote_control" in p.read_text(encoding="utf-8", errors="replace")]
    dist = [str(p.relative_to(ASSEMBLY)) for p in (WEB / "dist").rglob("*.js")
            if "remote_control" in p.read_text(encoding="utf-8", errors="replace")]
    assert src == [] and dist == [], src + dist
    assert "Remote Control" not in (ASSEMBLY / "docs" / "cockpit.md").read_text(encoding="utf-8")
