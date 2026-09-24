"""`gh_projects.py add` must take a body from a FILE, in one call.

Why this exists: a card body is full of backticks and `$`, so the safe way to
pass one is a file — which `edit` already supported and `add` did not. The
workaround was add-then-edit, and that loses a race: GitHub's Projects list
reads are eventually consistent, so an `edit` fired immediately after an
`add` can fail to see the new item.

Stubs add_draft/load_cfg; never touches the network or a live board.
"""
from __future__ import annotations

import pytest

import gh_projects as g

BODY = (
    "Body with `backticks`, $DOLLARS, $(command substitution) and \"quotes\".\n"
    "Second line - a file:line reference at foo.ts:42.\n"
)


@pytest.fixture
def stubbed(monkeypatch, tmp_path):
    captured: dict[str, str] = {}
    monkeypatch.setattr(g, "load_cfg", lambda *a, **k: {"project_id": "P_fake"})

    def _fake_add(cfg, title, body=""):
        captured["title"], captured["body"] = title, body
        return "PVTI_fake"

    monkeypatch.setattr(g, "add_draft", _fake_add)
    return captured


def test_body_file_reads_the_file_verbatim(stubbed, tmp_path):
    card = tmp_path / "card.md"
    card.write_text(BODY, encoding="utf-8")
    rc = g.main(["gh", "add", "My Title", "--body-file", str(card)])
    assert rc == 0
    assert stubbed["body"] == BODY


def test_legacy_positional_body_still_works(stubbed):
    rc = g.main(["gh", "add", "T2", "plain body"])
    assert rc == 0
    assert stubbed["body"] == "plain body"


def test_no_body_is_a_valid_empty_card(stubbed):
    rc = g.main(["gh", "add", "T3"])
    assert rc == 0
    assert stubbed["body"] == ""


def test_body_file_with_no_path_is_an_error_and_creates_nothing(stubbed):
    rc = g.main(["gh", "add", "T4", "--body-file"])
    assert rc == 2
    assert not stubbed
