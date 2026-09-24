---
name: launch
description: Generic site / product launch checklist with Cloudflare and DNS sanity checks.
allowed-tools: Bash, Read, Write, Edit
---

# /launch — Site / Product Launch Workflow

Usage: `/launch <project-name>`.

A reusable launch runbook. Adapt the steps to whatever the project is — the structure (prep → DNS / SSL / cache → smoke tests → sign-off) is the same whether you're shipping a casino, a marketing site, or a SaaS product.

## Steps

1. **Read context** — `context/<project>.md` if it exists. If not, scaffold one with the basics (domain, stack, owner, jurisdiction / regulatory constraints if any).

2. **Open / create the launch doc** — copy `templates/launch.md` (scaffold one on first run if missing) into `projects/<Project>/Launches/<launch-name>.md`. Pre-fill date, owner, target launch date.

3. **Walk the checklist** section by section, prompting the operator. Sections worth covering:
   - Domain registered + DNS pointing where it should
   - SSL certificate valid (`python tools/cloudflare_ops.py verify_ssl <domain>`)
   - Cloudflare zone configured (firewall, page rules, redirects)
   - Cache purged at deploy (`python tools/cloudflare_ops.py purge_cache <zone_id>`)
   - Analytics / tracking in place
   - SEO basics (sitemap, robots.txt, OG tags)
   - Smoke test of the critical user flow
   - Rollback plan if launch goes sideways
   - Compliance / legal sign-off if applicable

4. **Update items as they're completed**, keeping the doc as the source of truth.

5. **Hard rule** — do NOT mark launch complete without explicit confirmation from the operator. Especially if compliance / legal sign-off is required.
