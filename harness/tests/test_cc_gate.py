"""R3: the Claude Code update gate (daemon/cc.ps1).

Bots run a BotCorp-owned copy of Claude Code, <BOTCORP_HOME>/cc/<v>/claude.exe,
named by the pin in <BOTCORP_HOME>/state/cc.json (test_cc_pin.py covers the
resolvers). This file covers how the pin moves:

- `-Check` bootstraps (no cc.json: copy the global exe, pin it `by: bootstrap`)
  and STAGES a newer global version as the candidate; it never promotes;
- a staged copy is immutable: it lands in a new dir and is renamed into
  <rt>/cc/<v>/claude.exe; an existing one with the source's sha256 is reused,
  one with a different sha256 is never written over;
- a rejected version is never staged again; a newer one supersedes it;
- the pin moves only when every non-SKIP check of the 8 passed
  (Get-CcPromoteDecision); the second failure rejects the version and tells a
  human exactly once;
- prune keeps the pin, previous[0..1], the candidate and any exe a process runs;
- `-Rollback [-To <v>]` moves the pin to a previous version and rejects the one
  it replaced.

The global install is simulated with private copies of the three real (signed)
builds in ~/.local/share/claude/versions, read once per session and never
written: an unsigned stand-in exe is blocked at random by Windows Smart App
Control, and the real builds also exercise the real signature check.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
COMMON = ASSEMBLY / "daemon" / "_common.ps1"
CC = ASSEMBLY / "daemon" / "cc.ps1"
REAL_VERSIONS = Path(os.environ.get("USERPROFILE", "")) / ".local" / "share" / "claude" / "versions"


def _vkey(v: str) -> tuple:
    return tuple(int(x) for x in v.split("."))


def _real_versions() -> list:
    try:
        vs = [p.name for p in REAL_VERSIONS.iterdir() if p.is_file() and re.fullmatch(r"\d+\.\d+\.\d+", p.name)]
    except OSError:
        return []
    return sorted(vs, key=_vkey)[-3:]


VERS = _real_versions()
V1, V2, V3 = VERS if len(VERS) == 3 else ("0.0.1", "0.0.2", "0.0.3")

needs_pwsh = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None, reason="Windows with pwsh on PATH")
needs_builds = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None or len(VERS) < 3,
                                  reason="Windows, pwsh and 3 Claude Code builds in ~/.local/share/claude/versions")


@pytest.fixture(scope="session")
def builds(tmp_path_factory):
    """version -> a private copy of that real build (the global files are only read)."""
    root = tmp_path_factory.mktemp("ccbuilds")
    out = {}
    for v in VERS:
        dst = root / v / "claude.exe"
        dst.parent.mkdir()
        shutil.copyfile(REAL_VERSIONS / v, dst)
        out[v] = dst
    yield out
    shutil.rmtree(root, ignore_errors=True)


@pytest.fixture
def box(tmp_path, builds):
    """A temp runtime + a fake profile whose global install is `native` plus `versions`."""
    made = []

    def make(sub: str = "", *, native: str | None = V1, versions: tuple = (V1,)) -> dict:
        base = tmp_path / sub if sub else tmp_path
        rt = base / "rt"
        (rt / "state").mkdir(parents=True)
        profile = base / "profile"
        (profile / ".local" / "bin").mkdir(parents=True)
        if native:
            os.link(builds[native], profile / ".local" / "bin" / "claude.exe")
        vdir = profile / ".local" / "share" / "claude" / "versions"
        vdir.mkdir(parents=True)
        for v in versions:
            os.link(builds[v], vdir / v)
        bots = base / "bots"
        bots.mkdir()
        env = {k: v for k, v in os.environ.items() if k not in ("BOTCORP_CLAUDE_EXE",)}
        env.update({"BOTCORP_HOME": str(rt), "USERPROFILE": str(profile), "BOTCORP_BOTS_DIR": str(bots), "BOT_TG_MUTE": "1"})
        b = {"env": env, "rt": rt, "profile": profile, "versions": vdir, "bots": bots, "builds": builds}
        made.append(b)
        return b
    yield make
    for b in made:   # the store holds 250 MB copies; give the disk back
        shutil.rmtree(b["rt"] / "cc", ignore_errors=True)


def _sha(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _same(a: object, b: Path) -> bool:
    return os.path.normcase(os.path.abspath(str(a))) == os.path.normcase(os.path.abspath(str(b)))


def _cc(b: dict, *args: str, env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(CC), *args],
                          capture_output=True, text=True, timeout=300, cwd=str(ASSEMBLY), env=env or b["env"])


def _state(b: dict) -> dict:
    return json.loads((b["rt"] / "state" / "cc.json").read_text(encoding="utf-8-sig"))


def _write_state(b: dict, st: dict) -> None:
    (b["rt"] / "state" / "cc.json").write_text(json.dumps(st), encoding="utf-8")


def _ps(body: str, env: dict | None = None) -> str:
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", f". '{COMMON}'\n{body}"],
                       capture_output=True, text=True, timeout=180, cwd=str(ASSEMBLY), env=env)
    assert r.returncode == 0, r.stderr + r.stdout
    lines = [ln for ln in r.stdout.splitlines() if ln.strip()]
    assert lines, r.stderr
    return lines[-1]


def _store(b: dict, version: str) -> Path:
    """Put <rt>/cc/<version>/claude.exe in place: the real build when there is one, else a few bytes."""
    exe = b["rt"] / "cc" / version / "claude.exe"
    exe.parent.mkdir(parents=True, exist_ok=True)
    if version in b["builds"]:
        os.link(b["builds"][version], exe)
    else:
        exe.write_bytes(f"stand-in {version}".encode())
    return exe


def _entry(b: dict, version: str) -> dict:
    exe = b["rt"] / "cc" / version / "claude.exe"
    return {"version": version, "exe": str(exe), "sha256": _sha(exe), "promoted_at": "2026-09-20T00:00:00Z"}


def _add_global(b: dict, version: str) -> None:
    os.link(b["builds"][version], b["versions"] / version)


# --- -Check: bootstrap, stage -------------------------------------------------------------
@needs_builds
def test_bootstrap_pins_current(box):
    b = box()
    native = b["profile"] / ".local" / "bin" / "claude.exe"
    before = (_sha(native), native.stat().st_mtime_ns)
    r = _cc(b, "-Check")
    assert r.returncode == 0, r.stdout + r.stderr
    st = _state(b)
    pinned = b["rt"] / "cc" / V1 / "claude.exe"
    assert st["pinned"]["version"] == V1 and st["pinned"]["by"] == "bootstrap"
    assert _same(st["pinned"]["exe"], pinned) and pinned.is_file()
    assert st["pinned"]["sha256"] == before[0] == _sha(pinned)
    assert not st.get("candidate")
    assert (_sha(native), native.stat().st_mtime_ns) == before   # the global install is only read
    # a second check keeps the pin as it is
    at = st["pinned"]["promoted_at"]
    assert _cc(b, "-Check").returncode == 0
    assert _state(b)["pinned"]["promoted_at"] == at


@needs_builds
def test_skip_signature_refused_outside_temp(box, tmp_path):
    b = box()
    other = tmp_path / "othertemp"
    other.mkdir()
    r = _cc(b, "-Check", "-SkipSignature", env={**b["env"], "TEMP": str(other), "TMP": str(other)})
    assert r.returncode == 2 and "SkipSignature" in r.stdout
    assert not (b["rt"] / "state" / "cc.json").exists()


@needs_builds
def test_newer_source_is_staged_not_promoted(box):
    b = box()
    assert _cc(b, "-Check").returncode == 0
    _add_global(b, V2)
    r = _cc(b, "-Check")
    assert r.returncode == 0, r.stdout + r.stderr
    st = _state(b)
    staged = b["rt"] / "cc" / V2 / "claude.exe"
    assert st["pinned"]["version"] == V1
    assert st["candidate"]["version"] == V2 and st["candidate"]["status"] == "staged"
    assert st["candidate"]["attempts"] == 0
    assert _same(st["candidate"]["exe"], staged) and st["candidate"]["sha256"] == _sha(b["versions"] / V2) == _sha(staged)
    # no temp staging dir is left behind
    assert sorted(p.name for p in (b["rt"] / "cc").iterdir()) == sorted([V1, V2], key=_vkey)
    # the next check neither re-stages nor re-copies
    mtime = staged.stat().st_mtime_ns
    assert _cc(b, "-Check").returncode == 0
    assert _state(b)["candidate"] == st["candidate"]
    assert staged.stat().st_mtime_ns == mtime


@needs_builds
def test_stage_reuses_matching_copy_and_never_overwrites_a_different_one(box):
    b = box("one")
    assert _cc(b, "-Check").returncode == 0
    _add_global(b, V2)
    # a copy with the source's sha256 already in the store: reused as it is
    good = _store(b, V2)
    mtime = good.stat().st_mtime_ns
    r = _cc(b, "-Check")
    assert r.returncode == 0, r.stdout + r.stderr
    assert _state(b)["candidate"]["status"] == "staged" and good.stat().st_mtime_ns == mtime
    # a different file under that version: never written over, nothing staged
    b2 = box("two")
    assert _cc(b2, "-Check").returncode == 0
    _add_global(b2, V2)
    odd = b2["rt"] / "cc" / V2 / "claude.exe"
    odd.parent.mkdir(parents=True)
    odd.write_bytes(b"not the source")
    assert _cc(b2, "-Check").returncode == 0
    assert odd.read_bytes() == b"not the source"
    assert not _state(b2).get("candidate")


@needs_builds
def test_rejected_version_not_restaged(box):
    b = box(versions=(V1, V2))
    _store(b, V1)
    _write_state(b, {"schema": 1, "pinned": {**_entry(b, V1), "by": "bootstrap"}, "previous": [], "candidate": None, "rejected": [V2]})
    r = _cc(b, "-Check")
    assert r.returncode == 0, r.stdout + r.stderr
    assert not _state(b).get("candidate")
    assert not (b["rt"] / "cc" / V2).exists()
    # a newer version supersedes the rejected one
    _add_global(b, V3)
    assert _cc(b, "-Check").returncode == 0
    st = _state(b)
    assert st["candidate"]["version"] == V3 and st["candidate"]["status"] == "staged"
    assert st["rejected"] == [V2]


# --- promote / fail -------------------------------------------------------------------------
def _checks(results: dict) -> list:
    return [{"n": n, "name": f"check {n}", "result": res, "detail": ""} for n, res in sorted(results.items())]


@needs_pwsh
@pytest.mark.parametrize("results,expected", [
    ({n: "PASS" for n in range(1, 9)}, "promote"),
    ({**{n: "PASS" for n in range(1, 9)}, 6: "SKIP"}, "promote"),
    ({**{n: "PASS" for n in range(1, 9)}, 4: "FAIL"}, "fail"),
    ({**{n: "PASS" for n in range(1, 9)}, 6: "SKIP", 8: "FAIL"}, "fail"),
    ({n: "PASS" for n in range(1, 8)}, "fail"),            # a run that stopped early never promotes
    ({n: "SKIP" for n in range(1, 9)}, "fail"),            # nothing was shown to work
    ({}, "fail"),
])
def test_promote_requires_all_non_skip_pass(results, expected):
    arr = json.dumps(_checks(results))
    got = _ps(f"Get-CcPromoteDecision -Checks @(ConvertFrom-Json -InputObject '{arr}')")
    assert got == expected


def _staged(box) -> dict:
    b = box()
    assert _cc(b, "-Check").returncode == 0
    _add_global(b, V2)
    assert _cc(b, "-Check").returncode == 0
    assert _state(b)["candidate"]["status"] == "staged"
    return b


def _bot(b: dict, name: str) -> Path:
    home = b["bots"] / name
    home.mkdir()
    (home / "bot.yaml").write_text(f"name: {name}\nharness:\n  service: manual\n  modules:\n    telegram: false\n", encoding="utf-8")
    return home


@needs_builds
def test_passing_run_promotes_and_keeps_previous(box, tmp_path):
    b = _staged(box)
    f = tmp_path / "checks.json"
    f.write_text(json.dumps(_checks({**{n: "PASS" for n in range(1, 9)}, 6: "SKIP"})), encoding="utf-8")
    r = _cc(b, "-Test", "-ChecksFile", str(f))
    assert r.returncode == 0, r.stdout + r.stderr
    st = _state(b)
    assert st["pinned"]["version"] == V2 and st["pinned"]["by"] == "gate"
    assert _same(st["pinned"]["exe"], b["rt"] / "cc" / V2 / "claude.exe")
    assert [p["version"] for p in st["previous"]] == [V1]
    assert st["candidate"]["status"] == "promoted" and len(st["candidate"]["checks"]) == 8


@needs_builds
def test_second_failure_rejects_and_alerts_once(box, tmp_path):
    b = _staged(box)
    home = _bot(b, "alpha")
    alerts = home / "memory" / "metrics" / "alerts.log"
    f = tmp_path / "checks.json"
    f.write_text(json.dumps(_checks({**{n: "PASS" for n in range(1, 9)}, 4: "FAIL"})), encoding="utf-8")

    assert _cc(b, "-Test", "-ChecksFile", str(f)).returncode == 0
    st = _state(b)
    assert st["candidate"]["status"] == "failed" and st["candidate"]["attempts"] == 1
    assert st["pinned"]["version"] == V1 and V2 not in st["rejected"]
    assert not alerts.exists()

    assert _cc(b, "-Test", "-ChecksFile", str(f)).returncode == 0
    st = _state(b)
    assert st["candidate"]["status"] == "rejected" and st["candidate"]["attempts"] == 2
    assert st["rejected"] == [V2] and st["pinned"]["version"] == V1
    lines = [ln for ln in alerts.read_text(encoding="utf-8-sig").splitlines() if ln.strip()]
    assert len(lines) == 1 and "HUMAN:" in lines[0] and V2 in lines[0] and "check 4" in lines[0]

    # nothing left to test, nothing said again, never staged again
    assert _cc(b, "-Test", "-ChecksFile", str(f)).returncode == 0
    assert _cc(b, "-Check").returncode == 0
    assert len([ln for ln in alerts.read_text(encoding="utf-8-sig").splitlines() if ln.strip()]) == 1
    assert _state(b)["candidate"]["status"] == "rejected"


@needs_builds
def test_test_refuses_without_canary(box):
    b = _staged(box)
    r = _cc(b, "-Test")   # no _canary at all
    assert r.returncode == 1, r.stdout + r.stderr
    c = _state(b)["candidate"]
    assert c["status"] == "failed" and "canary not provisioned" in c["detail"] and c["attempts"] == 0 and c["tested_at"]
    _bot(b, "_canary")    # a bot.yaml, but no vault
    r = _cc(b, "-Test")
    assert r.returncode == 1, r.stdout + r.stderr
    st = _state(b)
    assert st["candidate"]["status"] == "failed" and "no oauth_token" in st["candidate"]["detail"]
    assert st["candidate"]["attempts"] == 0 and st["pinned"]["version"] == V1 and not st["rejected"]
    assert not (b["rt"] / "state" / "cc.lock").exists()


@needs_builds
def test_checks_file_refused_outside_temp(box, tmp_path):
    b = _staged(box)
    f = tmp_path / "checks.json"
    f.write_text(json.dumps(_checks({n: "PASS" for n in range(1, 9)})), encoding="utf-8")
    other = tmp_path / "othertemp"
    other.mkdir()
    r = _cc(b, "-Test", "-ChecksFile", str(f), env={**b["env"], "TEMP": str(other), "TMP": str(other)})
    assert r.returncode == 2 and "ChecksFile" in r.stdout
    assert _state(b)["pinned"]["version"] == V1


# --- prune ------------------------------------------------------------------------------------
@needs_pwsh
def test_prune_list_keeps_pin_previous2_candidate_and_in_use():
    st = {"pinned": {"version": "2.1.283"}, "previous": [{"version": "2.1.282"}, {"version": "2.1.281"}], "candidate": {"version": "2.1.284", "status": "staged"}}
    body = (f"$s = ConvertFrom-Json -InputObject '{json.dumps(st)}'\n"
            "(@(Get-CcPruneList -Versions @('2.1.279','2.1.280','2.1.281','2.1.282','2.1.283','2.1.284','2.1.278') -State $s -InUse @('2.1.279')) -join ',')")
    assert _ps(body) == "2.1.278,2.1.280"


@needs_pwsh
def test_prune_keeps_pin_previous2_candidate_and_in_use(tmp_path):
    rt = tmp_path / "rt"
    (rt / "state").mkdir(parents=True)
    b = {"rt": rt, "builds": {}, "env": {**os.environ, "BOTCORP_HOME": str(rt), "BOT_TG_MUTE": "1"}}
    for v in ("2.1.279", "2.1.280", "2.1.281", "2.1.282", "2.1.283", "2.1.284"):
        _store(b, v)
    busy_exe = rt / "cc" / "2.1.279" / "claude.exe"
    busy_exe.unlink()
    shutil.copyfile(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "PING.EXE", busy_exe)   # a signed, long-running stand-in
    _write_state(b, {"schema": 1, "pinned": {**_entry(b, "2.1.283"), "by": "gate"},
                     "previous": [_entry(b, "2.1.282"), _entry(b, "2.1.281")],
                     "candidate": {**_entry(b, "2.1.284"), "status": "staged", "attempts": 0}, "rejected": []})
    busy = subprocess.Popen([str(busy_exe), "-n", "120", "127.0.0.1"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        r = _cc(b, "-Prune")
        assert r.returncode == 0, r.stdout + r.stderr
        left = sorted(p.name for p in (rt / "cc").iterdir())
        assert left == ["2.1.279", "2.1.281", "2.1.282", "2.1.283", "2.1.284"]
        assert busy.poll() is None and busy_exe.is_file()   # prune never touches a running exe
    finally:
        busy.kill()
        busy.wait(timeout=30)
    # nothing runs from the store any more: the version it kept for its process goes too
    r = _cc(b, "-Prune")
    assert r.returncode == 0, r.stdout + r.stderr
    assert sorted(p.name for p in (rt / "cc").iterdir()) == ["2.1.281", "2.1.282", "2.1.283", "2.1.284"]


# --- rollback ---------------------------------------------------------------------------------
@needs_pwsh
def test_rollback_moves_pin_and_rejects(tmp_path):
    rt = tmp_path / "rt"
    (rt / "state").mkdir(parents=True)
    b = {"rt": rt, "builds": {}, "env": {**os.environ, "BOTCORP_HOME": str(rt), "BOT_TG_MUTE": "1"}}
    for v in ("2.1.282", "2.1.283", "2.1.284"):
        _store(b, v)
    start = {"schema": 1, "pinned": {**_entry(b, "2.1.284"), "by": "gate"},
             "previous": [_entry(b, "2.1.283"), _entry(b, "2.1.282")], "candidate": None, "rejected": []}
    _write_state(b, start)
    r = _cc(b, "-Rollback")
    assert r.returncode == 0, r.stdout + r.stderr
    st = _state(b)
    assert st["pinned"]["version"] == "2.1.283" and st["pinned"]["by"] == "rollback"
    assert [p["version"] for p in st["previous"]] == ["2.1.282"]
    assert st["rejected"] == ["2.1.284"]

    _write_state(b, start)
    assert _cc(b, "-Rollback", "-To", "2.1.282").returncode == 0
    st = _state(b)
    assert st["pinned"]["version"] == "2.1.282"
    assert [p["version"] for p in st["previous"]] == ["2.1.283"]
    assert st["rejected"] == ["2.1.284"]

    # a version that is not a previous one, or whose exe is gone or changed: refused, nothing moves
    _write_state(b, start)
    assert _cc(b, "-Rollback", "-To", "2.1.270").returncode == 1
    assert _state(b) == start
    (rt / "cc" / "2.1.283" / "claude.exe").write_bytes(b"tampered")
    assert _cc(b, "-Rollback").returncode == 1
    (rt / "cc" / "2.1.283" / "claude.exe").unlink()
    assert _cc(b, "-Rollback").returncode == 1
    assert _state(b) == start
