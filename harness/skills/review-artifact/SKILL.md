---
name: review-artifact
description: Build an interactive review/decision Artifact when you need the operator's answers on more than one thing — per-item Yes/No/Don't know plus a comment, every item carrying its own full context so they never have to guess or google, and an export that hands their answers and comments back to you in full. Use INSTEAD of sending findings, decisions, approvals, alerts or status walls over chat. Also read it before sending any message that asks for a decision.
---

# The review artifact: ask once, in a place they can actually answer

## Why this exists

This skill was written after an operator sent a screenshot of **29 consecutive
messages from the bot that he had never replied to**, and said the arrangement
was not viable: he is a human, he cannot read that much in one go, and he needed
to look at each item individually and answer it easily. He also said that every
point must carry its context or full details somewhere, so he never has to guess
or go and look something up. And for everything that was not a decision: keep
monitoring, find the issues and fix them, because what he wanted was triaging and
fixing, not alerts.

The failure was not message length. Each message was individually defensible.
The failure was **treating a chat log as a work queue**: many pushes, no turn
taken, nothing answerable, and the few items that genuinely needed a decision
buried among items that needed nothing at all.

## The rule, before anything else

**A push that does not need an answer should not be sent.** If you found a
problem, triage it and fix it. A backup that broke because you added a table:
audit the table and add it. A red build: diagnose it. Stray processes: clean them
up. Report it later, in one place, as something already done. Operators want
outcomes, not a pager.

**Everything that DOES need an answer goes into one review artifact**, not into
chat. Then chat gets three or four lines and the link, once.

## When to use this

- Two or more decisions, approvals, or judgement calls are waiting on them.
- A queue of items to triage (items to publish, PRs to merge, findings to
  confirm, resources to delete).
- Anything where you would otherwise write "options: 1... 2... 3..." in chat.

For a genuine single yes/no with no context to carry, one short chat line is
still fine. Everything larger is an artifact.

## Build it

Load the design skills first, as for any page. Then:

### Every item carries its own answer

Three buttons, always the same three, always in this order: **Yes / No / Don't
know**. "Don't know" is not filler — it is the honest answer that tells you to go
find out rather than to guess, and without it people either skip the item or pick
one at random. Under them, a free-text **comment** box, always present, never
required.

Label the buttons for the actual question when Yes/No would be ambiguous
("Publish" / "Reject" / "Not sure"), but keep three options and keep the third
one an explicit non-answer.

### Every item carries its own context

This is the part that gets skipped, and the reason it must not be:

- **The question**, in one line, in their language, not the system's.
- **Your recommendation**, marked as such, with one line of why.
- **What happens on each answer** — the consequence of Yes and of No. If you
  cannot state the consequence, you are not ready to ask.
- **The evidence**, inline: the numbers, the file and line, the quoted text, the
  URL, the before and after. Whatever you looked at to form the recommendation
  goes on the page. They must never have to open a repo, run a query, or search
  the web to answer.
- **What you already did about it**, and what you deliberately did not do.

Put the short form in the card and the full detail behind a `<details>` toggle
in the same card. Scannable at a glance, complete when opened. Never a link to a
markdown file in the repo — assume they are on a phone.

### Every answer comes back to you in full

Declare `capabilities: {artifact: {}}` and, when they press **Send answers**,
have the page regenerate its own complete HTML with the answer state embedded and
call `artifact.publish(html)`. Embed the state as JSON in a script tag so you can
parse it exactly rather than scraping the DOM:

```html
<script id="review-state" type="application/json">
{"reviewId":"queue-2026-09-03",
 "answers":{"item-7":{"answer":"yes","comment":"but drop the pricing line","ts":"..."}}}
</script>
```

Read it back with `Artifact({action: "read", url})` and parse that block. A
republish also notifies the session that published the page — but **only if that
session is watching it**, and a session caps at 5 artifact watches, so unwatch
something first and confirm with `action: "status"`. Do not assume the answers
will find you.

Three things that make this survive contact with reality:

- **Draft to `localStorage` on every interaction**, wrapped in try/catch, so a
  closed tab does not lose twenty answers.
- **Fallback export**: if `claude.use("artifact")` resolves `null` (read-only
  viewer, capability not granted), reveal a copy button that puts the same JSON
  on the clipboard, with a `user-select: all` block behind it for long-press.
  The answers must be recoverable even when the page cannot publish.
- **Never gate content on JS.** Items render from the HTML as written; the
  buttons light up when the capability resolves. Restore textarea values from
  the state on load, so the state stays the single source of truth.

### Make the state of play obvious

A sticky bar with "12 of 30 answered", the unanswered count, and the Send button.
Group by what you need: decisions first, then approvals, then things you are
merely informing them of (which need no buttons at all, and should be few).

## After they answer

1. Re-read the artifact and parse `review-state`.
2. **Act on every answer**, including the comments — a comment is an instruction,
   not a footnote.
3. **"Don't know" is work assigned to you**: go and find the answer, then either
   act or come back with the missing piece filled in. Never re-ask the same
   question unchanged.
4. Republish the same URL with each item marked done and what you did, so the
   page becomes the record rather than another thing to remember.

## Enforce it outside your own judgement

A style rule does not prevent this failure, because the judgement is made one
message at a time and one more is always defensible. Put the count somewhere the
judgement cannot reach it:

- An **unanswered-backlog guard** in the outbound send path: past N unanswered
  messages (4 is a reasonable default) the send fails and prints what to do
  instead. Clear it when the operator replies.
- An **`--alert` mode** in the same path: automated monitor output goes to a log
  the agent reads and triages, never to a person. **Gate it by severity.** The
  first version of this routed everything to the log, and a CRITICAL "live
  client site down" then sat unread for 40 minutes, because the only thing that
  reads the log is the agent on a tick. Log every alert, push the criticals, and
  exempt those from the backlog guard: swallowing an outage is a worse failure
  than the repeated warning it replaced. Match the severity on a word boundary
  and print what matched, so a substring cannot promote or demote an alert.

Both belong at the lowest shared layer, because automated monitors are usually
the bulk of the flood and they all send through it.

## What not to do

- Do not send a second artifact while the first is unanswered. Add to it.
- Do not send progress reports nobody asked for. Finish, then report once.
- Do not send automated health alerts. Fix the thing. If it genuinely cannot be
  fixed without a decision, that decision is an item in the artifact.
- Do not put the detail in chat "so it is in both places". It is then in neither.
