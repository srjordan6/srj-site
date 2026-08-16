// Sitemap for the new stack.
//
// This is generated from the same data the pages are generated from, never from
// a hand-kept list. That is deliberate: the previous version enumerated eight
// static routes by hand and pulled the governance collection, so when Stage 2
// added 68 migrated pages and the tool catalog added 63 profiles and 23 category
// pages, the sitemap silently kept reporting 71 URLs. A sitemap that is edited
// separately from the routes will always drift, and the drift is invisible
// because the file still validates.
//
// Every source below is the same import the corresponding route uses, so a page
// cannot exist without appearing here.
//
// URLs carry the production domain. This file only takes effect for search
// engines once the sitemap path itself cuts over.
import { getCollection } from 'astro:content';
import type { APIRoute } from 'astro';
import migrated from '../content/migrated/migrated-pages.json';
import tools from '../content/resources/tools.json';
import profileDoc from '../content/resources/tool-profiles.json';

const SITE = 'https://srjconsultingservices.com';

const slugify = (s: string) =>
  s.replace(/&/g, ' and ').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[\s_-]+/g, '-');

export const GET: APIRoute = async () => {
  const urls = new Set<string>();

  // Hubs. August 14, 2026: the governance library and the /ai-resources/
  // sections migrated to theworldofai.org and 301 there, so they are gone from
  // here on the same principle the note below already states, a sitemap lists
  // canonical destinations and never the URLs that only point elsewhere. The
  // /ai-resources/ hub stays because it is still a live 200 page.
  for (const u of ['/', '/ai-resources/']) urls.add(u);

  // Stage 2 migrated pages: About, Books, Services, Industries, categories,
  // Insights posts, legal pages, singletons.
  for (const p of ((migrated as any).pages ?? [])) urls.add(p.path);

  // The three governance redirects are deliberately absent: a sitemap lists
  // canonical destinations, and listing a 301 asks the crawler to fetch a URL
  // whose only job is to point somewhere else.
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    [...urls].sort().map((u) => `  <url><loc>${SITE}${u}</loc></url>`).join('\n') +
    `\n</urlset>\n`;
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=UTF-8' } });
};
