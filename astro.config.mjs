import { defineConfig } from 'astro/config';

// srjconsultingservices.com — static output, deployed to a Cloudflare Worker
// with static assets.
//
// REDIRECTS LIVE IN public/_redirects, NOT HERE. History, because it reversed
// once already: the July 28 staging test found _redirects ignored (all four
// rules 404ed with the x-astro-reroute header on the response), so redirects
// moved into this file's `redirects` block. That was the wrong lesson from a
// transient result. Astro static `redirects` emit meta-refresh HTML pages that
// serve as 200s — soft redirects, invisible to status-code checks and worth
// less to crawlers — while _redirects, retested July 30, now yields true 301s
// at the asset layer (proven: /ai-governance/.../dcam-2/ returned a real 301
// from _redirects while /resources/ from this block returned a soft 200). So
// on July 30 every rule was consolidated into public/_redirects, including the
// full WordPress Redirection-plugin export, and this block was retired. Do not
// add redirects here again; see the header of public/_redirects.
export default defineConfig({
  site: 'https://srjconsultingservices.com',
  output: 'static',
  trailingSlash: 'always',   // preserves WordPress URL shape exactly (migration gate 1)
  build: {
    format: 'directory',     // /ai-governance/eu-ai-act/ -> .../eu-ai-act/index.html
  },
});
