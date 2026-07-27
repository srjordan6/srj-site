import { defineConfig } from 'astro/config';

// srjconsultingservices.com — static output for Cloudflare Pages.
// No adapter needed: pure static build, deployed from dist/.
export default defineConfig({
  site: 'https://srjconsultingservices.com',
  output: 'static',
  trailingSlash: 'always',   // preserves WordPress URL shape exactly (migration gate 1)
  build: {
    format: 'directory',     // /ai-governance/eu-ai-act/ -> .../eu-ai-act/index.html
  },
});
