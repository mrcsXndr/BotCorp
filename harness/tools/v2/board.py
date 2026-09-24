#!/usr/bin/env python3
"""the bot's task board engine — JSON single source of truth.

`memory/tasks/board.json` is the canonical state of what the bot works on.
This module is both a CLI and importable by tg_commands.py.

Model: the board IS the state. Edit it (via these
commands or by submitting a new JSON) and the engine reconciles — `diff`
reports only what changed. Lanes drive the agent: a card in `asap` is queued
for work; `backlog` cards get scoped.

CLI:
  board.py show                         # human/TG render of the board
  board.py render                       # TG-markdown (used by /board)
  board.py add "title" [--pri P1] [--eff M] [--lane backlog] [--notes ..] [--refs a,b]
  board.py move <id> <lane>             # lane: backlog|asap|wip|done
  board.py pri  <id> <P0..P4>
  board.py eff  <id> <S|M|L|XL>
  board.py stage <id> <stage>
  board.py asap <id>  |  backlog <id>  |  wip <id>  |  done <id>
  board.py note <id> "text"
  board.py rm  <id>
  board.py validate
  board.py submit <file.json>           # replace state from a full new board, print the diff

IDs match on a unique prefix (with or without the `t-`), so `8f3a1c` works.
"""
from __future__ import annotations

import json
import os
import random
import string
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import instance_root  # noqa: E402

REPO_ROOT = instance_root()
BOARD_PATH = REPO_ROOT / "memory" / "tasks" / "board.json"

LANES = ["backlog", "asap", "wip", "done"]
LANE_LABEL = {"backlog": "Backlog", "asap": "Do ASAP", "wip": "In Progress", "done": "Done"}
LANE_ICON = {"backlog": "📋", "asap": "🔥", "wip": "🔧", "done": "✅"}
PRIORITIES = ["P0", "P1", "P2", "P3", "P4"]
PRI_ICON = {"P0": "🔴", "P1": "🟠", "P2": "🟡", "P3": "🔵", "P4": "⚪"}
EFFORTS = ["S", "M", "L", "XL"]
STAGES = ["discovery", "plan", "execution", "review", "dev", "approval", "prod"]


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _gen_id() -> str:
    return "t-" + "".join(random.choices("0123456789abcdef", k=6))


def _default_board() -> dict:
    return {"version": 1, "updated": _now(), "tasks": []}


def load() -> dict:
    if not BOARD_PATH.exists():
        return _default_board()
    try:
        return json.loads(BOARD_PATH.read_text(encoding="utf-8"))
    except Exception:
        return _default_board()


def save(board: dict) -> None:
    board["updated"] = _now()
    BOARD_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = BOARD_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(board, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, BOARD_PATH)  # atomic


def find(board: dict, ref: str) -> dict | None:
    """Match a task by exact id or a unique id-suffix (with or without 't-')."""
    ref = ref.strip().lower()
    bare = ref[2:] if ref.startswith("t-") else ref
    exact = [t for t in board["tasks"] if t["id"].lower() == ref or t["id"].lower() == "t-" + bare]
    if exact:
        return exact[0]
    hits = [t for t in board["tasks"] if bare and bare in t["id"].lower()]
    return hits[0] if len(hits) == 1 else None


def add(board, title, pri="P2", eff="M", lane="backlog", notes="", refs=None, stage="discovery") -> dict:
    pri = pri.upper() if pri.upper() in PRIORITIES else "P2"
    eff = eff.upper() if eff.upper() in EFFORTS else "M"
    lane = lane.lower() if lane.lower() in LANES else "backlog"
    task = {
        "id": _gen_id(), "title": title.strip(), "notes": notes.strip(),
        "refs": refs or [], "priority": pri, "effort": eff,
        "lane": lane, "stage": stage if stage in STAGES else "discovery",
        "blockers": [], "created": _now(), "updated": _now(),
    }
    board["tasks"].append(task)
    return task


def _touch(t):
    t["updated"] = _now()


# --- diff -------------------------------------------------------------------

