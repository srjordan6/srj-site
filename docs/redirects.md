# Redirects

**Redirects are declared in `astro.config.mjs`, not in `public/_redirects`.**

That is not a style preference. `_redirects` does not work on this deployment,
and the reason is structural.

## Why `_redirects` is dead here

The site is deployed as a **Cloudflare Worker** with static assets, not as a
Pages project. Cloudflare's documentation is explicit: redirects defined in
`_redirects` are not applied to requests served by Worker code, even when the
request URL matches a rule.

Every redirect candidate is, by definition, a path with no matching built file.
Those requests fall straight through asset routing into the Worker, which is
exactly the case Cloudflare excludes. So the rules can never fire.

Proven on staging, July 28, 2026:

| Probe | Result | Conclusion |
|---|---|---|
| `/llms.txt` content-type is `text/plain` | `_headers` is active | `public/` ships to the edge correctly |
| A built page carries `referrer-policy`, `x-frame-options` | asset routing serves it | `_headers` applies to assets |
| A 404 carries `x-astro-reroute: no` and none of the `_headers` values | Astro's runtime answers | non-asset paths are Worker-served |
| All four rules reformatted to bare single-space lines | still 404 | formatting was not the cause |

`public/_redirects` is kept in the repo but is **inert**. Do not add rules to
it expecting them to work.

## Current rules

| From | To | Why |
|---|---|---|
| `/ai-governance/data-management-frameworks/dcam-2/` | `.../dcam/` | Retired duplicate slug. Live and returning 200 on WordPress, so a 404 after cutover would break URL parity and drop an indexed page. Canonical target recorded in `srj-content/governance/_meta.json` under `retired_duplicates`. |
| `/ai-governance/sector-rules/ecoa-ai-2/` | `.../ecoa-ai/` | Same. |
| `/ai-governance/vendor-disclosure/aibom-2/` | `.../aibom/` | Same. |
| `/resources/ai-glossary/` | `/ai-resources/ai-glossary/` | The glossary moves into the new hub namespace. Content is a 1:1 carry, only the URL changes, so every external citation and AI-crawler reference to the WordPress URL keeps resolving. |

Keys and destinations both carry trailing slashes, matching
`trailingSlash: 'always'`.

## Not redirected, deliberately

`/ai-governance/ai-tools/` and `/ai-resources/ai-tools/` are two different
pages with two different jobs, and neither redirects to the other. The
governance one is the reference library's own entry and mirrors WordPress
exactly at 317 tools with no vendor links. The `/ai-resources/` one is the
tools market catalog: the full 320-row dataset with verified vendor URLs, and
it is one of the three sections the migration is allowed to improve on.

## Verifying

A local `astro build` does not prove a redirect works. Check the deployed site:

```
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' \
  https://srj-site.srjordan.workers.dev/resources/ai-glossary/
```

A working rule returns `301` plus the destination. A `404` means the rule was
not applied. A `200` with a meta-refresh body means Astro emitted a redirect
*page* rather than a real 301, which would fail SEO parity and needs the
Worker to handle the status directly instead.
