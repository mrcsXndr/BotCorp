# Lessons Index

- [Edit tool, never scripts](edit-tool-not-scripts.md) — a silent no-match is a no-op; an eaten escape can break a file something else is reading live
- [One agent, one thread](one-agent-one-thread.md) — review can be a team; a git working tree can only have one writer at a time
- [Subagent "verified" is not verified](subagent-verified-is-not-verified.md) — its checks cover only the failure modes it thought of; look at anything with a real-world surface yourself
- [Unrequested field reads as empty](unrequested-field-reads-as-empty.md) — a query that never asked for a field returns absence, not evidence of emptiness
- [Prove the guard catches the real defect](prove-the-guard-catches-the-real-defect.md) — mutation-test against the actual historical bug from version control, not a hand-written sample
- [Exit zero hides outages](exit-zero-hides-outages.md) — a fail-open job that logs and exits 0 anyway is invisible; audit logs by message frequency
- [A roll isn't done until the id changed](a-roll-is-not-done-until-the-id-changed.md) — verify a restart by the resulting state, not by the trigger command returning
- [Payload text as argv gets substituted](payload-text-as-argv-gets-substituted.md) — backticks and `$` in a shell argument silently vanish; write payload prose to a file instead
