#!/usr/bin/env python3
"""Cross-session recall — FTS5 full-text index over all session journals.

Pattern (not import) from hermes-agent idea #1 (docs/hermes-agent-review.md
§4): a local search substrate so the Director can recall what ANY past
session found/decided without re-reading 17 journals into context.

What it indexes
---------------
Every journal entry in memory/sessions/*/journal.md — one FTS row per
`- [HH:MM:SS] <text>` bullet, tagged with its kind (from the enclosing
`## Section` header), session_id, timestamp, source path, and a sequence
number so we can reconstruct surrounding context. Promoted cross-session
timelines under memory/timelines/*.md are indexed too (kind=timeline).

Storage: memory/index/recall.db (SQLite + FTS5). Pure SQLite, zero LLM
calls — target ~ms recall.

Journal format facts (verified against real journals, see journal.py):
- YAML front-matter delimited by `---` at top.
- `## <Section>` headers: Findings, Decisions, Observations, Open Questions,
  Hypotheses, Actions. Mapped back to the journal.py KINDS keys.
- Each entry is ONE physical line: `- [HH:MM:SS] <text>` (verified: 225
  bullets / 0 continuation lines in the largest journal). We treat each
  bullet as one entry; `_(none yet)_` placeholders are skipped.

Commands
--------
  recall.py index               # build/refresh (idempotent, mtime-gated)
  recall.py index --force       # re-index every file regardless of mtime
  recall.py search "<query>"    # FTS5 search -> ranked, bookend-windowed
  recall.py search "<q>" --json # machine-readable results
  recall.py stats               # row/session/file counts

Fail-open: index errors on one file are logged to stderr and skipped; the
rest of the index still builds.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import instance_root, harness_root  # noqa: E402

REPO_ROOT = instance_root()
SESSIONS_DIR = REPO_ROOT / "memory" / "sessions"
TIMELINES_DIR = REPO_ROOT / "memory" / "timelines"
LONGTERM_DIR = REPO_ROOT / "memory" / "longterm"
INDEX_DIR = REPO_ROOT / "memory" / "index"
DB_PATH = INDEX_DIR / "recall.db"


def _default_memory_dir() -> Path:
    """Claude Code's auto-memory dir for THIS project. CC derives the folder
    name from the project path by replacing every non-alphanumeric character
    with '-'. Overridable with BOT_MEMORY_DIR."""
    override = os.environ.get("BOT_MEMORY_DIR")
    if override:
        return Path(override)
    slug = re.sub(r"[^A-Za-z0-9]", "-", str(REPO_ROOT))
    return Path.home() / ".claude" / "projects" / slug / "memory"


MEMORY_DIR = _default_memory_dir()
# [[slug]] wiki-links are the edges of the memory graph.
MEMORY_LINK_RE = re.compile(r"\[\[([A-Za-z0-9][A-Za-z0-9._-]*)\]\]")
# Fenced blocks first (``` ... ```), then inline spans (`` ` `` runs).
CODE_SPAN_RE = re.compile(r"```.*?```|`+[^`\n]*`+", re.S)
# Cap what a single hit can drag in. The graph is dense (488 links over 148
# files); an uncapped 1-hop expansion on a hub node would flood the Director's
# context with the very re-reading recall exists to avoid.
MEMORY_NEIGHBOUR_CAP = 6
# A file whose mtime is this close to the moment it was read can be rewritten
# again inside the same filesystem timestamp tick (NTFS ~16 ms, FAT 2 s) and
# keep the SAME mtime; the mtime gate would then skip that edit forever. Such
# a file is recorded as unseen so the next index re-reads it (git's "racy
# clean" rule). Only just-written files pay the extra read.
RACY_MTIME_SECONDS = 2.0


def _sanitize_snippet(text: str) -> str:
    """Sanitize a recalled journal/timeline snippet before it is returned to the
    Director. Journals can carry pasted TG/web content = an injection-persistence
    vector (a poisoned entry recalled next session becomes trusted context). Gate
    HIGH/CRITICAL risk to a marker; otherwise return the cleaned text.

    FAIL-OPEN: if sanitize can't run, return the raw text — recall must never break.
    """
    if not text or not text.strip():
        return text
    try:
        sys.path.insert(0, str(harness_root() / "tools" / "infra"))
        import sanitize  # tools/infra/sanitize.py

        findings = sanitize.scan(text)
        risk = sanitize.get_risk_level(findings)
        if risk in ("HIGH", "CRITICAL"):
            return f"[BLOCKED: high-risk recalled content — risk={risk}, not shown, review manually]"
        cleaned, _f, _r = sanitize.full_sanitize(text, source="recall", frame=False)
        return cleaned
    except Exception:
        return text

# Reverse of journal.py KINDS: section header -> kind key.
SECTION_TO_KIND = {
    "Findings": "finding",
    "Decisions": "decision",
    "Observations": "observation",
    "Open Questions": "question",
    "Hypotheses": "hypothesis",
    "Actions": "action",
}

ENTRY_RE = re.compile(r"^-\s+\[(\d{2}:\d{2}:\d{2})\]\s+(.*)$")
SECTION_RE = re.compile(r"^##\s+(.+?)\s*$")
PLACEHOLDER = "_(none yet)_"

# Trust scoring (hermes idea #4, holographic/store.py:78-82). Asymmetric:
# helpful nudges up modestly, unhelpful punishes harder so wrong facts decay.
DEFAULT_TRUST = 0.5
HELPFUL_DELTA = 0.05
UNHELPFUL_DELTA = -0.10
TRUST_MIN = 0.0
TRUST_MAX = 1.0


# ---------------------------------------------------------------------------
# DB setup
# ---------------------------------------------------------------------------

def _connect() -> sqlite3.Connection:
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(DB_PATH))
    con.execute("PRAGMA journal_mode=WAL;")
    return con


def _init_schema(con: sqlite3.Connection) -> None:
    # files: track mtimes so re-index is cheap (skip unchanged files).
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS files (
            source_path TEXT PRIMARY KEY,
            mtime       REAL NOT NULL
        )
        """
    )
    # entries: the canonical rows. seq = order within (session, source) so we
    # can fetch the surrounding window for a hit ("bookend + window").
    # trust_score / retrieval_count / helpful_count implement the holographic
    # store's trust+decay pattern (hermes idea #4): search ranks by FTS5 rank
    # THEN trust_score DESC, and `feedback` nudges trust asymmetrically so
    # facts that proved wrong decay out of recall.
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS entries (
            id              INTEGER PRIMARY KEY,
            session_id      TEXT NOT NULL,
            kind            TEXT NOT NULL,
            ts              TEXT,
            seq             INTEGER NOT NULL,
            source_path     TEXT NOT NULL,
            text            TEXT NOT NULL,
            trust_score     REAL DEFAULT 0.5,
            retrieval_count INTEGER DEFAULT 0,
            helpful_count   INTEGER DEFAULT 0
        )
        """
    )
    _migrate_trust_columns(con)
    con.execute("CREATE INDEX IF NOT EXISTS idx_entries_src ON entries(source_path, seq);")
    con.execute("CREATE INDEX IF NOT EXISTS idx_entries_sess ON entries(session_id, seq);")
    # The memory graph. One auto-memory file = one node = one entries row; its
    # [[slug]] wiki-links are the edges. Kept in their own tables (not folded
    # into entries) because an edge can point at a slug that has no file yet —
    # a dangling link is a real, queryable state, not a broken row.
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS memory_files (
            name        TEXT PRIMARY KEY,
            source_path TEXT NOT NULL,
            description TEXT
        )
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS memory_links (
            src TEXT NOT NULL,
            dst TEXT NOT NULL,
            PRIMARY KEY (src, dst)
        )
        """
    )
    con.execute("CREATE INDEX IF NOT EXISTS idx_memfiles_src ON memory_files(source_path);")
    con.execute("CREATE INDEX IF NOT EXISTS idx_memlinks_dst ON memory_links(dst);")
    # FTS5 external-content table mirroring entries.text, with triggers to
    # keep it in sync. content_rowid ties fts rows to entries.id.
    con.execute(
        """
        CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
            text,
            content='entries',
            content_rowid='id',
            tokenize='porter unicode61'
        )
        """
    )
    con.commit()


