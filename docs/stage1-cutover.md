# Stage-1 Cutover Runbook: /ai-governance/* to the edge

Status: DRAFT, execute only on explicit go after the soak checklist below.
Scope: routes /ai-governance/* on srjconsultingservices.com to the srj-site
worker. Every other path continues to WordPress unchanged. Rollback is one
route deletion.

## Prerequisite, one-time: the domain onto Cloudflare DNS

Per-path routing requires the zone on Cloudflare. This is a nameserver move,
not a registrar transfer; GoDaddy stays the registrar.

1. Cloudflare dashboard -> Add a domain -> srjconsultingservices.com -> Free plan.
2. Cloudflare scans and imports DNS records. VERIFY against GoDaddy's DNS
   panel before proceeding: the A/CNAME for the site root (which points at
   the Sucuri WAF, keeping the WAF chain intact), www, mail records (MX,
   SPF/TXT, DKIM), and any service records. Add anything the scan missed.
3. Keep the site A/CNAME records PROXIED (orange cloud). The chain becomes
   visitor -> Cloudflare -> Sucuri -> GoDaddy, identical content, and the
   WAF keeps working until decommission.
4. At GoDaddy -> Domain -> Nameservers -> change to the two Cloudflare
   nameservers shown. Propagation minutes to hours. NOTHING routes
   differently yet; Cloudflare passes everything to the same origin.
5. Wait for the zone to show Active. Verify the live site end to end
   (home, a governance page, contact form, /wp-admin) before any routing.

## Soak checklist, all must hold before the route

- [ ] Zone Active >= 48 hours with the site fully normal
- [ ] Email verified sending and receiving after the NS move
- [ ] parity gate on staging: node scripts/parity-gate.mjs <staging> -> 0 fail
- [ ] Stephen has clicked through staging library and approved visually
- [ ] GSC unchanged (no new coverage errors from the NS move)

## The cutover, ~5 minutes

1. Workers & Pages -> srj-site -> Settings -> Domains & Routes -> Add route:
   route: srjconsultingservices.com/ai-governance*    zone: srjconsultingservices.com
   (The trailing * covers the hub and every subpath.)
2. Verify immediately from a clean browser:
   - /ai-governance/ shows the NEW template (navy header, search box)
   - /ai-governance/state-ai-laws/colorado-ai-act/ correct, with schema
     (view-source: application/ld+json blocks present)
   - Any NON-governance page (/, /books/, /contact/) still WordPress
3. Run the gate against production: node scripts/parity-gate.mjs https://srjconsultingservices.com
   Expect 61 of 64 (the three -2 duplicates now 404 from the worker; add
   their 301s to public/_redirects in the same deploy to make it 64).
4. Watch for 24h: GSC coverage, GA4 realtime on governance pages, worker
   errors in the Cloudflare dashboard.

## Rollback, ~1 minute

Delete the route. Traffic returns to WordPress on the next request. Nothing
else to undo; WordPress never stopped serving the pages underneath.

## After 7 clean days

- Submit the sitemap URL in GSC (unchanged address, new generator).
- Mark stage 1 complete in the architecture log; begin stage 2 (glossary,
  tools catalog, /resources/ hub move with 301s).
- WordPress governance pages become read-only reference; all governance
  edits happen in srj-content from this point.
