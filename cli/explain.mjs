// explain.mjs - a queued approval in plain words, for the cockpit's Inbox card
// (`botcorp approvals --json` adds it as `explain`).
//
//   explainApproval(bot, cfg, entry) -> { who, what, why, onApprove, onDecline, when }
//
// `bot` = the bot whose queue holds the entry, `cfg` = its effective bot.yaml
// (null when unreadable), `entry` = the queued {op, path, value, requested_by}.
// One branch per kind of widening change cli/botcorp.mjs isWidening() queues;
// anything else reads as a plain "change <path>". Pure: no file is read.

import { secretEnvName } from './_lib.mjs';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const listOf = (v) => (Array.isArray(v) ? v.map(String) : v === undefined || v === null ? [] : [String(v)]);
const names = (xs) => xs.join(', ');
const shown = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v ?? null); return s.length > 60 ? `${s.slice(0, 57)}...` : s; };

// bot:x -> "x (the bot itself)" / "x (another bot)"; operator:* and local -> You; anything else as it is (an email)
export function whoOf(requestedBy, bot) {
  const r = String(requestedBy || '');
  const m = /^bot:(.+)$/.exec(r);
  if (m) return m[1] === bot ? `${m[1]} (the bot itself)` : `${m[1]} (another bot)`;
  if (!r || r === 'local' || r.startsWith('operator:')) return 'You';
  return r;
}

const NEXT_START = 'At the next session start';