def _migrate_trust_columns(con: sqlite3.Connection) -> None:
    """Add trust columns to a pre-existing entries table in-place (the already-
    built 420-entry recall.db predates these columns). Idempotent: only ALTERs
    a column that's missing. Fail-open — a migration error must not break index."""
    try:
        cols = {r[1] for r in con.execute("PRAGMA table_info(entries)")}
    except sqlite3.OperationalError:
        return
    adds = [
        ("trust_score", f"REAL DEFAULT {DEFAULT_TRUST}"),
        ("retrieval_count", "INTEGER DEFAULT 0"),
        ("helpful_count", "INTEGER DEFAULT 0"),
    ]
    for name, decl in adds:
        if name not in cols:
            try:
                con.execute(f"ALTER TABLE entries ADD COLUMN {name} {decl}")
            except sqlite3.OperationalError as e:
                print(f"[recall] trust migration skip {name}: {e!r}", file=sys.stderr)
    con.commit()


def _has_fts5(con: sqlite3.Connection) -> bool:
    try:
        con.execute("CREATE VIRTUAL TABLE IF NOT EXISTS _fts_probe USING fts5(x);")
        con.execute("DROP TABLE IF EXISTS _fts_probe;")
        return True
    except sqlite3.OperationalError:
        return False


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def _session_id_from_frontmatter(text: str, fallback: str) -> str:
    in_fm = False
    for line in text.splitlines():
        if line.strip() == "---":
            if not in_fm:
                in_fm = True
                continue
            break
        if in_fm and line.startswith("session_id:"):
            return line.split(":", 1)[1].strip() or fallback
    return fallback


