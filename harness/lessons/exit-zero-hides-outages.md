---
name: exit-zero-hides-outages
description: A scheduled job that logs its own failure and still exits 0 is invisible by design — nothing ever surfaces as "wrong enough", so audit recurring-job logs by message frequency, not by exit code
metadata:
  type: lesson
---

# Fail-open jobs stay broken invisibly — audit by message frequency

A scheduled or recurring job that catches its own error, logs it, and exits
0 anyway is invisible. Nothing about its own signal ever crosses a threshold
that would surface it, so it can run broken for a very long time before a
human happens to read the log by hand.

**Why.** Fail-open is frequently the *correct* default for a supervisor or
watchdog process — it must never wedge the thing it's supervising. The gap is
that fail-open was never paired with anything that notices *persistent*
failure. Two real examples of the same shape: an integration that polls an
external board failed on every single run for weeks, 100% failure rate, zero
successes ever, printing the same "not configured" line each time — invisible
because each individual run exited clean. A separate monitor ran hourly,
`exit=0`, for days straight, silent through a multi-day outage of the thing
it was supposed to be watching, because its alert condition was gated behind
a lookback window that a already-broken monitor could never satisfy.

**How to apply.**
- **Audit recurring-job logs by grouping the message text and counting**,
  not by scanning exit codes — a real outage shows up as one message
  repeating far more than any other:
  ```bash
  grep -oE "<pattern for your log's message field>" your.log \
    | sed -E 's/[0-9]+/#/g' | sort | uniq -c | sort -rn | head -20
  ```
- **Tripwire:** any recurring-job message appearing far more often than its
  neighbors, or any job with zero successes ever, is an outage regardless of
  what its exit code says.
- Run this audit periodically across every recurring job in the harness, not
  just the one you're currently debugging — the pattern generalizes to any
  fail-open loop.
- Fail-open stays the right default; add a separate, deliberate "has this
  succeeded recently" signal rather than removing the fail-open behavior.

Related: [[prove-the-guard-catches-the-real-defect]]
