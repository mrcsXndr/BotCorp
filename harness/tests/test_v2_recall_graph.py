"""Tests for the memory-graph half of recall.py.

Everything runs against a TEMP memory dir + TEMP db (see the `graph` fixture)
— the real memory/index/recall.db is never touched. Ordering matters: the
positive controls come first, so a later "no links found" / "no rows found"
assertion can't quietly be passing because the parser or the indexer never
ran at all.
"""
from __future__ import annotations

import json
import os
import sqlite3

import pytest

import recall


def mem(name: str, description: str, body: str, extra_fm: str = "") -> str:
    return (
        "---\n"
        f"name: {name}\n"
        f"description: {description}\n"
        "metadata:\n"
        "  node_type: memory\n"
        "  type: feedback\n"
        f"{extra_fm}"
        "---\n\n"
        f"{body}\n"
    )


# ---------------------------------------------------------------------------
# _parse_memory
# ---------------------------------------------------------------------------

def test_positive_control_finds_dedupes_and_sorts_links():
    node = recall._parse_memory(
        mem("alpha", "the alpha fact", "Body links [[beta]] and [[gamma-two]].\nAlso [[beta]] again."),
        "fallback",
    )
    assert node["links"] == ["beta", "gamma-two"]
    assert node["name"] == "alpha"
    assert node["description"] == "the alpha fact"
    assert node["entry"]["kind"] == "memory"
    assert node["entry"]["seq"] == 0
    assert "the alpha fact" in node["entry"]["text"]
    assert "[alpha]" in node["entry"]["text"]
    assert "\n" not in node["entry"]["text"]


def test_body_with_no_links_yields_no_edges():
    no_links = recall._parse_memory(mem("solo", "no edges here", "Plain body, no links."), "fb")
    assert no_links["links"] == []


def test_self_link_is_not_an_edge():
    self_link = recall._parse_memory(mem("selfy", "d", "Points at [[selfy]] and [[other]]."), "fb")
    assert self_link["links"] == ["other"]


def test_edges_come_from_body_not_front_matter():
    fm_only = recall._parse_memory(
        "---\nname: fmnode\ndescription: has [[ghost]] in the description\n---\n\nBody with [[real]].\n",
        "fb",
    )
    assert fm_only["links"] == ["real"]


def test_inline_code_span_is_not_an_edge():
    spans = recall._parse_memory(
        mem("spanner", "d", "Never write `[[memory-slug]]` here.\nBut [[real-one]] is an edge."), "fb"
    )
    assert spans["links"] == ["real-one"]


def test_fenced_block_is_not_an_edge():
    fenced = recall._parse_memory(
        mem("fencer", "d", "```\nRelated: [[in-a-fence]]\n```\nBut [[outside]] counts."), "fb"
    )
    assert fenced["links"] == ["outside"]


def test_double_backtick_span_is_not_an_edge():
    d = recall._parse_memory(mem("dbl", "d", "``[[double-tick]]`` and [[plain]]."), "fb")
    assert d["links"] == ["plain"]


def test_missing_front_matter_falls_back_to_filename_stem():
    bare = recall._parse_memory("Just a body, no front-matter at all. [[x]]\n", "fallback-slug")
    assert bare["name"] == "fallback-slug"
    assert bare["links"] == ["x"]


def test_modified_and_origin_session_id_map_to_entry_fields():
    with_ts = recall._parse_memory(
        mem("tsn", "d", "b", extra_fm="  modified: 2026-08-21T17:50:00.033Z\n  originSessionId: sess-99\n"),
        "fb",
    )
    assert with_ts["entry"]["ts"] == "2026-08-21T17:50:00.033Z"
    assert with_ts["entry"]["session_id"] == "sess-99"


def test_no_origin_session_id_defaults_to_memory():
    no_origin = recall._parse_memory(mem("noorig", "d", "b"), "fb")
    assert no_origin["entry"]["session_id"] == "memory"


# ---------------------------------------------------------------------------
# End-to-end index against a temp memory dir
# ---------------------------------------------------------------------------

@pytest.fixture
def graph(tmp_path, monkeypatch):
    mem_dir = tmp_path / "memory"
    mem_dir.mkdir()
    idx_dir = tmp_path / "index"

    (mem_dir / "hub.md").write_text(
        mem("hub", "the hub fact", "Links [[leaf-a]], [[leaf-b]] and [[never-written]]."), encoding="utf-8"
    )
    (mem_dir / "leaf-a.md").write_text(mem("leaf-a", "leaf a fact", "Back to [[hub]]."), encoding="utf-8")
    (mem_dir / "leaf-b.md").write_text(mem("leaf-b", "leaf b fact", "No links."), encoding="utf-8")
    (mem_dir / "MEMORY.md").write_text("# Memory Index\n- [Hub](hub.md) — pointer only\n", encoding="utf-8")

    monkeypatch.setattr(recall, "MEMORY_DIR", mem_dir)
    monkeypatch.setattr(recall, "INDEX_DIR", idx_dir)
    monkeypatch.setattr(recall, "DB_PATH", idx_dir / "recall.db")
    monkeypatch.setattr(recall, "SESSIONS_DIR", tmp_path / "no-sessions")
    monkeypatch.setattr(recall, "TIMELINES_DIR", tmp_path / "no-timelines")
    monkeypatch.setattr(recall, "LONGTERM_DIR", tmp_path / "no-longterm")
    return {"mem_dir": mem_dir}


def test_index_returns_0_and_indexes_three_nodes_skipping_memory_md(graph):
    assert recall.cmd_index() == 0
    con = recall._connect()
    names = {r[0] for r in con.execute("SELECT name FROM memory_files")}
    assert names == {"hub", "leaf-a", "leaf-b"}


