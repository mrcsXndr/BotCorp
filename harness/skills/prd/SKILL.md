---
name: prd
description: Start a Product Requirements Doc from a template.
allowed-tools: Read, Write, Edit
---

# /prd — Start a PRD

Usage: `/prd <domain>` — `domain` matches one of the operator's configured domains (work company, side project, etc.). Templates live in `templates/`; if none exist, scaffold one on first run and tell the operator.

## Steps

1. **Locate the template**:
   - Look in `templates/prd_<domain>.md`. If not found, generate a generic PRD template at `templates/prd_default.md` and use that.
   - Read the corresponding `context/<domain>.md` so the doc starts grounded in the project.

2. **Ask the operator for the PRD title** (keep it short — slug-friendly).

3. **Copy template** to `projects/<Domain>/PRDs/<title-slug>.md`. Pre-fill:
   - Date (today)
   - Author (the operator's name from `context/me.md`)
   - Status: `Draft`

4. **Walk through each section**, prompting the operator for input. Keep questions specific — don't dump the whole template at once.

5. **Domain-specific guards**: if the domain has constraints documented in its context file (regulatory, security, accessibility, performance budgets), surface them before the operator picks a solution. That's the whole reason we read the context file first.

## Generic PRD shape

If you need to scaffold a default template, use:

```markdown
# [Title]

**Author:** [Name]
**Date:** [YYYY-MM-DD]
**Status:** Draft

## Problem
[1–2 sentences. Who's hurting and why.]

## Goals
- [Goal 1]
- [Goal 2]

## Non-goals
- [Out of scope]

## Proposed solution
[Sketch. Diagrams welcome.]

## Risks
[What could go wrong. Each risk gets a mitigation.]

## Open questions
[Unknowns to resolve before build.]

## Rollout plan
[How this ships, who flips the switch, what the rollback looks like.]
```
