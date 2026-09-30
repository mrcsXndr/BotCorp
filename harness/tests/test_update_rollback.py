"""v0.8.2: cumulative releases, real notes, and roll back.

CLI (temp BOTCORP_HOME; the installed version is this checkout's botcorp.json):
- `update --apply <tag>` on a release older than the installed one is refused
  with the --rollback hint; `update --rollback <tag>` only takes an older one
  and marks it apply_requested + rollback; one request at a time (a new
  request puts the other back to pending); `--cancel` undoes a request;
  `--skip` refuses an older release; the list prints the installed version.
- the cockpit's POST /api/updates/<tag>/rollback|cancel need the approval token.

daemon/update.ps1 in a throwaway git checkout (a bare origin, tags v1.0.0 /
v1.1.0 / v1.2.0, each with its own CHANGELOG.md section and a stub smoke.ps1):
- -Apply of an older tag rolls back: HEAD moves, harness.json records it, the
  releases above it that were applied are pending again;
- -Apply of a newer tag marks the release it skipped over `included` and
  records the version it left (so it can be rolled back to), with notes;
- a failing smoke test puts HEAD back and marks the release failed;
- -Check records a new release with summary / notes from its own changelog
  and reads the notes of an entry recorded before v0.8.2 again (what/why/value go);
- -ParseChangelog prints what core/changelog.mjs extracts.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from test_cockpit_api import Cockpit, needs_win_node
from test_operator_only import ASSEMBLY, cli, make_bot, needs_node, operator_env

INSTALLED = json.loads((ASSEMBLY / "botcorp.json").read_text(encoding="utf-8"))["version"]
OLD, OLDER, NEW, NEWER = "v0.0.5", "v0.0.4", "v99.0.0", "v99.1.0"
needs_pwsh_git = pytest.mark.skipif(sys.platform != "win32" or not shutil.which("pwsh") or not shutil.which("git") or not shutil.which("node"),
                                    reason="Windows with pwsh, git and node on PATH")


def _updates(rt: Path) -> dict:
    return {r["tag"]: r for r in json.loads((rt / "state" / "updates.json").read_text(encoding="utf-8"))["releases"]}


@pytest.fixture
def ubox(tmp_path):
    rt, bots = tmp_path / "rt", tmp_path / "bots"
    (rt / "state").mkdir(parents=True)
    bots.mkdir()
    make_bot(bots, "t")
    rel = [{"tag": OLDER, "status": "applied"}, {"tag": OLD, "status": "included"}, {"tag": f"v{INSTALLED}", "status": "applied"},
           {"tag": NEW, "status": "apply_requested"}, {"tag": NEWER, "status": "pending"}]
    (rt / "state" / "updates.json").write_text(json.dumps({"releases": rel}), encoding="utf-8")
    return rt, bots, operator_env(rt, bots)


@needs_node
def test_apply_refuses_an_older_release_and_points_at_rollback(ubox):
    rt, bots, env = ubox
    r = cli(env, "update", "--apply", OLD)
    assert r.returncode == 1 and f"update --rollback {OLD}" in r.stderr, r.stdout + r.stderr
    assert _updates(rt)[OLD]["status"] == "included"
    r = cli(env, "update", "--apply", f"v{INSTALLED}")
    assert r.returncode == 1 and "the installed version" in r.stderr
    r = cli(env, "update", "--rollback", NEWER)
    assert r.returncode == 1 and f"update --apply {NEWER}" in r.stderr
    r = cli(env, "update", "--skip", OLD)
    assert r.returncode == 1 and "only a newer release is skipped" in r.stderr


@needs_node
def test_rollback_is_one_request_and_replaces_the_other(ubox):
    rt, bots, env = ubox
    r = cli(env, "update", "--rollback", OLD, "--by", "local")
    assert r.returncode == 0, r.stdout + r.stderr
    assert f"{NEW} request replaced by {OLD}" in r.stdout and "migrations are not undone" in r.stdout
    u = _updates(rt)
    assert u[OLD]["status"] == "apply_requested" and u[OLD]["rollback"] is True and u[OLD]["decided_by"] == "local"
    assert u[NEW]["status"] == "pending" and u[NEW]["superseded_by"] == OLD
    assert [t for t, x in u.items() if x["status"] == "apply_requested"] == [OLD]
    # an apply now replaces the roll back, and the rollback mark goes with it
    assert cli(env, "update", "--apply", NEWER).returncode == 0
    u = _updates(rt)
    assert u[OLD]["status"] == "pending" and "rollback" not in u[OLD]
    assert u[NEWER]["status"] == "apply_requested" and "rollback" not in u[NEWER]
    # asking again is a no-op, not a second entry
    r = cli(env, "update", "--apply", NEWER)
    assert r.returncode == 0 and "already requested" in r.stdout


@needs_node
def test_cancel_puts_a_request_back_and_refuses_anything_else(ubox):
    rt, bots, env = ubox
    r = cli(env, "update", "--cancel", NEW)
    assert r.returncode == 0 and "cancelled" in r.stdout, r.stdout + r.stderr
    assert _updates(rt)[NEW]["status"] == "pending"
    r = cli(env, "update", "--cancel", NEW)
    assert r.returncode == 1 and "nothing to cancel" in r.stderr
    r = cli(env, "update", "--apply", NEW, "--cancel", NEW)
    assert r.returncode == 2 and "not --apply and --cancel" in r.stderr


@needs_node
def test_the_list_reads_cumulative(ubox):
    rt, bots, env = ubox
    r = cli(env, "update")
    assert r.returncode == 0, r.stderr
    lines = r.stdout.splitlines()
    assert lines[0].split() == ["installed", f"v{INSTALLED}"]
    assert any(l.split()[:2] == ["requested", NEW] for l in lines)
    assert any(l.split()[:2] == ["available", NEWER] for l in lines)
    assert any(l.split()[:2] == ["history", OLD] and f"came with v{INSTALLED}" in l for l in lines)


@needs_win_node
def test_cockpit_rollback_and_cancel_routes_need_the_token(ubox):
    rt, bots, env = ubox
    c = Cockpit(env)
    try:
        assert c.call("POST", f"/api/updates/{OLD}/rollback")[0] == 403
        assert c.call("POST", f"/api/updates/{OLD}/nuke", token=True)[0] == 404
        code, r = c.call("POST", f"/api/updates/{OLD}/rollback", token=True)
        assert code == 200 and r["ok"], r
        assert _updates(rt)[OLD]["rollback"] is True and _updates(rt)[OLD]["decided_by"] == "local"
        code, r = c.call("POST", f"/api/updates/{OLD}/cancel", token=True)
        assert code == 200 and _updates(rt)[OLD]["status"] == "pending", r
        code, r = c.call("GET", "/api/updates")
        assert code == 200 and r["current"]["tag"] == f"v{INSTALLED}" and [x["tag"] for x in r["history"]] == [OLD, OLDER], r
    finally:
        c.close()


# ---- daemon/update.ps1 in a throwaway checkout ---------------------------------------------------

def _git(cwd: Path, *args: str) -> str:
    r = subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", *args],
                       cwd=str(cwd), capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


SECTION = {"v1.0.0": "First one.\n\n- **Base.** The start.\n",
           "v1.1.0": "The middle release.\n\n- **Middle.** Adds the middle\n  part.\n\nUpgrading: nothing to do.\n",
           "v1.2.0": "The newest release, with an → arrow.\n\n- **Top.** Adds the top.\n- **Also.** And more.\n"}


def _repo(tmp_path: Path, failing_smoke: tuple = (), migrations: dict | None = None) -> tuple[Path, Path]:
    """-> (checkout, runtime). The checkout's daemon/ is this repo's update.ps1 and its helpers.
    migrations: {tag: {file name: script}} added to harness/migrations/ from that tag on."""
    src = tmp_path / "src"
    (src / "daemon").mkdir(parents=True)
    (src / "core").mkdir()
    for f in ("update.ps1", "_common.ps1", "_paths.ps1", "vault.ps1"):
        shutil.copy2(ASSEMBLY / "daemon" / f, src / "daemon" / f)
    shutil.copy2(ASSEMBLY / "core" / "changelog.mjs", src / "core" / "changelog.mjs")
    (src / ".gitattributes").write_text("* -text\n", encoding="utf-8")
    _git(src, "init", "-q", "-b", "main")
    changelog = "# Changelog\n"
    for tag in ("v1.0.0", "v1.1.0", "v1.2.0"):
        changelog = changelog.replace("# Changelog\n", f"# Changelog\n\n## {tag}\n\n{SECTION[tag]}", 1)
        (src / "CHANGELOG.md").write_text(changelog, encoding="utf-8")
        (src / "botcorp.json").write_text(json.dumps({"version": tag[1:], "botYamlSchema": 1}), encoding="utf-8")
        (src / "daemon" / "smoke.ps1").write_text(f"Write-Output 'smoke {tag}'\nexit {1 if tag in failing_smoke else 0}\n", encoding="utf-8")
        for name, script in (migrations or {}).get(tag, {}).items():
            (src / "harness" / "migrations").mkdir(parents=True, exist_ok=True)
            (src / "harness" / "migrations" / name).write_text(script, encoding="utf-8")
        _git(src, "add", "-A")
        _git(src, "commit", "-q", "-m", tag)
        _git(src, "tag", tag)
    origin = tmp_path / "origin.git"
    _git(tmp_path, "clone", "-q", "--bare", str(src), str(origin))
    work = tmp_path / "work"
    _git(tmp_path, "clone", "-q", str(origin), str(work))
    rt = tmp_path / "rt"
    (rt / "state").mkdir(parents=True)
    (tmp_path / "bots").mkdir()
    return work, rt


def _ps(work: Path, rt: Path, *args: str) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "TELEGRAM_", "BOT_"))}
    env.update({"BOTCORP_HOME": str(rt), "BOTCORP_BOTS_DIR": str(rt.parent / "bots"), "BOT_TG_MUTE": "1"})
    return subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(work / "daemon" / "update.ps1"), *args],
                          capture_output=True, text=True, timeout=240, env=env, cwd=str(work))


def _seed(rt: Path, releases: list) -> None:
    (rt / "state" / "updates.json").write_text(json.dumps({"releases": releases}), encoding="utf-8")


def _head_tag(work: Path) -> str:
    return _git(work, "describe", "--tags", "--exact-match", "HEAD")


@needs_pwsh_git
def test_apply_of_an_older_tag_rolls_back(tmp_path):
    work, rt = _repo(tmp_path)
    _git(work, "checkout", "-q", "--detach", "v1.2.0")
    _seed(rt, [{"tag": "v1.0.0", "status": "applied"}, {"tag": "v1.1.0", "status": "apply_requested", "rollback": True},
               {"tag": "v1.2.0", "status": "applied"}])
    r = _ps(work, rt, "-Apply", "-Tag", "v1.1.0")
    assert r.returncode == 0, r.stdout + r.stderr
    assert _head_tag(work) == "v1.1.0"
    assert json.loads((rt / "state" / "harness.json").read_text(encoding="utf-8"))["tag"] == "v1.1.0"
    u = _updates(rt)
    assert u["v1.1.0"]["status"] == "applied" and u["v1.1.0"]["from"] == "v1.2.0"
    assert u["v1.2.0"]["status"] == "pending" and u["v1.2.0"]["rolled_back_to"] == "v1.1.0"
    assert u["v1.0.0"]["status"] == "applied"
    assert "ROLLED BACK v1.2.0 -> v1.1.0" in (rt / "daemon.log").read_text(encoding="utf-8")


@needs_pwsh_git
def test_a_successful_apply_removes_a_stale_failure_card(tmp_path):
    work, rt = _repo(tmp_path)
    _git(work, "checkout", "-q", "--detach", "v1.0.0")
    _seed(rt, [{"tag": "v1.1.0", "status": "apply_requested"}])
    card = rt / "state" / "update_failed_card.md"
    card.write_text("Harness update v0.7.7 -> v0.8.0 failed\n", encoding="utf-8")
    r = _ps(work, rt, "-Apply", "-Tag", "v1.1.0")
    assert r.returncode == 0, r.stdout + r.stderr
    assert not card.exists()


@needs_pwsh_git
def test_apply_of_a_newer_tag_includes_the_one_between_and_records_where_it_came_from(tmp_path):
    work, rt = _repo(tmp_path)
    _git(work, "checkout", "-q", "--detach", "v1.0.0")
    _seed(rt, [{"tag": "v1.1.0", "status": "pending"}, {"tag": "v1.2.0", "status": "apply_requested"}])
    r = _ps(work, rt, "-Apply", "-Tag", "v1.2.0")
    assert r.returncode == 0, r.stdout + r.stderr
    assert _head_tag(work) == "v1.2.0"
    u = _updates(rt)
    assert u["v1.2.0"]["status"] == "applied"
    assert u["v1.1.0"]["status"] == "included" and u["v1.1.0"]["included_in"] == "v1.2.0"
    # the version it left is recorded, with its own notes, so it can be rolled back to
    assert u["v1.0.0"]["status"] == "applied" and u["v1.0.0"]["summary"] == "First one."
    assert u["v1.0.0"]["notes"] == [{"title": "Base", "text": "The start."}]
    # the same tag again: already checked out, nothing moves
    r = _ps(work, rt, "-Apply", "-Tag", "v1.2.0")
    assert r.returncode == 0 and _head_tag(work) == "v1.2.0"


@needs_pwsh_git
def test_a_failed_smoke_on_a_roll_back_goes_back(tmp_path):
    work, rt = _repo(tmp_path, failing_smoke=("v1.0.0",))
    _git(work, "checkout", "-q", "--detach", "v1.2.0")
    _seed(rt, [{"tag": "v1.0.0", "status": "apply_requested", "rollback": True}, {"tag": "v1.2.0", "status": "applied"}])
    r = _ps(work, rt, "-Apply", "-Tag", "v1.0.0")
    assert r.returncode == 1
    assert _head_tag(work) == "v1.2.0"
    u = _updates(rt)
    assert u["v1.0.0"]["status"] == "failed" and u["v1.0.0"]["fail_reason"] == "smoke failed"
    assert u["v1.2.0"]["status"] == "applied"
    assert not (rt / "state" / "harness.json").exists()


@needs_pwsh_git
def test_a_failed_migration_fails_the_apply_and_goes_back(tmp_path):
    # Code review 2026-09-30, D14: a migration's non-zero exit used to be logged
    # and the release marked applied with the schema stamped past it, so it never ran again.
    ok = "Set-Content -Path (Join-Path $env:BOTCORP_HOME 'mig-001.ran') -Value 1\nexit 0\n"
    bad = "Set-Content -Path (Join-Path $env:BOTCORP_HOME 'mig-002.ran') -Value 1\nexit 3\n"
    after = "Set-Content -Path (Join-Path $env:BOTCORP_HOME 'mig-003.ran') -Value 1\nexit 0\n"
    work, rt = _repo(tmp_path, migrations={"v1.2.0": {"001-ok.ps1": ok, "002-bad.ps1": bad, "003-after.ps1": after}})
    _git(work, "checkout", "-q", "--detach", "v1.1.0")
    _seed(rt, [{"tag": "v1.1.0", "status": "applied"}, {"tag": "v1.2.0", "status": "apply_requested"}])
    r = _ps(work, rt, "-Apply", "-Tag", "v1.2.0")
    assert r.returncode == 1, r.stdout + r.stderr
    assert _head_tag(work) == "v1.1.0"
    u = _updates(rt)
    assert u["v1.2.0"]["status"] == "failed" and u["v1.2.0"]["fail_reason"] == "migration failed", u["v1.2.0"]
    assert "002-bad.ps1" in u["v1.2.0"]["fail_detail"] and "exit=3" in u["v1.2.0"]["fail_detail"]
    assert (rt / "mig-001.ran").exists() and (rt / "mig-002.ran").exists()
    assert not (rt / "mig-003.ran").exists(), "a migration after the failed one ran"
    assert not (rt / "state" / "harness.json").exists(), "the schema was stamped past a failed migration"


@needs_pwsh_git
def test_check_records_notes_and_refreshes_a_pre_v082_entry(tmp_path):
    work, rt = _repo(tmp_path)
    _git(work, "checkout", "-q", "--detach", "v1.0.0")
    _seed(rt, [{"tag": "v1.1.0", "status": "pending", "what": ["Adds the middle"], "why": ["see changelog"], "value": ["see changelog"]}])
    r = _ps(work, rt, "-Check")
    assert r.returncode == 0, r.stdout + r.stderr
    u = _updates(rt)
    assert set(u) == {"v1.1.0", "v1.2.0"}
    mid = u["v1.1.0"]
    assert mid["summary"] == "The middle release." and mid["notes"] == [{"title": "Middle", "text": "Adds the middle part."}]
    assert mid["notes_tail"] == "Upgrading: nothing to do." and not {"what", "why", "value"} & set(mid)
    top = u["v1.2.0"]
    assert top["status"] == "pending" and top["summary"] == "The newest release, with an → arrow."
    assert [n["title"] for n in top["notes"]] == ["Top", "Also"]


@needs_pwsh_git
def test_parse_changelog_seam_matches_the_extractor(tmp_path):
    work, rt = _repo(tmp_path)
    r = _ps(work, rt, "-ParseChangelog", str(ASSEMBLY / "CHANGELOG.md"), "-Tag", "v0.8.1")
    assert r.returncode == 0, r.stdout + r.stderr
    got = json.loads(r.stdout)
    want = json.loads(subprocess.run(["node", str(ASSEMBLY / "core" / "changelog.mjs"), str(ASSEMBLY / "CHANGELOG.md"), "v0.8.1"],
                                     capture_output=True, text=True, timeout=60).stdout)
    assert got["summary"] == want["summary"] and got["notes"] == want["notes"]
