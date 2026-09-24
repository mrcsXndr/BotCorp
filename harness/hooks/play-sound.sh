#!/usr/bin/env bash
# Play a "job's done" chime on session stop (optional, Windows-only).
#
# Drop any .m4a/.wav/.mp3 into hooks/sounds/ and point DONE_SOUND at it, or
# just put a file named done.* there. If no sound file exists, this is a
# silent no-op — nothing breaks. No sound file ships with the harness.

set -uo pipefail
. "$(dirname "$0")/_guard.sh" play-sound sound

SOUND="${DONE_SOUND:-}"
if [ -z "$SOUND" ]; then
  for f in "$HARNESS/hooks/sounds/"done.*; do
    [ -f "$f" ] && SOUND="$f" && break
  done
fi

if [ -z "$SOUND" ] || [ ! -f "$SOUND" ]; then exit 0; fi

# Windows: play via PowerShell MediaPlayer. On macOS/Linux this just exits.
# Prefer the absolute path (a bare `powershell.exe` can be missing from a
# session-0 / Scheduled-Task PATH); fall back to PATH lookup, else no-op.
PWSH_ABS_WIN="${SYSTEMROOT:-C:/Windows}/System32/WindowsPowerShell/v1.0/powershell.exe"
if command -v cygpath >/dev/null 2>&1; then
  PWSH_ABS="$(cygpath -u "$PWSH_ABS_WIN" 2>/dev/null)"
else
  PWSH_ABS="$(printf '%s' "$PWSH_ABS_WIN" | sed 's#\\#/#g' 2>/dev/null)"
fi
if [ -n "$PWSH_ABS" ] && [ -f "$PWSH_ABS" ]; then
  PS_EXE="$PWSH_ABS"
elif command -v powershell.exe >/dev/null 2>&1; then
  PS_EXE="powershell.exe"
else
  PS_EXE=""
fi

if [ -n "$PS_EXE" ]; then
  "$PS_EXE" -NoProfile -ExecutionPolicy Bypass -Command "
    Add-Type -AssemblyName PresentationCore
    \$player = New-Object System.Windows.Media.MediaPlayer
    \$player.Open([uri]::new('$(cygpath -w "$SOUND")'))
    \$player.Play()
    Start-Sleep -Seconds 3
  " &>/dev/null &
elif command -v afplay >/dev/null 2>&1; then
  afplay "$SOUND" &>/dev/null &       # macOS
elif command -v paplay >/dev/null 2>&1; then
  paplay "$SOUND" &>/dev/null &        # Linux (PulseAudio)
fi
exit 0
