---
name: edit-tool-not-scripts
description: Never use a python/sed/heredoc script to modify a file — use the Edit tool; a silent no-match is a silent no-op, and an eaten escape can break a file something else is reading live
metadata:
  type: lesson
---

# Edit files with the Edit tool, never with a script

Never write a `python -c` / heredoc / `sed` / `awk` script to modify a file.
Use `Edit` (or `Write` for a new file), one call per edit.

**Why.** Three distinct failures come from the script path, all observed in
production use:

1. **Escapes corrupt in both directions.** A `\n` written inside a
   heredoc-authored string can arrive as a real newline and split a regex
   literal across two lines; a `\'` can get consumed and close a string early.
   The corruption is invisible in every tool that displays source — `grep`,
   a diff viewer, and a plain re-read all show what looks like correct code —
   so the normal debugging loop (re-read it, it looks right, re-read it again)
   never converges. This is worst when the file being patched is read at
   exec time by something already running: a broken theme/build/config file
   can take down a live process mid-run, not just fail its own lint.
2. **A no-match is a silent no-op.** `s.replace(old, new)` that matches
   nothing writes the file back unchanged and exits 0 — the edit "succeeded"
   and did nothing. The only way to notice is re-reading the file afterward.
   `Edit` fails loudly on a non-match, and on an ambiguous one.
3. **`Edit` forces a prior `Read`.** That requirement is a feature: it
   catches a stale mental model of the file before it becomes a wrong write.

The pull toward scripting is real — it feels faster for a multi-part edit,
and it batches. It is not faster once a silent no-op costs a debugging round,
and it is expensive when the file is live.

**How to apply.** `Edit` for changes, `Write` for new files. The narrow
exception is a genuine bulk mechanical sweep across many files (rename a
symbol in 40 of them); even then, parse-check the result immediately
(`node --check` / `python -m py_compile` / `tsc --noEmit` / the target
language's equivalent) **before anything else reads it**, and never
hand-author regex- or escape-heavy content through a heredoc. Same standard
for reading and searching: prefer dedicated read/search tools over piping a
file through a shell.

Related: [[one-agent-one-thread]] · [[payload-text-as-argv-gets-substituted]]
