#!/usr/bin/env python3
"""Spawn a command DETACHED and WINDOWLESS (fire-and-forget).

Why: headless `claude --print` runs launched from hooks/detached parents get a
brand-new VISIBLE console window on Windows when the parent has no console
(2026-07-13 "2 empty claude windows" incident). This runner spawns the child
with CREATE_NO_WINDOW | DETACHED_PROCESS so background LLM calls stay silent.

Usage:
  run_hidden.py [--prompt-file F] -- <cmd> [args...]

Any literal argument `@PROMPT@` is replaced with the full contents of the
--prompt-file. Exits 0 as soon as the child is spawned (does not wait).
STRICTLY FAIL-OPEN: any error prints one line and exits 0.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys


def main(argv: list[str]) -> int:
    try:
        args = argv[1:]
        prompt = ""
        if args[:1] == ["--prompt-file"]:
            with open(args[1], "r", encoding="utf-8", errors="replace") as f:
                prompt = f.read()
            args = args[2:]
        if args[:1] == ["--"]:
            args = args[1:]
        if not args:
            print("run_hidden: no command given", file=sys.stderr)
            return 0
        cmd = [prompt if a == "@PROMPT@" else a for a in args]

        # Resolve the executable explicitly — hook PATH can be clobbered. A bot's
        # claude is the pinned one its launch named (BOTCORP_CLAUDE_EXE).
        pinned = os.environ.get("BOTCORP_CLAUDE_EXE", "")
        if cmd[0] in ("claude", "claude.exe") and pinned and os.path.isfile(pinned):
            exe = pinned
        else:
            exe = shutil.which(cmd[0])
        if not exe and cmd[0] in ("claude", "claude.exe"):
            fallback = os.path.join(os.environ.get("USERPROFILE", ""), ".local", "bin", "claude.exe")
            exe = fallback if os.path.isfile(fallback) else None
        if exe:
            cmd[0] = exe

        kwargs: dict = dict(
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
        if os.name == "nt":
            # DETACHED_PROCESS gives the child NO console (CreateProcess docs:
            # CREATE_NO_WINDOW is redundant/ignored alongside it — kept only as
            # belt-and-braces documentation of intent). Either way: no window.
            DETACHED_PROCESS = 0x00000008
            CREATE_NEW_PROCESS_GROUP = 0x00000200
            CREATE_NO_WINDOW = 0x08000000
            kwargs["creationflags"] = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        else:
            kwargs["start_new_session"] = True
        subprocess.Popen(cmd, **kwargs)
    except Exception as e:  # fail-open: a broken background spawn must not break the hook
        print(f"run_hidden: {e!r}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