def _parse_journal(text: str, session_fallback: str) -> list[dict]:
    """Yield {kind, ts, seq, text} per entry bullet under a known section."""
    session_id = _session_id_from_frontmatter(text, session_fallback)
    out: list[dict] = []
    current_kind: str | None = None
    seq = 0
    for line in text.splitlines():
        m_sec = SECTION_RE.match(line)
        if m_sec:
            current_kind = SECTION_TO_KIND.get(m_sec.group(1).strip())
            continue
        if current_kind is None:
            continue
        m_e = ENTRY_RE.match(line.strip())
        if not m_e:
            continue
        body = m_e.group(2).strip()
        if not body or body == PLACEHOLDER:
            continue
        out.append(
            {
                "session_id": session_id,
                "kind": current_kind,
                "ts": m_e.group(1),
                "seq": seq,
                "text": body,
            }
        )
        seq += 1
    return out


def _parse_timeline(text: str, session_fallback: str) -> list[dict]:
    """Timelines are looser markdown; index each non-trivial bullet line as
    kind=timeline so cross-session distillations are searchable too."""
    session_id = _session_id_from_frontmatter(text, session_fallback)
    out: list[dict] = []
    seq = 0
    for line in text.splitlines():
        s = line.strip()
        if not s.startswith("- "):
            continue
        body = s[2:].strip()
        # strip a leading [HH:MM] / [HH:MM:SS] timestamp if present
        ts = None
        m = re.match(r"^\[(\d{2}:\d{2}(?::\d{2})?)\]\s*(.*)$", body)
        if m:
            ts, body = m.group(1), m.group(2).strip()
        if not body or body == PLACEHOLDER:
            continue
        out.append(
            {
                "session_id": session_id,
                "kind": "timeline",
                "ts": ts,
                "seq": seq,
                "text": body,
            }
        )
        seq += 1
    return out


_FM_FIELD_RE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$")


def _parse_memory(text: str, fallback_name: str) -> dict:
    """Parse one auto-memory file into a graph node.

    Returns {name, description, ts, session_id, links[], entry}. A memory file
    is ONE fact, so it is ONE entry — unlike a journal, where each bullet is
    its own row. Splitting it per-paragraph would make the '**Why:**' line
    rank as a separate, contextless hit.
    """
    name = fallback_name
    description = ""
    ts = None
    session_id = "memory"
    body = text

    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            fm = text[3:end]
            body = text[end + 4:]
            for line in fm.splitlines():
                m = _FM_FIELD_RE.match(line)
                if not m:
                    continue
                key, val = m.group(1), m.group(2).strip().strip('"').strip("'")
                if not val:
                    continue
                if key == "name":
                    name = val
                elif key == "description":
                    description = val
                elif key == "modified":
                    ts = val
                elif key == "originSessionId":
                    session_id = val

    # Edges come from the BODY only: a slug in the front-matter would make a
    # node link to itself, and `name:` is the node, not an edge. Inline code
    # spans are stripped first — a doc that MENTIONS the syntax (`[[slug]]` as
    # an example) is talking about links, not making one, and that mention was
    # showing up as a permanent dangling edge.
    linkable = CODE_SPAN_RE.sub(" ", body)
    links = sorted({m.group(1) for m in MEMORY_LINK_RE.finditer(linkable)} - {name})

    flat = re.sub(r"\s+", " ", f"{description} {body}").strip()
    return {
        "name": name,
        "description": description,
        "links": links,
        "entry": {
            "session_id": session_id,
            "kind": "memory",
            "ts": ts,
            "seq": 0,
            "text": f"[{name}] {flat}" if flat else f"[{name}]",
        },
    }


