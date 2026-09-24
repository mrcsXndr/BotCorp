#!/usr/bin/env bash
# Stop hook: sync memory (module-gated). Delegates to the node tool so bots
# that use it get memory-sync behaviour without any bash logic living here.

set -uo pipefail
. "$(dirname "$0")/_guard.sh" memory-sync memory_sync

NODE="${BOT_NODE:-node}"
"$NODE" "$HARNESS/tools/infra/memory-sync-hook.cjs" || true
exit 0
