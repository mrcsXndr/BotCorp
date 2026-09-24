---
name: payload-text-as-argv-gets-substituted
description: Prose passed to a command as an argv string gets shell-substituted — backticked terms and $-prefixed words silently vanish, the receiving API accepts the mutilated payload with a 2xx, and the job runs on instructions missing its key nouns
metadata:
  type: lesson
---

# Payload prose goes in a file, never in an argv string

Interpolating a multi-line brief, a card body, a commit message, or any
prose containing backticks or `$` directly into a shell command's argument
string is not safe just because the string is quoted for variable expansion.

**Why.** Backticks in an argv string are command substitution regardless of
surrounding quote style, and `$`-prefixed tokens expand as variables. In one
incident, a brief written in ordinary markdown — code terms in backticks, a
filename in backticks — was passed as a `-c "..."` style argument. Every
backticked term was replaced by the (empty) output of a failed shell command,
and dollar-signs expanded too. The payload shrank by roughly a quarter,
reading as fluent prose with holes exactly where the important nouns had
been. **The receiving API returned success anyway** — the request was
syntactically valid, so a downstream job was filed and would have run for a
long time against instructions that never named the file to fix or the tool
to run, with a burst of shell "command not found" lines in the same output
easily mistaken for unrelated noise.

This is a distinct failure from a heredoc corrupting a *source file*
(see [[edit-tool-not-scripts]]): there's no parser downstream to catch it,
nothing is malformed, and the receiving system cannot tell a brief with
holes from a brief that was always written that way. The only detector is
comparing what you sent against what was actually stored.

**How to apply.**
- **Payload prose goes in a file, always.** Write it with a file-write tool,
  have the receiving call read the file. Never interpolate free-form text
  containing backticks or `$` into an argv string.
- **Verify the round trip, not the status code.** After filing/submitting,
  read the record back and assert it matches the local content byte-for-byte
  (a length comparison alone is often enough to catch this class of bug). A
  2xx response says the request parsed; it says nothing about whether the
  content survived the shell.
- **A burst of "command not found" during a request is not noise** — it's
  the shell telling you it executed part of your payload.
- Getting it right the first time is much cheaper than the retraction path,
  which typically needs its own elevated authority and still leaves a
  mis-filed record to track down and correct.

Related: [[edit-tool-not-scripts]] · [[unrequested-field-reads-as-empty]]