# ---------------------------------------------------------------------------
# Indexing
# ---------------------------------------------------------------------------

def _reindex_file(con: sqlite3.Connection, path: Path, entries: list[dict]) -> int:
    src = str(path)
    # Preserve accumulated trust signal across a re-index: rows are dropped and
    # re-inserted (IDs change), so carry trust/counts forward keyed on
    # (seq, text) — stable for append-only journals. Anything not matched gets
    # defaults (a fresh entry starts at DEFAULT_TRUST).
    prior = {
        (r[0], r[1]): (r[2], r[3], r[4])
        for r in con.execute(
            "SELECT seq, text, trust_score, retrieval_count, helpful_count "
            "FROM entries WHERE source_path=?", (src,)
        )
    }
    # Drop any prior rows for this file (also from FTS via explicit delete),
    # then re-insert. Cheaper than diffing for journals of this size.
    old_ids = [r[0] for r in con.execute("SELECT id FROM entries WHERE source_path=?", (src,))]
    for oid in old_ids:
        con.execute("INSERT INTO entries_fts(entries_fts, rowid, text) VALUES('delete', ?, (SELECT text FROM entries WHERE id=?))", (oid, oid))
    con.execute("DELETE FROM entries WHERE source_path=?", (src,))
    n = 0
    for e in entries:
        ts_score, retr, helpful = prior.get((e["seq"], e["text"]), (DEFAULT_TRUST, 0, 0))
        cur = con.execute(
            "INSERT INTO entries(session_id, kind, ts, seq, source_path, text, "
            "trust_score, retrieval_count, helpful_count) VALUES(?,?,?,?,?,?,?,?,?)",
            (e["session_id"], e["kind"], e["ts"], e["seq"], src, e["text"],
             ts_score, retr, helpful),
        )
        rid = cur.lastrowid
        con.execute("INSERT INTO entries_fts(rowid, text) VALUES(?, ?)", (rid, e["text"]))
        n += 1
    return n


def _reindex_memory_graph(con: sqlite3.Connection, path: Path, node: dict) -> None:
    """Refresh one memory file's node + out-edges.

    Keyed on source_path, not name, so renaming the `name:` field inside a file
    replaces the old node instead of leaving a ghost behind. In-edges are not
    touched: they belong to the files that wrote them.
    """
    src = str(path)
    for (old_name,) in con.execute("SELECT name FROM memory_files WHERE source_path=?", (src,)).fetchall():
        con.execute("DELETE FROM memory_links WHERE src=?", (old_name,))
    con.execute("DELETE FROM memory_files WHERE source_path=?", (src,))
    con.execute(
        "INSERT INTO memory_files(name, source_path, description) VALUES(?,?,?) "
        "ON CONFLICT(name) DO UPDATE SET source_path=excluded.source_path, "
        "description=excluded.description",
        (node["name"], src, node["description"]),
    )
    con.execute("DELETE FROM memory_links WHERE src=?", (node["name"],))
    for dst in node["links"]:
        con.execute("INSERT OR IGNORE INTO memory_links(src, dst) VALUES(?,?)", (node["name"], dst))


