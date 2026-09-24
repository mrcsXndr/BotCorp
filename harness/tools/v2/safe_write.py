#!/usr/bin/env python3
"""Atomic, locked, drift-guarded writes to shared memory files.

Pattern (not import) from hermes-agent idea #2 (docs/hermes-agent-review.md
§4): the safe-WRITE substrate that makes a future shared bus + concurrent
multi-session writing not race the git tree or clobber shared memory
(MEMORY.md, the shared bus, journals when >1 session is live).

The hermes pattern, implemented cross-platform:
  1. Cross-platform exclusive lock via a sidecar `<file>.lock` (msvcrt on
     Windows, fcntl on POSIX). The lock file is the synchronization point;
     the target file is never locked directly (avoids Windows share issues).
  2. Re-read-under-lock before mutate: the transform sees the CURRENT
     on-disk content, so a writer that blocked on the lock doesn't operate
     on stale data.
  3. Atomic write: temp file in the same dir + os.replace (atomic on both
     NTFS and POSIX) — a crash mid-write can never leave a half-file.
  4. External-drift guard: callers may pass `expected` (content they believe
     is on disk). If the actual content differs, we snapshot a
     `<file>.bak.<ts>` and REFUSE rather than clobber an unexpected change.

Public API
----------
  safe_append(path, text, *, newline=True) -> dict
  safe_replace(path, transform_fn, *, expected=None, create=True) -> dict
      transform_fn(current_str) -> new_str

CLI (for shell / hook use)
--------------------------
  safe_write.py append <path> <text...>
  safe_write.py replace <path>            # reads new full content from stdin
  safe_write.py selftest

All ops are best-effort fail-safe: on lock-timeout or drift they return a
status dict and DO NOT write. They never raise to the caller's process.
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

LOCK_TIMEOUT_S = float(os.environ.get("BOT_LOCK_TIMEOUT", "10"))
LOCK_POLL_S = 0.05

_IS_WIN = os.name == "nt"
if _IS_WIN:
    import msvcrt
else:
    import fcntl


# ---------------------------------------------------------------------------
# Cross-platform lock (context manager over a sidecar .lock file)
# ---------------------------------------------------------------------------

class FileLock:
    """Exclusive advisory lock on `<path>.lock`. Blocks (polling) up to
    LOCK_TIMEOUT_S, then raises TimeoutError."""

    def __init__(self, target: Path, timeout: float = LOCK_TIMEOUT_S):
        self.lock_path = Path(str(target) + ".lock")
        self.timeout = timeout
        self._fh = None

    def __enter__(self):
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + self.timeout
        # Keep the handle open for the whole critical section.
        self._fh = open(self.lock_path, "a+")
        while True:
            try:
                if _IS_WIN:
                    msvcrt.locking(self._fh.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    fcntl.flock(self._fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except OSError:
                if time.monotonic() >= deadline:
                    self._fh.close()
                    self._fh = None
                    raise TimeoutError(f"could not acquire lock {self.lock_path} in {self.timeout}s")
                time.sleep(LOCK_POLL_S)

    def __exit__(self, exc_type, exc, tb):
        if self._fh is not None:
            try:
                if _IS_WIN:
                    self._fh.seek(0)
                    msvcrt.locking(self._fh.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
            finally:
                self._fh.close()
                self._fh = None
        return False


# ---------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------

def _now_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".tmp.{os.getpid()}.{_now_stamp()}")
    with open(tmp, "w", encoding="utf-8", newline="") as fh:
        fh.write(content)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def _read(path: Path) -> str:
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8")


def safe_replace(path, transform_fn, *, expected: str | None = None, create: bool = True) -> dict:
    """Acquire lock -> re-read current content -> optional drift guard ->
    transform_fn(current) -> atomic write. transform_fn must be a pure
    str->str function (it may be called once)."""
    path = Path(path)
    try:
        with FileLock(path):
            if not path.exists() and not create:
                return {"status": "missing", "path": str(path)}
            current = _read(path)

            # External-drift guard: if caller told us what it expected and the
            # disk disagrees, snapshot + refuse rather than clobber.
            if expected is not None and current != expected:
                bak = path.with_name(path.name + f".bak.{_now_stamp()}")
                try:
                    _atomic_write(bak, current)
                except Exception:
                    pass
                return {
                    "status": "drift-detected",
                    "path": str(path),
                    "backup": str(bak),
                    "note": "on-disk content differs from `expected`; refused to clobber",
                }

            try:
                new_content = transform_fn(current)
            except Exception as e:
                return {"status": "transform-error", "path": str(path), "error": repr(e)}

            if not isinstance(new_content, str):
                return {"status": "transform-error", "path": str(path), "error": "transform_fn did not return str"}

            if new_content == current:
                return {"status": "noop", "path": str(path)}

            _atomic_write(path, new_content)
            # Round-trip verify: re-read and confirm what we wrote landed.
            verify = _read(path)
            if verify != new_content:
                bak = path.with_name(path.name + f".bak.{_now_stamp()}")
                try:
                    _atomic_write(bak, verify)
                except Exception:
                    pass
                return {"status": "verify-failed", "path": str(path), "backup": str(bak)}
            return {"status": "written", "path": str(path), "bytes": len(new_content.encode("utf-8"))}
    except TimeoutError as e:
        return {"status": "lock-timeout", "path": str(path), "error": str(e)}
    except Exception as e:  # absolute fail-safe — never raise to caller
        return {"status": "error", "path": str(path), "error": repr(e)}


def safe_append(path, text: str, *, newline: bool = True) -> dict:
    """Atomic locked append. Safe for append-only buses (each call is a full
    read-modify-write under lock, so concurrent appenders serialize)."""
    suffix = ("\n" if newline and not text.endswith("\n") else "")

    def _t(current: str) -> str:
        if current and not current.endswith("\n"):
            current += "\n"
        return current + text + suffix

    return safe_replace(path, _t, create=True)


# ---------------------------------------------------------------------------
# CLI + selftest
# ---------------------------------------------------------------------------

def _selftest() -> int:
    import tempfile
    import threading

    failures = []
    tmpdir = Path(tempfile.mkdtemp(prefix="safe_write_test_"))
    target = tmpdir / "shared.txt"

    # 1. atomic create + append
    r = safe_append(target, "line-1")
    if r["status"] != "written" or _read(target) != "line-1\n":
        failures.append(("append-create", r, repr(_read(target))))

    # 2. concurrent appenders all land (lock serializes RMW)
    N = 20
    def worker(i):
        safe_append(target, f"concurrent-{i}")
    threads = [threading.Thread(target=worker, args=(i,)) for i in range(N)]
    for t in threads: t.start()
    for t in threads: t.join()
    lines = _read(target).strip().splitlines()
    got = sum(1 for l in lines if l.startswith("concurrent-"))
    if got != N:
        failures.append(("concurrent-append", f"expected {N} lines, got {got}", lines))

    # 3. atomic replace via transform
    r = safe_replace(target, lambda c: "REPLACED")
    if r["status"] != "written" or _read(target) != "REPLACED":
        failures.append(("replace", r, repr(_read(target))))

    # 4. drift guard: expected mismatch -> refuse + backup, file unchanged
    r = safe_replace(target, lambda c: "SHOULD-NOT-LAND", expected="WRONG-EXPECTED")
    if r["status"] != "drift-detected" or _read(target) != "REPLACED":
        failures.append(("drift-guard", r, repr(_read(target))))
    elif not Path(r["backup"]).exists():
        failures.append(("drift-backup-missing", r, None))

    # 5. drift guard pass-through: correct expected -> writes
    r = safe_replace(target, lambda c: c + "+ok", expected="REPLACED")
    if r["status"] != "written" or _read(target) != "REPLACED+ok":
        failures.append(("drift-pass", r, repr(_read(target))))

    # 6. noop detection
    r = safe_replace(target, lambda c: c)
    if r["status"] != "noop":
        failures.append(("noop", r, None))

    # cleanup
    try:
        for p in tmpdir.glob("*"):
            p.unlink()
        tmpdir.rmdir()
    except Exception:
        pass

    if failures:
        print(json.dumps({"status": "FAIL", "failures": failures}, indent=2))
        return 1
    print(json.dumps({"status": "PASS", "checks": [
        "append-create", "concurrent-append(20)", "replace",
        "drift-guard-refuse+backup", "drift-guard-pass", "noop",
    ]}, indent=2))
    return 0


USAGE = """\
safe_write — atomic, locked, drift-guarded writes to shared memory files

Usage:
  safe_write.py append <path> <text...>
  safe_write.py replace <path>      # new full content read from stdin
  safe_write.py selftest

API (import): safe_append(path, text), safe_replace(path, transform_fn, expected=None)
"""


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in ("-h", "--help", "help"):
        print(USAGE)
        return 0
    cmd = argv[1]
    if cmd == "selftest":
        return _selftest()
    if cmd == "append" and len(argv) >= 4:
        r = safe_append(argv[2], " ".join(argv[3:]))
        print(json.dumps(r))
        return 0 if r["status"] in ("written", "noop") else 1
    if cmd == "replace" and len(argv) >= 3:
        new = sys.stdin.read()
        r = safe_replace(argv[2], lambda _c: new)
        print(json.dumps(r))
        return 0 if r["status"] in ("written", "noop") else 1
    print(USAGE, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