def diff(old_tasks: list, new_tasks: list) -> list[dict]:
    """Structured delta old→new keyed by id. Returns list of change dicts."""
    o = {t["id"]: t for t in old_tasks}
    n = {t["id"]: t for t in new_tasks}
    out = []
    for tid, t in n.items():
        if tid not in o:
            out.append({"kind": "added", "task": t, "lane": t["lane"]})
            continue
        prev = o[tid]
        if prev.get("lane") != t.get("lane"):
            kind = "queued" if t["lane"] == "asap" else ("done" if t["lane"] == "done" else "moved")
            out.append({"kind": kind, "task": t, "from": prev["lane"], "to": t["lane"]})
        edits = [f for f in ("priority", "effort", "stage") if prev.get(f) != t.get(f)]
        if edits:
            out.append({"kind": "edited", "task": t, "fields": {f: (prev.get(f), t.get(f)) for f in edits}})
    for tid, t in o.items():
        if tid not in n:
            out.append({"kind": "removed", "task": t})
    return out


def render_diff(changes: list[dict]) -> str:
    if not changes:
        return "No changes — board already in sync."
    icon = {"added": "🆕", "queued": "🔥", "moved": "↔️", "done": "✅", "edited": "✏️", "removed": "🗑️"}
    lines = ["**Updated action items**"]
    for c in changes:
        t = c["task"]
        i = icon.get(c["kind"], "•")
        if c["kind"] == "added":
            lines.append(f"{i} `{t['id']}` **{t['title']}** → {LANE_LABEL[c['lane']]}")
        elif c["kind"] == "queued":
            lines.append(f"{i} `{t['id']}` **{t['title']}** — queued for the agent ({LANE_LABEL[c['from']]}→{LANE_LABEL[c['to']]})")
        elif c["kind"] in ("moved", "done"):
            verb = "done" if c["kind"] == "done" else "moved"
            lines.append(f"{i} `{t['id']}` **{t['title']}** — {verb} ({LANE_LABEL[c['from']]}→{LANE_LABEL[c['to']]})")
        elif c["kind"] == "edited":
            fs = ", ".join(f"{k} {a}→{b}" for k, (a, b) in c["fields"].items())
            lines.append(f"{i} `{t['id']}` **{t['title']}** — {fs}")
        elif c["kind"] == "removed":
            lines.append(f"{i} `{t['id']}` **{t['title']}** — removed")
    return "\n".join(lines)


# --- validate ---------------------------------------------------------------

def validate(board: dict) -> tuple[bool, list[str]]:
    errs = []
    ids = set()
    for i, t in enumerate(board.get("tasks", [])):
        for f in ("id", "title", "priority", "effort", "lane", "stage"):
            if f not in t:
                errs.append(f"task[{i}] missing '{f}'")
        if t.get("id") in ids:
            errs.append(f"duplicate id {t.get('id')}")
        ids.add(t.get("id"))
        if t.get("priority") not in PRIORITIES:
            errs.append(f"task {t.get('id')} bad priority {t.get('priority')}")
        if t.get("effort") not in EFFORTS:
            errs.append(f"task {t.get('id')} bad effort {t.get('effort')}")
        if t.get("lane") not in LANES:
            errs.append(f"task {t.get('id')} bad lane {t.get('lane')}")
        if t.get("stage") not in STAGES:
            errs.append(f"task {t.get('id')} bad stage {t.get('stage')}")
    return (not errs, errs)


# --- render for TG ----------------------------------------------------------

def render_tg(board: dict) -> str:
    tasks = board.get("tasks", [])
    open_n = sum(1 for t in tasks if t["lane"] != "done")
    out = [f"🗂️ **Board** — {open_n} open · {len(tasks)} total"]
    order = {p: i for i, p in enumerate(PRIORITIES)}
    for lane in LANES:
        items = [t for t in tasks if t["lane"] == lane]
        if not items:
            continue
        items.sort(key=lambda t: (order.get(t["priority"], 9), t["title"].lower()))
        out.append("")
        if lane == "done":
            out.append(f"{LANE_ICON[lane]} **{LANE_LABEL[lane]}** ({len(items)})")
            out.append("  " + ", ".join(f"`{t['id']}` {t['title']}" for t in items[:6]))
            continue
        out.append(f"{LANE_ICON[lane]} **{LANE_LABEL[lane]}** ({len(items)})")
        for t in items:
            stage = f"  ‹{t['stage']}›" if lane in ("wip",) else ""
            out.append(f"{PRI_ICON[t['priority']]} `{t['id']}` {t['priority']}·{t['effort']}  {t['title']}{stage}")
    out.append("")
    out.append("_edit:_ `/board asap <id>` · `/board pri <id> P1` · `/board add \"title\"` · `/board help`")
    return "\n".join(out)


