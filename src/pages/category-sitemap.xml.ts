// category-sitemap.xml — the eight blog category archives.
import type { APIRoute } from 'astro';
import { migratedPaths, isCategory, xmlUrlset, xmlHeaders } from '../lib/sitemapSplit';

export const GET: APIRoute = async () =>
  new Response(xmlUrlset(migratedPaths().filter(isCategory)), { headers: xmlHeaders });
