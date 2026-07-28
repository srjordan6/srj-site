# Redirects

`public/_redirects` is deliberately kept bare: rules only, no comments, no
column alignment. Cloudflare parses that file at the edge and an unexpected
token can cause rules to be dropped silently, so the explanation lives here
instead of inline.

Cloudflare supports `_redirects` natively for Workers with static assets,
the same as for Pages, provided the file lands in the deployed asset
directory. Astro copies everything in `public/` into `dist/`, so authoring it
in `public/` is correct. `_headers` ships from the same directory and is
confirmed working in production (it sets the `text/plain` content type on
`/llms.txt`), which proves the file reaches the edge.

## Current rules

| From | To | Why |
|---|---|---|
| `/ai-governance/data-management-frameworks/dcam-2/` | `.../dcam/` | Retired duplicate slug. Live and returning 200 on WordPress, so a 404 after cutover would break URL parity and drop an indexed page. Canonical target recorded in `srj-content/governance/_meta.json` under `retired_duplicates`. |
| `/ai-governance/sector-rules/ecoa-ai-2/` | `.../ecoa-ai/` | Same. |
| `/ai-governance/vendor-disclosure/aibom-2/` | `.../aibom/` | Same. |
| `/resources/ai-glossary/` | `/ai-resources/ai-glossary/` | The glossary moves into the new hub namespace. Content is a 1:1 carry, only the URL changes, so every external citation and AI-crawler reference to the WordPress URL keeps resolving. |

## Not redirected, deliberately

`/ai-governance/ai-tools/` and `/ai-resources/ai-tools/` are two different
pages with two different jobs, and neither redirects to the other. The
governance one is the reference library's own entry and mirrors WordPress
exactly at 317 tools with no vendor links. The `/ai-resources/` one is the
tools market catalog: the full 320-row dataset with verified vendor URLs, and
it is one of the three sections the migration is allowed to improve on.

## Verifying

Rules are applied by Cloudflare, not by the build, so a local `astro build`
proves nothing. Check against the deployed site after the build lands:

```
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' \
  https://srj-site.srjordan.workers.dev/resources/ai-glossary/
```

A working rule returns `301` plus the destination. A `404` means the rule was
not applied, and the first thing to check is whether the Cloudflare project's
configured build output directory is the same `dist/` that receives `public/`.