def _prune_missing(con: sqlite3.Connection) -> int:
    """Drop rows for source files that no longer exist.

    Load-bearing for memory: a memory deleted because it turned out to be WRONG
    must stop being recalled. Without this the FTS row outlives the file and the
    Director keeps getting told the thing that was deleted for being false.
    """
    dropped = 0
    for (src,) in con.execute("SELECT DISTINCT source_path FROM entries").fetchall():
        if Path(src).exists():
            continue
        for (oid,) in con.execute("SELECT id FROM entries WHERE source_path=?", (src,)).fetchall():
            con.execute(
                "INSERT INTO entries_fts(entries_fts, rowid, text) "
                "VALUES('delete', ?, (SELECT text FROM entries WHERE id=?))", (oid, oid)
            )
        con.execute("DELETE FROM entries WHERE source_path=?", (src,))
        con.execute("DELETE FROM files WHERE source_path=?", (src,))
        for (name,) in con.execute("SELECT name FROM memory_files WHERE source_path=?", (src,)).fetchall():
            con.execute("DELETE FROM memory_links WHERE src=?", (name,))
        con.execute("DELETE FROM memory_files WHERE source_path=?", (src,))
        dropped += 1
    return dropped


def cmd_index(force: bool = False) -> int:
    con = _connect()
    if not _has_fts5(con):
        print("ERROR: this SQLite build lacks FTS5; cannot index", file=sys.stderr)
        return 1
    _init_schema(con)

    known = {r[0]: r[1] for r in con.execute("SELECT source_path, mtime FROM files")}
    indexed_files = 0
    indexed_entries = 0
    skipped = 0

    targets: list[tuple[Path, str]] = []  # (path, kind-of-file)
    for jp in sorted(SESSIONS_DIR.glob("*/journal.md")):
        targets.append((jp, "journal"))
    if TIMELINES_DIR.exists():
        for tp in sorted(TIMELINES_DIR.glob("*.md")):
            targets.append((tp, "timeline"))
    # Pre-compaction salvage (Hermes #5) writes durable decisions and findings
    # to memory/longterm/ before context is discarded. It had grown to 580KB
    # over three months and NOTHING read it: precompact_extract.py was the only
    # file in the repo that named it, so every insight it rescued from a
    # compaction went straight into a drawer nobody opens. Salvaging into an
    # unindexed file is not memory, it is filing.
    if LONGTERM_DIR.exists():
        for lp in sorted(LONGTERM_DIR.glob("*.md")):
            targets.append((lp, "timeline"))
    if MEMORY_DIR.exists():
        for mp in sorted(MEMORY_DIR.glob("*.md")):
            # MEMORY.md is the hand-written index of the others — indexing it
            # would return the pointer instead of the fact it points at.
            if mp.name == "MEMORY.md":
                continue
            targets.append((mp, "memory"))

    for path, ftype in targets:
        try:
            now = time.time()   # before the stat: an earlier "now" can only flag more files racy
            mtime = path.stat().st_mtime
            if not force and known.get(str(path)) == mtime:
                skipped += 1
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            fallback = path.parent.name if ftype == "journal" else path.stem
            if ftype == "memory":
                node = _parse_memory(text, fallback)
                _reindex_memory_graph(con, path, node)
                entries = [node["entry"]]
            elif ftype == "journal":
                entries = _parse_journal(text, fallback)
            else:
                entries = _parse_timeline(text, fallback)
            n = _reindex_file(con, path, entries)
            con.execute(
                "INSERT INTO files(source_path, mtime) VALUES(?,?) "
                "ON CONFLICT(source_path) DO UPDATE SET mtime=excluded.mtime",
                (str(path), mtime if now - mtime > RACY_MTIME_SECONDS else -1.0),
            )
            con.commit()
            indexed_files += 1
            indexed_entries += n
        except Exception as e:  # fail-open per file
            print(f"[recall] skip {path}: {e!r}", file=sys.stderr)
            con.rollback()
            continue

    try:
        pruned = _prune_missing(con)
        con.commit()
    except Exception as e:  # fail-open: a stale row beats a broken index
        print(f"[recall] prune skipped: {e!r}", file=sys.stderr)
        con.rollback()
        pruned = 0

    print(json.dumps({
        "status": "indexed",
        "files_indexed": indexed_files,
        "files_skipped_unchanged": skipped,
        "files_pruned_missing": pruned,
        "entries_indexed": indexed_entries,
        "db": str(DB_PATH),
    }))
    return 0


# ---------------------------------------------------------------------------
# Search (bookend + window)
# ---------------------------------------------------------------------------