def test_edges_include_the_dangling_one(graph):
    recall.cmd_index()
    con = recall._connect()
    edges = {(r[0], r[1]) for r in con.execute("SELECT src, dst FROM memory_links")}
    assert edges == {("hub", "leaf-a"), ("hub", "leaf-b"), ("hub", "never-written"), ("leaf-a", "hub")}


def test_hub_neighbours_and_dangling_reporting(graph):
    recall.cmd_index()
    con = recall._connect()
    hub_path = str(graph["mem_dir"] / "hub.md")
    nbs = recall._neighbours(con, hub_path)
    by_name = {n["name"]: n for n in nbs}
    assert set(by_name) == {"leaf-a", "leaf-b", "never-written"}
    assert by_name["leaf-a"]["direction"] == "out"
    assert by_name["leaf-a"]["description"] == "leaf a fact"
    assert by_name["never-written"]["exists"] is False
    assert by_name["never-written"]["description"] is None


def test_leaf_b_sees_hub_via_in_edge_only(graph):
    recall.cmd_index()
    con = recall._connect()
    leaf_b_nbs = recall._neighbours(con, str(graph["mem_dir"] / "leaf-b.md"))
    assert [n["name"] for n in leaf_b_nbs] == ["hub"]
    assert leaf_b_nbs[0]["direction"] == "in"


def test_neighbour_cap_and_unknown_path(graph):
    recall.cmd_index()
    con = recall._connect()
    hub_path = str(graph["mem_dir"] / "hub.md")
    assert len(recall._neighbours(con, hub_path, cap=2)) == 2
    assert recall._neighbours(con, str(graph["mem_dir"] / "nope.md")) == []


def test_search_finds_fixture_memories_by_body_text(graph):
    recall.cmd_index()
    con = recall._connect()
    con.row_factory = sqlite3.Row
    rows = recall._run_search_query(con, "dangling OR leaf", 10, 0.0)
    assert len(rows) > 0


def test_renaming_the_name_field_replaces_the_node_with_no_ghost(graph):
    recall.cmd_index()
    leaf_b = graph["mem_dir"] / "leaf-b.md"
    before = leaf_b.stat().st_mtime_ns
    leaf_b.write_text(mem("leaf-b-renamed", "leaf b fact", "No links."), encoding="utf-8")
    # the rewrite lands in the same timestamp tick as the first write (what a
    # fast rewrite does on a coarse filesystem clock, forced here every run)
    os.utime(leaf_b, ns=(before, before))
    recall.cmd_index()
    con = recall._connect()
    names = {r[0] for r in con.execute("SELECT name FROM memory_files")}
    assert "leaf-b" not in names
    assert "leaf-b-renamed" in names


def test_a_file_untouched_since_long_before_the_index_is_still_skipped(graph, capsys):
    # the racy-mtime re-read must not turn the mtime gate off for settled files
    for p in graph["mem_dir"].glob("*.md"):
        os.utime(p, (1_000_000_000, 1_000_000_000))
    recall.cmd_index()
    recall.cmd_index()
    last = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert last["files_indexed"] == 0 and last["files_skipped_unchanged"] == 3, last


def test_deleting_a_memory_prunes_entries_node_edges_and_fts(graph):
    recall.cmd_index()
    con = recall._connect()
    hub_path = str(graph["mem_dir"] / "hub.md")
    hub_ids_before = [r[0] for r in con.execute("SELECT id FROM entries WHERE source_path=?", (hub_path,))]
    assert len(hub_ids_before) == 1

    (graph["mem_dir"] / "hub.md").unlink()
    assert recall.cmd_index() == 0

    con = recall._connect()
    con.row_factory = sqlite3.Row
    assert con.execute("SELECT COUNT(*) FROM entries WHERE source_path=?", (hub_path,)).fetchone()[0] == 0
    assert con.execute("SELECT COUNT(*) FROM memory_files WHERE name='hub'").fetchone()[0] == 0
    assert con.execute("SELECT COUNT(*) FROM memory_links WHERE src='hub'").fetchone()[0] == 0
    assert len(recall._run_search_query(con, '"the hub fact"', 10, 0.0)) == 0

    # The JOIN in _run_search_query hides an orphaned FTS row (it joins to
    # nothing), so the assertion above cannot see a skipped FTS delete. Query
    # the FTS table DIRECTLY and make SQLite audit its own external-content
    # invariant.
    assert con.execute(
        "SELECT COUNT(*) FROM entries_fts WHERE entries_fts MATCH ?", ('"the hub fact"',)
    ).fetchone()[0] == 0
    con.execute("INSERT INTO entries_fts(entries_fts) VALUES('integrity-check')")  # raises if corrupt

    # ...and the survivors are still searchable, so the prune wasn't a wipe.
    assert len(recall._run_search_query(con, "leaf", 10, 0.0)) > 0


# ---------------------------------------------------------------------------
# memory dir resolution
# ---------------------------------------------------------------------------

def test_bot_memory_dir_env_overrides_the_derived_path(tmp_path, monkeypatch):
    override = tmp_path / "override"
    monkeypatch.setenv("BOT_MEMORY_DIR", str(override))
    assert recall._default_memory_dir() == override


def test_derived_memory_dir_shape(monkeypatch):
    monkeypatch.delenv("BOT_MEMORY_DIR", raising=False)
    derived = recall._default_memory_dir()
    # Environment-agnostic: assert the SHAPE of the CC project-slug derivation
    # (every non-alnum char of the repo path replaced with '-'), not a
    # literal "C--Users..." prefix that only holds on one box/OS.
    import re
    assert re.fullmatch(r"[A-Za-z0-9-]+", derived.parent.name)
    assert derived.name == "memory"
