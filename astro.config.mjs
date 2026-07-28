import { defineConfig } from 'astro/config';

// srjconsultingservices.com — static output, deployed to a Cloudflare Worker
// with static assets.
//
// Redirects are declared HERE, not in public/_redirects. The deployment is a
// Worker, and Cloudflare does not apply _redirects to any request its Worker
// code serves. Every redirect candidate is by definition a path with no
// matching asset, so those requests fall through to the Worker and the
// _redirects rules are bypassed entirely. Proven on staging July 28, 2026:
// all four rules returned 404, while _headers from the same directory worked,
// and the 404 response carried the x-astro-reroute header, which identifies
// Astro's runtime as the responder. See docs/redirects.md.
export default defineConfig({
  site: 'https://srjconsultingservices.com',
  output: 'static',
  trailingSlash: 'always',   // preserves WordPress URL shape exactly (migration gate 1)
  build: {
    format: 'directory',     // /ai-governance/eu-ai-act/ -> .../eu-ai-act/index.html
  },
  redirects: {
    // Retired duplicate governance slugs. All three are live and returning 200
    // on WordPress, so a 404 after cutover would break URL parity and drop an
    // indexed page. Canonical targets come from srj-content/governance/
    // _meta.json retired_duplicates.
    '/ai-governance/data-management-frameworks/dcam-2/': {
      status: 301,
      destination: '/ai-governance/data-management-frameworks/dcam/',
    },
    '/ai-governance/sector-rules/ecoa-ai-2/': {
      status: 301,
      destination: '/ai-governance/sector-rules/ecoa-ai/',
    },
    '/ai-governance/vendor-disclosure/aibom-2/': {
      status: 301,
      destination: '/ai-governance/vendor-disclosure/aibom/',
    },
    // The glossary moves from the WordPress /resources/ namespace into the new
    // /ai-resources/ hub. Content is a 1:1 carry, only the URL changes, so
    // every external citation to the old address keeps resolving.
    '/resources/ai-glossary/': {
      status: 301,
      destination: '/ai-resources/ai-glossary/',
    },
  },
});
