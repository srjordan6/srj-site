// post-sitemap.xml — the eleven WordPress posts, matching Rank Math's split.
import type { APIRoute } from 'astro';
import { POST_PATHS, migratedPaths, xmlUrlset, xmlHeaders } from '../lib/sitemapSplit';

export const GET: APIRoute = async () =>
  new Response(
    xmlUrlset(migratedPaths().filter((p) => POST_PATHS.has(p))),
    { headers: xmlHeaders }
  );
