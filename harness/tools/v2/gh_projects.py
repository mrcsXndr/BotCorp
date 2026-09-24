#!/usr/bin/env python3
"""GitHub Projects v2 board client — the bot's task board backend.

The GitHub Project (a real kanban board, drag-drop, mobile) is the single
source of truth. This client reads/writes it via the GraphQL API (Projects v2
has no REST) by shelling out to `gh api graphql`, so it uses the machine's gh
auth. For portability across bot clones a PAT can override via env
`GH_PROJECTS_TOKEN`.

Config (env, e.g. in .env):
  GH_PROJECT_OWNER    GitHub login that owns the project      (e.g. your-github-login)
  GH_PROJECT_NUMBER   the project number from its URL         (e.g. 1)
  GH_PROJECT_TYPE     "user" | "org"   (default: user)
  GH_PROJECTS_TOKEN   optional PAT (Projects r/w) — else uses gh's own login

`init` introspects the board and caches node/field/option IDs to
memory/tasks/gh_project.json so later calls are one GraphQL round-trip.

CLI:
  gh_projects.py init                      # introspect + cache field/option IDs
  gh_projects.py render                     # board grouped by Status (for TG)
  gh_projects.py move  <item> "<status>"    # set the Status (column)
  gh_projects.py set   <item> <field> "<value>"   # e.g. set Priority P0 / Size L
  gh_projects.py edit  <item> --body-file <path> [--title "<t>"] [--force]  # rewrite a card
                       (refuses to replace a NON-EMPTY body without --force —
                        GitHub keeps no history for a draft issue)
  gh_projects.py poll                       # diff vs last snapshot -> changes JSON
  gh_projects.py fields                     # dump discovered fields + options

Item refs match on a unique title-substring or the item id.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import instance_root  # noqa: E402

REPO_ROOT = instance_root()
CFG_PATH = REPO_ROOT / "memory" / "tasks" / "gh_project.json"
SNAP_PATH = REPO_ROOT / "memory" / "tasks" / "gh_project.snapshot.json"

def _load_env_file() -> dict:
    """Read KEY=VALUE pairs from the repo .env.

    The docstring above has always told operators to put GH_PROJECT_* "in .env",
    but nothing here ever read that file — config came from os.environ alone. So
    following the documented instruction produced a tool that stayed silently
    unconfigured: the supervisor's board poll failed 9,112 times between
    2026-07-09 and 2026-07-29 with zero successes, printing the same "set
    GH_PROJECT_OWNER and GH_PROJECT_NUMBER (e.g. in .env)" hint every three
    minutes to an operator who had done exactly that.

    Mirrors load_env() in tools/tg/tg_send.py. Real environment wins, so an
    explicit export still overrides the file.
    """
    env = {}
    f = REPO_ROOT / ".env"
    try:
        if f.exists():
            for line in f.read_text(encoding="utf-8").splitlines():
                s = line.strip()
                if not s or s.startswith("#") or "=" not in s:
                    continue
                k, v = s.split("=", 1)
                env[k.strip()] = v.strip()
    except Exception:
        pass  # never let a malformed .env break the tool
    return env


_ENV_FILE = _load_env_file()


def _cfg(key: str, default: str = "") -> str:
    return (os.environ.get(key) or _ENV_FILE.get(key) or default).strip()


OWNER = _cfg("GH_PROJECT_OWNER")
NUMBER = _cfg("GH_PROJECT_NUMBER")
PTYPE = _cfg("GH_PROJECT_TYPE", "user").lower()
PAT = _cfg("GH_PROJECTS_TOKEN")

# Emoji for a scannable TG render; falls back to the option name otherwise.
PRI_ICON = {"P0": "🔴", "P1": "🟠", "P2": "🟡", "P3": "🔵", "P4": "⚪"}


def _gh_env() -> dict:
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    if PAT:
        env["GH_TOKEN"] = PAT  # a PAT overrides the keyring login
    return env


def _gql(query: str, **variables) -> dict:
    """Run a GraphQL query/mutation via `gh api graphql`. Returns data or raises."""
    cmd = ["gh", "api", "graphql", "-f", f"query={query}"]
    for k, v in variables.items():
        # -F coerces numeric-looking strings to Int (breaks String! option ids that
        # are all-digits). Send real ints with -F, everything else raw with -f.
        if isinstance(v, bool) or isinstance(v, int):
            cmd += ["-F", f"{k}={v}"]
        else:
            cmd += ["-f", f"{k}={v}"]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=45,
                       encoding="utf-8", env=_gh_env())
    if r.returncode != 0:
        raise RuntimeError(f"gh graphql failed: {(r.stderr or r.stdout).strip()[:400]}")
    payload = json.loads(r.stdout)
    if "errors" in payload:
        raise RuntimeError(f"graphql errors: {json.dumps(payload['errors'])[:400]}")
    return payload["data"]


def _require_cfg():
    if not OWNER or not NUMBER:
        raise SystemExit("set GH_PROJECT_OWNER and GH_PROJECT_NUMBER (e.g. in .env)")


# --- introspection ----------------------------------------------------------

_Q_PROJECT = """
query($owner:String!, $number:Int!){
  %ROOT%(login:$owner){
    projectV2(number:$number){
      id title url
      fields(first:50){ nodes{
        __typename
        ... on ProjectV2FieldCommon { id name }
        ... on ProjectV2SingleSelectField { id name options { id name } }
      }}
    }
  }
}
""".replace("%ROOT%", "organization" if PTYPE == "org" else "user")


def init() -> dict:
    _require_cfg()
    data = _gql(_Q_PROJECT, owner=OWNER, number=int(NUMBER))
    proj = (data.get("organization") or data.get("user"))["projectV2"]
    fields = {}
    for f in proj["fields"]["nodes"]:
        if not f:
            continue
        entry = {"id": f["id"], "name": f["name"]}
        if "options" in f:
            entry["options"] = {o["name"]: o["id"] for o in f["options"]}
        fields[f["name"]] = entry
    cfg = {"project_id": proj["id"], "title": proj["title"], "url": proj["url"],
           "owner": OWNER, "number": int(NUMBER), "type": PTYPE, "fields": fields}
    CFG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CFG_PATH.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return cfg


def load_cfg() -> dict:
    if not CFG_PATH.exists():
        return init()
    return json.loads(CFG_PATH.read_text(encoding="utf-8"))


# --- items ------------------------------------------------------------------

_Q_ITEMS = """
query($owner:String!, $number:Int!, $cursor:String){
  %ROOT%(login:$owner){
    projectV2(number:$number){
      items(first:100, after:$cursor){
        pageInfo{ hasNextPage endCursor }
        nodes{
          id
          content{
            __typename
            ... on DraftIssue { title body }
            ... on Issue { title number url state }
            ... on PullRequest { title number url state }
          }
          fieldValues(first:30){ nodes{
            __typename
            ... on ProjectV2ItemFieldSingleSelectValue { name field{ ... on ProjectV2FieldCommon{ name } } }
            ... on ProjectV2ItemFieldTextValue      { text field{ ... on ProjectV2FieldCommon{ name } } }
          }}
        }
      }
    }
  }
}
""".replace("%ROOT%", "organization" if PTYPE == "org" else "user")


def list_items() -> list[dict]:
    _require_cfg()
    out, cursor = [], None
    while True:
        data = _gql(_Q_ITEMS, owner=OWNER, number=int(NUMBER), cursor=cursor or "")
        proj = (data.get("organization") or data.get("user"))["projectV2"]
        for n in proj["items"]["nodes"]:
            content = n.get("content") or {}
            fv = {}
            for v in n["fieldValues"]["nodes"]:
                if not v or "field" not in v or not v.get("field"):
                    continue
                name = v["field"].get("name")
                fv[name] = v.get("name", v.get("text"))
            out.append({
                "id": n["id"],
                "title": content.get("title", "(untitled)"),
                # Draft-issue body. Present so a read can SEE what a card
                # already says: without it, "the body is empty" was a claim the
                # data could not support, and `edit` blind-overwrote whatever
                # was there (found via a bad edit on a real card). Real Issues
                # keep their body in the issue and report None here.
                "body": content.get("body"),
                "url": content.get("url"),
                "status": fv.get("Status"),
                "priority": fv.get("Priority"),
                "size": fv.get("Size") or fv.get("Effort"),
                "fields": fv,
            })
        pi = proj["items"]["pageInfo"]
        if not pi["hasNextPage"]:
            break
        cursor = pi["endCursor"]
    return out


def find(items: list[dict], ref: str) -> dict | None:
    """Resolve a ref to its item. `items` is a snapshot from `list_items()`.

    A project item id (PVTI_...) is used DIRECTLY, without requiring it be
    present in `items` — the Projects list read is eventually consistent, so
    `add` followed immediately by `edit --id` can fail to see the just-created
    item for a few seconds (2026-09-15/16). A title lookup still needs the
    list (there's no other way to resolve a substring), so on a miss the
    caller should re-fetch once before giving up — see `find_retry`.
    """
    ref = ref.strip()
    if ref.startswith("PVTI_"):
        exact = [i for i in items if i["id"] == ref]
        return exact[0] if exact else {"id": ref, "title": ref}
    hits = [i for i in items if ref.lower() in i["title"].lower()]
    return hits[0] if len(hits) == 1 else None


def find_retry(ref: str, items: list[dict] | None = None) -> dict | None:
    """Like `find`, but on a title-lookup miss re-fetches the live list once
    (bypassing whatever snapshot the caller already had) before giving up."""
    items = items if items is not None else list_items()
    hit = find(items, ref)
    if hit is None and not ref.strip().startswith("PVTI_"):
        hit = find(list_items(), ref)
    return hit


# --- mutations --------------------------------------------------------------

_M_SET_SELECT = """
mutation($project:ID!, $item:ID!, $field:ID!, $option:String!){
  updateProjectV2ItemFieldValue(input:{
    projectId:$project, itemId:$item, fieldId:$field,
    value:{ singleSelectOptionId:$option }
  }){ projectV2Item{ id } }
}
"""


def set_select(cfg, item_id, field_name, value):
    field = cfg["fields"].get(field_name)
    if not field:
        raise SystemExit(f"no field '{field_name}' on the board (have: {list(cfg['fields'])})")
    opts = field.get("options", {})
    # tolerate P0 vs "P0 - Critical" style option names
    opt_id = opts.get(value) or next((oid for name, oid in opts.items()
                                      if value.lower() in name.lower()), None)
    if not opt_id:
        raise SystemExit(f"no option '{value}' on {field_name} (have: {list(opts)})")
    _gql(_M_SET_SELECT, project=cfg["project_id"], item=item_id, field=field["id"], option=opt_id)
    if field_name == "Status":
        snapshot_ack(item_id, value)


def snapshot_ack(item_id: str, status: str) -> None:
    """Record MY OWN status change in the poll snapshot so it isn't alerted.

    The supervisor polls the board every tick and TG-alerts each card that
    entered Ready. That is right for a card the operator drags on their phone
    and useless for one the Director just moved itself — the bot pinging about
    its own action is noise.

    Deliberately narrow: ONLY the item just touched is updated. Rewriting the
    whole snapshot here would also swallow a move the operator made in the
    meantime, turning a noise fix into a missed handoff.
    """
    try:
        if not SNAP_PATH.exists():
            return
        items = json.loads(SNAP_PATH.read_text(encoding="utf-8"))
        for it in items:
            if it.get("id") == item_id:
                it["status"] = status
                break
        else:
            return  # unknown to the snapshot; next poll records it normally
        SNAP_PATH.write_text(json.dumps(items, indent=2, ensure_ascii=False) + "\n",
                             encoding="utf-8")
    except Exception:
        pass  # never let snapshot upkeep break a board write


# --- create / seed ----------------------------------------------------------

_M_ADD_DRAFT = """
mutation($project:ID!, $title:String!, $body:String){
  addProjectV2DraftIssue(input:{ projectId:$project, title:$title, body:$body }){
    projectItem{ id }
  }
}
"""


def add_draft(cfg, title, body="") -> str:
    data = _gql(_M_ADD_DRAFT, project=cfg["project_id"], title=title, body=body)
    return data["addProjectV2DraftIssue"]["projectItem"]["id"]


# Editing a card's BODY. Without this the only way to correct a card was to add
# a replacement and retire the original, which is why the board accumulated
# "SUPERSEDED: …" pairs. Note the mutation takes the DraftIssue id, NOT the
# project-item id the rest of this module passes around, so it is fetched first.
_Q_DRAFT_ID = """
query($id:ID!){ node(id:$id){ ... on ProjectV2Item { content { ... on DraftIssue { id body } } } } }
"""

_M_EDIT_DRAFT = """
mutation($id:ID!, $title:String, $body:String){
  updateProjectV2DraftIssue(input:{ draftIssueId:$id, title:$title, body:$body }){
    draftIssue{ id }
  }
}
"""


def edit_draft(item_id, title=None, body=None, force=False) -> str:
    """Rewrite a draft card's body and/or title. Only draft cards, not issues.

    A body rewrite is DESTRUCTIVE and GitHub keeps no version history for a
    draft issue, so replacing a non-empty body refuses unless `force`. On
    2026-08-22 a card's existing body was overwritten on the strength of a read
    that could not see bodies at all — the tool now looks before it writes, and
    prints what it is about to discard so it can be recovered from the log.
    """
    node = _gql(_Q_DRAFT_ID, id=item_id)["node"]
    content = (node or {}).get("content") or {}
    draft_id = content.get("id")
    if not draft_id:
        raise RuntimeError(f"{item_id} is not a draft card (an issue's body lives in the issue)")
    existing = (content.get("body") or "").strip()
    if body is not None and existing and not force:
        raise RuntimeError(
            f"{item_id} already has a body ({len(existing)} chars) and GitHub keeps no history for it. "
            f"Read it first, merge your text into it, and re-run with --force.\n"
            f"--- current body ---\n{content.get('body')}\n--- end ---"
        )
    kw = {"id": draft_id}
    if title is not None:
        kw["title"] = title
    if body is not None:
        kw["body"] = body
    _gql(_M_EDIT_DRAFT, **kw)
    return draft_id


# Map our board.json lanes/stages to whatever Status options the board actually
# has (fuzzy, case-insensitive) so seeding works before the columns are renamed.
_STATUS_ALIASES = {
    "backlog": ["backlog", "todo", "to do"],
    "asap": ["do asap", "asap", "ready", "todo"],
    "wip": ["in progress", "execution", "doing"],
    "done": ["done", "prod", "complete"],
}


def _match_status(cfg, lane) -> str | None:
    opts = list(cfg["fields"].get("Status", {}).get("options", {}).keys())
    for cand in _STATUS_ALIASES.get(lane, [lane]):
        for o in opts:
            if cand == o.lower():
                return o
    return None


def sync_from_board(cfg) -> dict:
    """Push memory/tasks/board.json tasks onto the GitHub Project (idempotent by title)."""
    bpath = REPO_ROOT / "memory" / "tasks" / "board.json"
    if not bpath.exists():
        raise SystemExit("no memory/tasks/board.json to seed from")
    board = json.loads(bpath.read_text(encoding="utf-8"))
    existing = {i["title"].strip().lower(): i["id"] for i in list_items()}
    created, updated = [], []
    for t in board.get("tasks", []):
        title = t["title"].strip()
        item_id = existing.get(title.lower())
        if item_id:
            updated.append(title)
        else:
            body_bits = []
            if t.get("notes"):
                body_bits.append(t["notes"])
            if t.get("refs"):
                body_bits.append("refs: " + ", ".join(t["refs"]))
            for b in t.get("blockers", []):
                body_bits.append("blocker: " + b.get("text", "") + (" — " + "; ".join(b.get("steps", [])) if b.get("steps") else ""))
            item_id = add_draft(cfg, title, "\n".join(body_bits))
            created.append(title)
        # ALWAYS reconcile fields (idempotent upsert), best-effort per field
        st = _match_status(cfg, t.get("lane", "backlog"))
        for field, val in (("Status", st), ("Priority", t.get("priority")), ("Size", t.get("effort"))):
            if not val or field not in cfg["fields"]:
                continue
            try:
                set_select(cfg, item_id, field, val)
            except (SystemExit, RuntimeError):
                pass
    return {"created": created, "updated": updated}


# --- render + poll ----------------------------------------------------------

def render(items: list[dict], cfg: dict) -> str:
    # column order follows the board's own Status option order when known
    status_order = list(cfg["fields"].get("Status", {}).get("options", {}).keys())
    def okey(i):
        s = i.get("status")
        return (status_order.index(s) if s in status_order else 99, i["title"].lower())
    items = sorted(items, key=okey)
    open_n = sum(1 for i in items if (i.get("status") or "").lower() not in ("done",))
    lines = [f"🗂️ **{cfg.get('title','Board')}** — {open_n} open · {len(items)} total"]
    cur = object()
    for i in items:
        s = i.get("status") or "(no status)"
        if s != cur:
            lines.append("")
            lines.append(f"**{s}**")
            cur = s
        p = i.get("priority") or ""
        icon = PRI_ICON.get((p or "").split()[0], "•") if p else "•"
        size = f"·{i['size']}" if i.get("size") else ""
        lines.append(f"{icon} {p}{size}  {i['title']}")
    return "\n".join(lines)


def poll() -> dict:
    """Diff current board vs last snapshot. Returns {changes:[...]} and rewrites snapshot.

    The snapshot now carries each card's BODY (list_items fetches it), which
    makes this git-tracked file a local mirror of every card. GitHub keeps no
    version history for a draft issue, so before this the only copy of a card's
    body lived on github.com and a bad `edit` was unrecoverable. The supervisor
    polls every tick, so the worst case is now one tick of loss.
    """
    items = list_items()
    prev = {}
    if SNAP_PATH.exists():
        try:
            prev = {x["id"]: x for x in json.loads(SNAP_PATH.read_text(encoding="utf-8"))}
        except Exception:
            prev = {}
    changes = []
    for i in items:
        o = prev.get(i["id"])
        if not o:
            changes.append({"kind": "added", "title": i["title"], "status": i.get("status")})
        elif o.get("status") != i.get("status"):
            kind = "queued" if (i.get("status") or "").lower() in ("ready", "do asap", "asap") else "moved"
            changes.append({"kind": kind, "title": i["title"],
                            "from": o.get("status"), "to": i.get("status")})
    for oid, o in prev.items():
        if oid not in {i["id"] for i in items}:
            changes.append({"kind": "removed", "title": o.get("title")})
    SNAP_PATH.write_text(json.dumps(items, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return {"changes": changes}


# --- CLI --------------------------------------------------------------------

def main(argv):
    cmd = argv[1].lower() if len(argv) > 1 else "render"
    if cmd == "init":
        cfg = init()
        print(f"cached {cfg['title']} — fields: {', '.join(cfg['fields'])}")
        return 0
    if cmd == "fields":
        print(json.dumps(load_cfg()["fields"], indent=2, ensure_ascii=False))
        return 0
    if cmd in ("render", "show", "list"):
        cfg = load_cfg()
        print(render(list_items(), cfg))
        return 0
    if cmd == "poll":
        print(json.dumps(poll(), ensure_ascii=False))
        return 0
    if cmd in ("add", "draft"):
        # add "title" ["body"] | add "title" --body-file <path>
        # --body-file exists so a real card body can be written in ONE call.
        # The create-then-`edit` two-step loses a race: Projects list reads are
        # eventually consistent, so an `edit` fired straight after `add` often
        # cannot see the new item yet and dies with "no unique item" — which
        # left a DECISION card on the board reading "placeholder" (2026-08-19).
        if len(argv) < 3:
            print('usage: add "title" ["body"] | add "title" --body-file <path>',
                  file=sys.stderr); return 2
        cfg = load_cfg()
        if len(argv) > 4 and argv[3] == "--body-file":
            body = Path(argv[4]).read_text(encoding="utf-8")
        elif len(argv) > 3 and argv[3] == "--body-file":
            print("--body-file needs a value", file=sys.stderr); return 2
        else:
            body = argv[3] if len(argv) > 3 else ""
        iid = add_draft(cfg, argv[2], body)
        print(f"added draft item {iid}: {argv[2]}")
        return 0
    if cmd in ("edit", "body"):
        # edit <item> --body-file <path> | --body "<text>" [--title "<text>"]
        # --body-file is the safe form: a body passed as an argv string goes
        # through the shell, and a card body full of backticks and `$` gets
        # command-substituted before it ever reaches here.
        if len(argv) < 4:
            print('usage: edit <item> --body-file <path> | --body "<text>" [--title "<text>"]',
                  file=sys.stderr); return 2
        it = find_retry(argv[2])
        if not it:
            print(f"no unique item for '{argv[2]}'", file=sys.stderr); return 2
        title = body = None
        force = "--force" in argv[3:]
        rest = [a for a in argv[3:] if a != "--force"]
        i = 0
        while i < len(rest):
            flag, val = rest[i], rest[i + 1] if i + 1 < len(rest) else None
            if val is None:
                print(f"{flag} needs a value", file=sys.stderr); return 2
            if flag == "--body":
                body = val
            elif flag == "--body-file":
                body = Path(val).read_text(encoding="utf-8")
            elif flag == "--title":
                title = val
            else:
                print(f"unknown flag: {flag}", file=sys.stderr); return 2
            i += 2
        if title is None and body is None:
            print("nothing to change", file=sys.stderr); return 2
        try:
            edit_draft(it["id"], title=title, body=body, force=force)
        except RuntimeError as e:
            print(str(e), file=sys.stderr)
            return 2
        print(f"edited '{it['title']}'" + (" (title changed)" if title else ""))
        return 0
    if cmd in ("sync", "seed"):
        cfg = load_cfg()
        res = sync_from_board(cfg)
        print(f"created {len(res['created'])}, reconciled {len(res['updated'])} existing")
        for t in res["created"]:
            print(f"  + {t}")
        return 0
    if cmd in ("move", "set"):
        cfg = load_cfg()
        items = list_items()
        if cmd == "move":
            if len(argv) < 4:
                print("usage: move <item> \"<status>\"", file=sys.stderr); return 2
            it = find_retry(argv[2], items)
            if not it:
                print(f"no unique item for '{argv[2]}'", file=sys.stderr); return 2
            set_select(cfg, it["id"], "Status", argv[3])
            print(f"moved '{it['title']}' -> {argv[3]}")
            return 0
        else:  # set <item> <field> <value>
            if len(argv) < 5:
                print("usage: set <item> <field> \"<value>\"", file=sys.stderr); return 2
            it = find_retry(argv[2], items)
            if not it:
                print(f"no unique item for '{argv[2]}'", file=sys.stderr); return 2
            set_select(cfg, it["id"], argv[3], argv[4])
            print(f"set {argv[3]}={argv[4]} on '{it['title']}'")
            return 0
    print(f"unknown command: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except SystemExit:
        raise
    except Exception as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)
