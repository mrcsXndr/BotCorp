"""_paths.py — where is THIS bot? The one seam every harness tool goes through.

The harness lives at <BotCorp>/harness and is shared by every bot on the
machine, so a path derived from __file__ points at the HARNESS, never at the
bot whose memory/, .claude/ and .env a tool has to read. Every tool that used
to walk up from its own file to a "repo root" now calls instance_root().

    instance_root()  BOT_HOME > CLAUDE_PROJECT_DIR > cwd        (the bot folder)
    harness_root()   <BotCorp>/harness                          (this plugin)
    botcorp_root()   <BotCorp>                                  (daemon/, cli/, cockpit/)
    config_home()    CLAUDE_CONFIG_DIR > ~/.claude              (Claude Code's state)
    runtime_root()   BOTCORP_HOME > ~/.botcorp                  (machine runtime, never secrets)
    bot_name()       BOT_NAME > instance_root().name

Never cache these at import time in a long-lived process: hooks are one-shot
processes, so module-level constants are fine there, but the daemon-side
tools re-evaluate per bot.
"""
from __future__ import annotations

import os
from pathlib import Path


def instance_root() -> Path:
    for var in ("BOT_HOME", "CLAUDE_PROJECT_DIR"):
        v = os.environ.get(var)
        if v:
            return Path(v).resolve()
    return Path.cwd().resolve()


def harness_root() -> Path:
    return Path(__file__).resolve().parents[1]


def botcorp_root() -> Path:
    """The BotCorp checkout (daemon/, cli/, cockpit/ live beside harness/)."""
    return harness_root().parent


def config_home() -> Path:
    v = os.environ.get("CLAUDE_CONFIG_DIR")
    if v:
        return Path(v).resolve()
    return Path.home() / ".claude"


def runtime_root() -> Path:
    v = os.environ.get("BOTCORP_HOME")
    if v:
        return Path(v).resolve()
    return Path.home() / ".botcorp"


def bot_name() -> str:
    return os.environ.get("BOT_NAME") or instance_root().name


def modules() -> set[str]:
    """Enabled harness modules, from BOT_MODULES (comma-separated). The
    launcher derives it from bot.yaml harness.modules; unset = all on, so a
    tool run by hand outside the daemon still works."""
    raw = os.environ.get("BOT_MODULES")
    if raw is None:
        return {"*"}
    return {m.strip() for m in raw.split(",") if m.strip()}


def module_enabled(name: str) -> bool:
    m = modules()
    return "*" in m or name in m
