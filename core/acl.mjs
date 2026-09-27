// acl.mjs - owner-only files, shared by the pty-host (pty.json) and the
// cockpit (its per-boot approval token).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Best-effort "0600": strip inheritance and grant only the current user. On
// Windows `mode: 0o600` is a no-op, so the ACL is the only real protection.
export function restrictToUser(file) {
  if (process.platform !== 'win32') { try { fs.chmodSync(file, 0o600); } catch {} return; }
  const user = process.env.USERNAME;
  if (!user) return;
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const icacls = path.join(sysRoot, 'System32', 'icacls.exe');
  try {
    execFileSync(icacls, [file, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
  } catch { /* best effort */ }
}