# --- CLI --------------------------------------------------------------------

def _parse_add(args):
    title = args[0] if args else ""
    opts = {"pri": "P2", "eff": "M", "lane": "backlog", "notes": "", "refs": None}
    i = 1
    while i < len(args):
        a = args[i]
        if a in ("--pri", "--eff", "--lane", "--notes", "--refs") and i + 1 < len(args):
            key = a[2:]
            val = args[i + 1]
            opts["refs" if key == "refs" else key] = val.split(",") if key == "refs" else val
            i += 2
        else:
            i += 1
    return title, opts


def main(argv):
    if len(argv) < 2:
        print(render_tg(load()))
        return 0
    cmd = argv[1].lower()
    args = argv[2:]
    board = load()

    if cmd in ("show", "render"):
        print(render_tg(board))
        return 0
    if cmd == "validate":
        ok, errs = validate(board)
        print("OK" if ok else "\n".join(errs))
        return 0 if ok else 1
    if cmd == "add":
        title, o = _parse_add(args)
        if not title:
            print("usage: add \"title\" [--pri P1] [--eff M] [--lane asap]", file=sys.stderr)
            return 2
        t = add(board, title, o["pri"], o["eff"], o["lane"], o["notes"], o["refs"])
        save(board)
        print(f"added {t['id']}: {t['title']}")
        return 0
    if cmd == "submit":
        if not args:
            print("usage: submit <file.json>", file=sys.stderr)
            return 2
        new = json.loads(Path(args[0]).read_text(encoding="utf-8"))
        changes = diff(board["tasks"], new.get("tasks", []))
        save(new)
        print(render_diff(changes))
        return 0

    # id-first mutators
    if cmd in ("move", "pri", "eff", "stage", "asap", "backlog", "wip", "done", "rm", "note"):
        if not args:
            print(f"usage: {cmd} <id> ...", file=sys.stderr)
            return 2
        t = find(board, args[0])
        if not t:
            print(f"no unique task for '{args[0]}'", file=sys.stderr)
            return 2
        if cmd in ("asap", "backlog", "wip", "done"):
            t["lane"] = cmd
            if cmd == "wip" and t["stage"] in ("discovery", "plan"):
                t["stage"] = "execution"
            if cmd == "done":
                t["stage"] = "prod"
        elif cmd == "move":
            if len(args) < 2 or args[1].lower() not in LANES:
                print(f"lane must be one of {LANES}", file=sys.stderr)
                return 2
            t["lane"] = args[1].lower()
        elif cmd == "pri":
            if len(args) < 2 or args[1].upper() not in PRIORITIES:
                print(f"priority must be {PRIORITIES}", file=sys.stderr)
                return 2
            t["priority"] = args[1].upper()
        elif cmd == "eff":
            if len(args) < 2 or args[1].upper() not in EFFORTS:
                print(f"effort must be {EFFORTS}", file=sys.stderr)
                return 2
            t["effort"] = args[1].upper()
        elif cmd == "stage":
            if len(args) < 2 or args[1].lower() not in STAGES:
                print(f"stage must be {STAGES}", file=sys.stderr)
                return 2
            t["stage"] = args[1].lower()
        elif cmd == "note":
            t["notes"] = " ".join(args[1:])
        elif cmd == "rm":
            board["tasks"] = [x for x in board["tasks"] if x["id"] != t["id"]]
        _touch(t)
        save(board)
        print(f"{cmd} {t['id']}: {t['title']}")
        return 0

    print(f"unknown command: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