def _window(con: sqlite3.Connection, hit: sqlite3.Row, radius: int) -> list[dict]:
    """Return the hit plus +/- `radius` sibling entries from the same file,
    ordered by seq — the Hermes 'bookend + window' so the Director sees
    goal -> match -> resolution, not a bare matched line."""
    rows = con.execute(
        "SELECT id, kind, ts, seq, text FROM entries "
        "WHERE source_path=? AND seq BETWEEN ? AND ? ORDER BY seq",
        (hit["source_path"], hit["seq"] - radius, hit["seq"] + radius),
    ).fetchall()
    return [
        {
            "kind": r[1],
            "ts": r[2],
            "seq": r[3],
            "text": _sanitize_snippet(r[4]),
            "is_match": r[0] == hit["id"],
        }
        for r in rows
    ]


def _neighbours(con: sqlite3.Connection, source_path: str,
                cap: int = MEMORY_NEIGHBOUR_CAP) -> list[dict]:
    """1-hop neighbours of the memory node stored at `source_path`.

    The window function gives a journal hit its temporal context; this gives a
    memory hit its SEMANTIC context — the facts the operator (or I) explicitly
    linked to it. Zero LLM, one join. Out-edges first (this fact points there
    deliberately), then in-edges, capped: a hub node can have far more than a
    Director needs in one recall.
    """
    row = con.execute("SELECT name FROM memory_files WHERE source_path=?", (source_path,)).fetchone()
    if not row:
        return []
    name = row[0]
    seen: set[str] = set()
    out: list[dict] = []
    for direction, sql in (
        ("out", "SELECT dst FROM memory_links WHERE src=? ORDER BY dst"),
        ("in", "SELECT src FROM memory_links WHERE dst=? ORDER BY src"),
    ):
        for (other,) in con.execute(sql, (name,)).fetchall():
            if other == name or other in seen:
                continue
            seen.add(other)
            meta = con.execute(
                "SELECT description, source_path FROM memory_files WHERE name=?", (other,)
            ).fetchone()
            out.append({
                "name": other,
                "direction": direction,
                # A dangling edge is reported, not hidden: it marks a fact that
                # was linked but never written.
                "description": (meta[0] if meta else None),
                "exists": meta is not None,
            })
            if len(out) >= cap:
                return out
    return out


def _run_search_query(con, query, limit, min_trust):
    # Rank by FTS5 relevance THEN trust_score DESC (hermes #4): among similarly
    # relevant hits, more-trusted facts surface first; low-trust facts (e.g.
    # downvoted-as-wrong) sink. min_trust hard-filters decayed facts out.
    sql = """
        SELECT e.id AS id, e.session_id AS session_id, e.kind AS kind,
               e.ts AS ts, e.seq AS seq, e.source_path AS source_path,
               e.text AS text, bm25(entries_fts) AS rank,
               e.trust_score AS trust_score
        FROM entries_fts
        JOIN entries e ON e.id = entries_fts.rowid
        WHERE entries_fts MATCH ? AND e.trust_score >= ?
        ORDER BY rank, e.trust_score DESC
        LIMIT ?
    """
    return con.execute(sql, (query, min_trust, limit)).fetchall()


