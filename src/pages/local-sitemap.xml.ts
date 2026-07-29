// local-sitemap.xml — the KML placemark, Rank Math's local-SEO entry.
import type { APIRoute } from 'astro';
import { xmlUrlset, xmlHeaders } from '../lib/sitemapSplit';

export const GET: APIRoute = async () =>
  new Response(xmlUrlset(['/locations.kml']), { headers: xmlHeaders });
