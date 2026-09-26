// paths.mjs - the one resolver for where bot folders live (daemon/_paths.ps1 is
// its PowerShell twin). BOTCORP_BOTS_DIR=<dir> replaces <checkout>/bots for
// every reader and writer alike, so a test's temp bots dir is seen the same way
// by the CLI, the cockpit, the daemon and the launcher. Read at call time, not
// import time, so a test may set it after importing.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function botsDir(root = ROOT) { return process.env.BOTCORP_BOTS_DIR || path.join(root, 'bots'); }
export function botHome(name, root = ROOT) { return path.join(botsDir(root), name); }
