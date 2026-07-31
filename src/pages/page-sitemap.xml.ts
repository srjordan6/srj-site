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

// intel.json is optional at build time (absent before the first publish), so
// the vendor-news URLs are derived through a tolerant glob, never a hard import.
const intelMods = import.meta.glob('../content/intel/intel.json', { eager: true });
const intelDoc: any = Object.values(intelMods)[0]?.default ?? null;

const slugify = (s: string) =>
  s.replace(/&/g, ' and ').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[\s_-]+/g, '-');

export const GET: APIRoute = async () => {
  // /ai-resources/everything-else/ removed July 31, 2026: renamed AI Vendor
  // News; the old URL 301s to /ai-resources/ai-vendor-news/.
  const urls: string[] = [
    '/', '/ai-governance/', '/ai-resources/',
    '/ai-resources/ai-glossary/', '/ai-resources/ai-news/', '/ai-resources/ai-people/',
    '/ai-resources/ai-events/', '/ai-resources/ai-vendor-news/', '/ai-resources/ai-tools/',
  ];

  // Must produce the same slug as [vendor].astro, so it uses the same
  // algorithm, not the tool-category slugify above.
  const vendorSlug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  for (const v of new Set(
    ((intelDoc?.items ?? []) as any[]).map((i) => i.vendor || 'Other vendors')
  )) {
    urls.push(`/ai-resources/ai-vendor-news/${vendorSlug(v as string)}/`);
  }

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
