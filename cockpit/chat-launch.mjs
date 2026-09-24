// chat-launch.mjs - read-only view of recent chat workspaces for the New
// chat modal.
//
// `botcorp chat` writes <BOTCORP_HOME>/state/chat-recent.json as it launches
// tabs; the cockpit only reads it here. The launch itself goes through the
// CLI (server.mjs POST /api/chat/launch), same as every other write path.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { BOTCORP_HOME } from './bots.mjs';

const FILE = path.join(BOTCORP_HOME, 'state', 'chat-recent.json');

export async function listRecent() {
  let data;
  try { data = JSON.parse(await fsp.readFile(FILE, 'utf-8')); } catch { return { recent: [] }; }
  const recent = Array.isArray(data.recent) ? data.recent : [];
  return {
    recent: recent.map((r) => ({
      cwd: typeof r?.cwd === 'string' ? r.cwd : '',
      last_used: typeof r?.last_used === 'string' ? r.last_used : null,
      account: typeof r?.account === 'string' ? r.account : null,
    })).filter((r) => r.cwd),
  };
}
