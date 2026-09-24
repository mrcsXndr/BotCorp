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
if command -v powershell.exe >/dev/null 2>&1; then
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "
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
