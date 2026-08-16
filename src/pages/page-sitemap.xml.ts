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
  // August 14, 2026: the governance library and every /ai-resources/ section
  // migrated to theworldofai.org and now 301 there from public/_redirects.
  // Their URLs are gone from this sitemap deliberately, because a sitemap that
  // advertises redirected URLs asks Google to keep crawling pages we have told
  // it to leave. The /ai-resources/ hub itself stays: it is a live 200 page.
  const urls: string[] = ['/', '/ai-resources/'];

  for (const p of migratedPaths()) {
    if (!POST_PATHS.has(p) && !isCategory(p) && p !== '/locations.kml') urls.push(p);
  }

  return new Response(xmlUrlset(urls), { headers: xmlHeaders });
};
