// Sitemap for the new stack, generated from the content collection plus
// the static routes. URLs are production-domain: this file takes effect
// for search engines only when the sitemap path itself cuts over.
import { getCollection } from 'astro:content';
import type { APIRoute } from 'astro';

export const GET: APIRoute = async () => {
  const gov = await getCollection('governance');
  const urls: string[] = ['/', '/ai-governance/', '/ai-resources/',
    '/ai-resources/ai-glossary/', '/ai-resources/ai-news/', '/ai-resources/ai-people/',
    '/ai-resources/ai-events/', '/ai-resources/everything-else/'];
  for (const e of gov) {
    const d = e.data;
    urls.push(d.parent ? `/ai-governance/${d.parent}/${d.slug}/` : `/ai-governance/${d.slug}/`);
  }
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.sort().map((u) => `  <url><loc>https://srjconsultingservices.com${u}</loc></url>`).join('\n') +
    `\n</urlset>\n`;
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=UTF-8' } });
};
