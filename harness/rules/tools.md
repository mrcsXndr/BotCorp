# Tool Execution Rules

Purpose: how to choose and invoke tools safely — external writes need a human in the loop, CLI wrappers beat MCP for cost, Python needs the Windows encoding fix.

## CRITICAL: Human-in-the-middle for external writes
- **ALWAYS ask for confirmation before writing/modifying** any external system's live data — calendar events, sending mail, task/board updates, spreadsheet writes, file uploads/deletes.
- Read operations are fine without confirmation.
- This applies to ALL external systems — never modify a live account without explicit approval.
- Asking = a non-blocking Telegram question via `tg_send.py`, never a TUI dialog (`AskUserQuestion`/`ExitPlanMode` are hard-denied — see `session-lifecycle.md` and the harness `PreToolUse` guard).

## CLI-first, MCP where it adds value
- Prefer `tools/*` CLI wrappers over MCP for anything with a wrapper already — less context per call than an MCP round-trip.
- Reach for MCP where it adds real value: complex/ad-hoc queries a wrapper doesn't cover, or a provider with no CLI wrapper yet.
- Use `tools/browser/ab.sh` (agent-browser, isolated Chrome) for ALL browser control — see `.claude/rules/browser.md`.

## Python on Windows
- Always prefix Python invocations with `PYTHONIOENCODING=utf-8` — otherwise Windows console encoding mangles non-ASCII output.
- `PYTHONIOENCODING=utf-8 python tools/<dir>/<tool>.py <args>`

## Custom tools
If the operator asks to use a "custom tool": list `tools/`, confirm which one, execute it. Don't invent a tool that isn't there.

## Secrets & Credentials
- Bot-specific credentials (OAuth tokens, API keys, bot tokens) live in `.env` / `.vault` — never in a tracked file.
- **Never commit** secret files (they belong in `.gitignore`).
- Never output API keys, tokens, or passwords in responses.