def cmd_search(query: str, limit: int = 8, radius: int = 2, as_json: bool = False,
               min_trust: float = TRUST_MIN) -> int:
    con = _connect()
    con.row_factory = sqlite3.Row
    try:
        rows = _run_search_query(con, query, limit, min_trust)
    except sqlite3.OperationalError as e:
        # FTS5 MATCH syntax error (e.g. bare special chars) — retry as a
        # quoted phrase so the Director never has to escape queries.
        try:
            safe = '"' + query.replace('"', '""') + '"'
            rows = _run_search_query(con, safe, limit, min_trust)
        except sqlite3.OperationalError:
            print(f"ERROR: bad FTS query {query!r}: {e}", file=sys.stderr)
            return 1

    # Increment retrieval_count on every returned hit (decay/usage signal).
    hit_ids = [r["id"] for r in rows]
    if hit_ids:
        try:
            con.executemany(
                "UPDATE entries SET retrieval_count = retrieval_count + 1 WHERE id=?",
                [(i,) for i in hit_ids],
            )
            con.commit()
        except sqlite3.OperationalError:
            pass  # fail-open: a counter bump must never break recall

    results = []
    for r in rows:
        res = {
            "session_id": r["session_id"],
            "kind": r["kind"],
            "ts": r["ts"],
            "rank": round(r["rank"], 3),
            "trust": round(r["trust_score"], 3) if r["trust_score"] is not None else DEFAULT_TRUST,
            "entry_id": r["id"],
            "source_path": str(Path(r["source_path"]).relative_to(REPO_ROOT)) if str(r["source_path"]).startswith(str(REPO_ROOT)) else r["source_path"],
            "window": _window(con, r, radius),
        }
        if r["kind"] == "memory":
            res["neighbours"] = _neighbours(con, r["source_path"])
        results.append(res)

    if as_json:
        print(json.dumps({"query": query, "count": len(results), "results": results}, indent=2))
        return 0

    if not results:
        print(f"(no matches for {query!r})")
        return 0

    for i, res in enumerate(results, 1):
        print(f"#{i}  [{res['kind']}] session={res['session_id']}  rank={res['rank']}  trust={res['trust']}  id={res['entry_id']}  ({res['source_path']})")
        for w in res["window"]:
            mark = ">>" if w["is_match"] else "  "
            tsl = f"[{w['ts']}] " if w["ts"] else ""
            txt = w["text"]
            if len(txt) > 220:
                txt = txt[:217] + "..."
            print(f"   {mark} {tsl}({w['kind']}) {txt}")
        for nb in res.get("neighbours", []):
            arrow = "->" if nb["direction"] == "out" else "<-"
            desc = nb["description"] or "(no file yet)"
            if len(desc) > 90:
                desc = desc[:87] + "..."
            print(f"    {arrow} [[{nb['name']}]] {desc}")
        print()
    return 0


def cmd_feedback(entry_id: int, verdict: str) -> int:
    """Nudge an entry's trust_score: helpful +0.05, unhelpful -0.10 (clamped
    0..1). Asymmetric per hermes #4 so wrong facts decay faster than right ones
    climb. Also bumps helpful_count on a helpful vote. Fail-open."""
    if verdict not in ("helpful", "unhelpful"):
        print(f"ERROR: verdict must be 'helpful' or 'unhelpful', got {verdict!r}", file=sys.stderr)
        return 2
    con = _connect()
    con.row_factory = sqlite3.Row
    try:
        row = con.execute(
            "SELECT id, trust_score, helpful_count, text FROM entries WHERE id=?",
            (entry_id,),
        ).fetchone()
    except sqlite3.OperationalError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    if row is None:
        print(json.dumps({"status": "not_found", "entry_id": entry_id}))
        return 2
    old = row["trust_score"] if row["trust_score"] is not None else DEFAULT_TRUST
    delta = HELPFUL_DELTA if verdict == "helpful" else UNHELPFUL_DELTA
    new = max(TRUST_MIN, min(TRUST_MAX, old + delta))
    helpful_inc = 1 if verdict == "helpful" else 0
    try:
        con.execute(
            "UPDATE entries SET trust_score=?, helpful_count = helpful_count + ? WHERE id=?",
            (new, helpful_inc, entry_id),
        )
        con.commit()
    except sqlite3.OperationalError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    print(json.dumps({
        "status": "ok",
        "entry_id": entry_id,
        "verdict": verdict,
        "trust_before": round(old, 3),
        "trust_after": round(new, 3),
        "text": (row["text"] or "")[:120],
    }))
    return 0


def cmd_stats() -> int:
    con = _connect()
    try:
        n_entries = con.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
        n_sessions = con.execute("SELECT COUNT(DISTINCT session_id) FROM entries").fetchone()[0]
        n_files = con.execute("SELECT COUNT(*) FROM files").fetchone()[0]
        by_kind = {k: c for k, c in con.execute("SELECT kind, COUNT(*) FROM entries GROUP BY kind ORDER BY COUNT(*) DESC")}
        n_nodes = con.execute("SELECT COUNT(*) FROM memory_files").fetchone()[0]
        n_edges = con.execute("SELECT COUNT(*) FROM memory_links").fetchone()[0]
        n_dangling = con.execute(
            "SELECT COUNT(*) FROM memory_links l "
            "WHERE NOT EXISTS (SELECT 1 FROM memory_files f WHERE f.name = l.dst)"
        ).fetchone()[0]
        n_orphan = con.execute(
            "SELECT COUNT(*) FROM memory_files f "
            "WHERE NOT EXISTS (SELECT 1 FROM memory_links l WHERE l.dst = f.name)"
        ).fetchone()[0]
    except sqlite3.OperationalError:
        print(json.dumps({"status": "empty", "note": "run `recall.py index` first"}))
        return 0
    print(json.dumps({
        "entries": n_entries,
        "sessions": n_sessions,
        "files": n_files,
        "by_kind": by_kind,
        "memory_graph": {
            "nodes": n_nodes,
            "edges": n_edges,
            "dangling_edges": n_dangling,
            "no_inbound": n_orphan,
        },
        "db": str(DB_PATH),
    }, indent=2))
    return 0


