# srj-site

Static site for srjconsultingservices.com. Astro 4, deployed to Cloudflare Pages.

- `npm install` then `npm run dev` for local preview
- `npm run build` produces `dist/` (includes Pagefind search index)
- Deploys: Cloudflare Pages builds every push; production branch = `main`
- Migration contract: SRJ-Site-Inventory (July 27, 2026, 138 URLs); per-path
  cutover from WordPress with parity gates. See the architecture package.

Brand: Lora (headlines) / Poppins (body); Navy #201868, Orange #F07800.
