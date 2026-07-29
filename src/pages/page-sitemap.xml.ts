// page-sitemap.xml — every page that is not a post and not a category archive.
//
// This is the large one: the home page, the governance library, the migrated
// pages, and the AI Tools catalog with its category and profile pages. All of
// it is derived from the same imports the routes use, so a page cannot ship
// without appearing here.
import { getCollection } from 'astro:content';
import type { APIRoute } from 'astro';
import { POST_PATHS, migratedPaths, isCategory, xmlUrlset, xmlHeaders } from '../lib/sitemapSplit';
import tools from '../content/resources/tools.json';
import profileDoc from '../content/resources/tool-profiles.json';

const slugify = (s: string) =>
  s.replace(/&/g, ' and ').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[\s_-]+/g, '-');

export const GET: APIRoute = async () => {
  const urls: string[] = [
    '/', '/ai-governance/', '/ai-resources/',
    '/ai-resources/ai-glossary/', '/ai-resources/ai-news/', '/ai-resources/ai-people/',
    '/ai-resources/ai-events/', '/ai-resources/everything-else/', '/ai-resources/ai-tools/',
  ];

  for (const e of await getCollection('governance')) {
    const d = e.data;
    urls.push(d.parent ? `/ai-governance/${d.parent}/${d.slug}/` : `/ai-governance/${d.slug}/`);
  }

  for (const p of migratedPaths()) {
    if (!POST_PATHS.has(p) && !isCategory(p) && p !== '/locations.kml') urls.push(p);
  }

  const rows: any[] = (tools as any).tools ?? [];
  for (const c of new Set(rows.map((t) => t.category))) {
    urls.push(`/ai-resources/ai-tools/${slugify(c as string)}/`);
  }
  for (const slug of Object.keys((profileDoc as any).profiles ?? {})) {
    urls.push(`/ai-resources/ai-tools/${slug}/`);
  }

  return new Response(xmlUrlset(urls), { headers: xmlHeaders });
};