export function explainApproval(bot, cfg, entry) {
  const e = entry || {};
  const op = e.op || 'set';
  const p = String(e.path || '');
  const segs = p.split('.');
  const v = e.value;
  const byBot = /^bot:(.+)$/.exec(String(e.requested_by || ''));
  const told = byBot ? `; ${byBot[1]} is told` : '';
  const x = { who: whoOf(e.requested_by, bot), onDecline: `Nothing changes${told}.`, when: NEXT_START };
  const out = (o) => ({ ...x, ...o });

  if (['new', 'import', 'adopt'].includes(op)) {
    const how = { new: 'create a new bot', import: 'import a bot folder as a new bot', adopt: 'adopt an existing folder as a new bot' }[op];
    return out({ what: `${how}: ${p}`, why: 'A bot may not make bots on its own: a new bot is another session with its own access.',
      onApprove: `bots/${p} is created and set up now; it runs only once it is started.`, when: 'Now' });
  }
  if (p === 'secrets') {
    const have = new Set(listOf(cfg && cfg.secrets));
    const keys = listOf(op === 'append' ? [].concat(v) : v).filter((k) => !have.has(k));
    const list = keys.length ? keys : listOf(op === 'append' ? [].concat(v) : v);
    return out({ what: `read the vault secret${list.length === 1 ? '' : 's'} ${names(list)} in its session`,
      why: 'A secret gives the session whatever that key unlocks.',
      onApprove: `Added to secrets:; injected as ${names(list.map(secretEnvName))} at the next start, when the vault holds a value (botcorp secrets set ${bot} <key>).` });
  }
  if (p === 'automations' && op === 'append') {
    const items = [].concat(v).filter(isObj);
    const one = items.length === 1 ? items[0] : null;
    const detail = one ? ` (${one.kind === 'prompt' ? 'types a prompt' : `runs ${shown(one.command)}`}${one.trigger ? `, ${shown(one.trigger)}` : ''})` : '';
    return out({ what: `add the automation${items.length === 1 ? '' : 's'} ${names(items.map((i) => String(i.name)))}${detail}`,
      why: 'An automation runs on this machine on a schedule, without you.',
      onApprove: 'Added to automations:; the daemon runs it from its next pass.', when: 'From the daemon\'s next pass' });
  }
  if (p === 'tools' && op === 'append') {
    const items = [].concat(v).filter(isObj);
    return out({ what: `register the tool${items.length === 1 ? '' : 's'} ${names(items.map((i) => `${i.name} (${i.kind || 'tool'}${listOf(i.secrets).length ? `, secrets ${names(listOf(i.secrets))}` : ''})`))}`,
      why: 'An integration, or a tool holding secrets, reaches outside this bot.',
      onApprove: 'Added to the tools registry; the session may run it.' });
  }
  if (segs[0] === 'automations' && segs[2] === 'enabled') {
    return out({ what: `switch the automation ${segs[1]} back on`, why: 'It was switched off; on, it runs again without you.',
      onApprove: 'The daemon runs it again from its next pass.', when: 'From the daemon\'s next pass' });
  }
  if (segs[0] === 'automations' && segs[2] === 'secrets') {
    return out({ what: `give the automation ${segs[1]} the vault secret${listOf(v).length === 1 ? '' : 's'} ${names(listOf(v))}`,
      why: 'Each run of that job gets the secret in its env.', onApprove: 'Injected into that job from its next run.', when: 'From its next run' });
  }
  if (segs[0] === 'tools' && segs[2] === 'enabled') {
    return out({ what: `switch the tool ${segs[1]} back on`, why: 'It is an integration or holds secrets: it reaches outside this bot.',
      onApprove: 'The session may run it again.' });
  }
  if (p === 'account') {
    return out({ what: `run on ${v ? `the account ${v}` : 'its own token'} instead of ${cfg && cfg.account ? `the account ${cfg.account}` : 'its own token'}`,
      why: 'Another account means another plan, usage limit and bill.',
      onApprove: 'The daemon moves the session at its next idle turn; the conversation is kept.', when: 'At the next idle turn' });
  }
  if (p === 'backup_accounts') {
    return out({ what: `fail over to ${listOf(v).length ? names(listOf(v)) : 'no backup account'} when its account hits a usage limit`,
      why: 'Another account means another plan, usage limit and bill.', onApprove: 'Used the next time the account hits a limit.', when: 'At the next usage limit' });
  }
  if (p === 'role') {
    return out({ what: `change its role: ${(cfg && cfg.role) || 'none'} -> ${v || 'none'}`,
      why: 'An admin bot runs operator-only commands for every bot. Only you decide this; no admin bot can.',
      onApprove: 'The role applies at once.', when: 'Now' });
  }
  if (p === 'harness.hooks_disable') {
    const cur = listOf(cfg && cfg.harness && cfg.harness.hooks_disable);
    const off = listOf(v).filter((h) => !cur.includes(h) && /-guard$/.test(h));
    return out({ what: `switch off the guard hook${off.length === 1 ? '' : 's'} ${names(off.length ? off : listOf(v))}`,
      why: 'A guard blocks something unsafe; off, the bot can do it.', onApprove: 'Off from the next session start.' });
  }
  if (p === 'integrations.telegram.allow_from') {
    const cur = listOf(cfg && cfg.integrations && cfg.integrations.telegram && cfg.integrations.telegram.allow_from);
    const added = listOf(v).filter((id) => !cur.includes(id));
    return out({ what: `let the Telegram user${added.length === 1 ? '' : 's'} ${names(added)} message it`, why: 'Whoever can message the bot can give it instructions.',
      onApprove: 'Paired at once (access.json, while the telegram module is on).', when: 'Now' });
  }
  if (p === 'integrations.telegram.dm_policy') {
    return out({ what: `let more people message it on Telegram: ${(cfg && cfg.integrations.telegram.dm_policy) || '?'} -> ${v}`,
      why: 'Whoever can message the bot can give it instructions.', onApprove: 'Written to access.json at once.', when: 'Now' });
  }
  if (p === 'permissions') {
    return out({ what: 'run every tool call without asking (permissions: bypass)', why: 'No tool call waits for a yes any more.', onApprove: 'From the next session start.' });
  }
  if (p === 'harness.tools_registry') {
    return out({ what: 'relax the tools registry from enforce to warn', why: 'An unregistered executable no longer fails the doctor.', onApprove: 'The doctor grades it as a warning from its next run.', when: 'Now' });
  }
  if (op === 'remove') return out({ what: `remove ${shown(v)} from ${p}`, why: e.reason || 'Queued for you.', onApprove: 'Removed from bot.yaml and synced.' });
  return out({ what: `change ${p} to ${shown(v)}`,
    why: byBot ? 'A bot may change only a short list of settings on its own; this one is not on it.' : (e.reason || 'Queued for you.'),
    onApprove: 'Written to bot.yaml and synced.' });
}