def cmd_neighbours(name: str, as_json: bool = False) -> int:
    """Walk 1 hop from a named memory node. Uncapped — this is the explicit
    'show me around this fact' command, unlike the capped expansion attached
    to a search hit."""
    con = _connect()
    try:
        row = con.execute(
            "SELECT source_path, description FROM memory_files WHERE name=?", (name,)
        ).fetchone()
    except sqlite3.OperationalError:
        print(json.dumps({"status": "empty", "note": "run `recall.py index` first"}))
        return 1
    if row is None:
        print(json.dumps({"status": "not_found", "name": name}))
        return 2
    nbs = _neighbours(con, row[0], cap=10_000)
    if as_json:
        print(json.dumps({"name": name, "description": row[1],
                          "source_path": row[0], "neighbours": nbs}, indent=2))
        return 0
    print(f"[[{name}]] {row[1] or ''}\n  ({row[0]})")
    for nb in nbs:
        arrow = "->" if nb["direction"] == "out" else "<-"
        print(f"  {arrow} [[{nb['name']}]] {nb['description'] or '(no file yet)'}")
    if not nbs:
        print("  (no links either way)")
    return 0


USAGE = """\
recall — FTS5 cross-session recall over session journals, timelines + memories

Usage:
  recall.py index [--force]          build/refresh the index (mtime-gated)
  recall.py search "<query>" [--json] [--limit N] [--radius R] [--min-trust X]
  recall.py neighbours <memory-name> [--json]
  recall.py feedback <entry_id> helpful|unhelpful
  recall.py stats

Trust: each entry has a trust_score (default 0.5). search ranks by FTS5 rank
then trust DESC and filters --min-trust; feedback nudges +0.05/-0.10 (clamped)
so facts that proved wrong decay out of recall.

Memory graph: the auto-memory files are indexed one node per file, and their
[[slug]] links are edges. A search hit on a memory carries its 1-hop
neighbours (capped); `neighbours` walks one node uncapped.

Index: memory/index/recall.db (SQLite FTS5). Pure local, no LLM calls.
"""


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in ("-h", "--help", "help"):
        print(USAGE)
        return 0
    cmd = argv[1]
    if cmd == "index":
        return cmd_index(force="--force" in argv[2:])
    if cmd == "search" and len(argv) >= 3:
        query = argv[2]
        as_json = "--json" in argv[3:]
        limit = 8
        radius = 2
        min_trust = TRUST_MIN
        rest = argv[3:]
        for i, a in enumerate(rest):
            if a == "--limit" and i + 1 < len(rest):
                try:
                    limit = int(rest[i + 1])
                except ValueError:
                    pass
            if a == "--radius" and i + 1 < len(rest):
                try:
                    radius = int(rest[i + 1])
                except ValueError:
                    pass
            if a == "--min-trust" and i + 1 < len(rest):
                try:
                    min_trust = float(rest[i + 1])
                except ValueError:
                    pass
        return cmd_search(query, limit=limit, radius=radius, as_json=as_json, min_trust=min_trust)
    if cmd == "neighbours" and len(argv) >= 3:
        return cmd_neighbours(argv[2], as_json="--json" in argv[3:])
    if cmd == "feedback" and len(argv) >= 4:
        try:
            entry_id = int(argv[2])
        except ValueError:
            print(f"ERROR: entry_id must be an integer, got {argv[2]!r}", file=sys.stderr)
            return 2
        return cmd_feedback(entry_id, argv[3])
    if cmd == "stats":
        return cmd_stats()
    print(USAGE, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
