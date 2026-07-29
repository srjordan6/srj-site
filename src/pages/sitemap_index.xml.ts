// sitemap_index.xml — the entry point Search Console has registered.
//
// lastmod is the build time rather than a per-sitemap content date. Rank Math
// tracked real modification times from the WordPress post table, which does not
// exist here. Emitting a build timestamp is honest about what it means: the
// date this index was generated. Inventing per-child dates would be worse, since
// a wrong lastmod actively misleads a crawler about what has changed.
import type { APIRoute } from 'astro';
import { SITE } from '../lib/sitemapSplit';

const CHILDREN = ['post-sitemap.xml', 'page-sitemap.xml', 'category-sitemap.xml', 'local-sitemap.xml'];

export const GET: APIRoute = async () => {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const body =
    `<?xml version="1.0" encoding="UTF-8"?><?xml-stylesheet type="text/xsl" href="//srjconsultingservices.com/main-sitemap.xsl"?>\n` +
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    CHILDREN.map((c) => `\t<sitemap>\n\t\t<loc>${SITE}/${c}</loc>\n\t\t<lastmod>${now}</lastmod>\n\t</sitemap>`).join('\n') +
    `\n</sitemapindex>\n`;
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=UTF-8' } });
};
