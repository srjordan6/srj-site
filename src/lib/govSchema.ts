// Port of srj-ai-governance-schema.php (v1.1.0) to the static build.
// Emits the identical graph: Article (+ScholarlyArticle citations),
// HowTo (from the config's howto key), FAQPage (parsed from the body's
// "Frequently asked questions" H3/P pairs), plus the site-wide entity nodes.
//
// The entity nodes are NOT inherited from BaseLayout. Governance pages render
// through src/pages/ai-governance/[...slug].ts and templates/gov-*.tpl.html,
// which never touch BaseLayout, so anything emitted only there is absent here.
// That is exactly what the July 28, 2026 parity crawl found: all 67 governance
// URLs were missing Place, PostalAddress, GeoCoordinates, ImageObject, and
// WebSite against production. Both render paths now import the same module.

import { entityNodes, webPageNode } from './entityGraph';

const strip = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  .replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, "\u2019").replace(/&#8220;|&ldquo;/g, "\u201C")
  .replace(/&#8221;|&rdquo;/g, "\u201D").replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

export function govSchema(entry: any, url: string): object[] {
  const title = entry.seo_title || entry.title;
  const desc = entry.meta_description || '';
  const kw = entry.focus_keyword || '';
  const graph: any[] = [];

  const citations = (entry.citations || []).map((c: any) => ({
    '@type': 'ScholarlyArticle',
    name: c.journal || '',
    author: { '@type': 'Person', name: c.author || '' },
    datePublished: c.year || '',
    url: c.url || '',
    isPartOf: { '@type': 'Periodical', name: c.journal || '' },
  }));

  const article: any = {
    '@type': 'Article',
    '@id': url + '#article',
    headline: title,
    description: desc,
    about: kw,
    keywords: kw,
    inLanguage: 'en-US',
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    author: { '@type': 'Person', '@id': 'https://srjconsultingservices.com/#stephen', name: 'Stephen R. Jordan' },
    publisher: { '@type': 'Organization', name: 'SRJ Consulting & Services LLC', url: 'https://srjconsultingservices.com/' },
  };
  if (citations.length) article.citation = citations;
  graph.push(article);

  if (entry.howto?.steps?.length) {
    graph.push({
      '@type': 'HowTo',
      '@id': url + '#howto',
      name: entry.howto.name || 'How to comply with ' + kw,
      description: 'A practical sequence for bringing an organization into compliance with ' + kw + '.',
      step: entry.howto.steps.map((s: any, i: number) => ({
        '@type': 'HowToStep', position: i + 1, name: s.name || '', text: strip(s.text || ''), url: `${url}#step-${i + 1}`,
      })),
    });
  }

  const faq = extractFaq(entry.body_html || '');
  if (faq.length) graph.push({ '@type': 'FAQPage', '@id': url + '#faq', mainEntity: faq });

  // Site-wide entity nodes and the per-URL WebPage node, matching production.
  // desc is '' when the entry carries no meta_description, and webPageNode
  // drops the property in that case rather than emitting an empty string,
  // which is what production does on its ten description-less pages.
  graph.push(...entityNodes());
  graph.push(webPageNode(url, title, desc || null));

  return [{ '@context': 'https://schema.org', '@graph': graph }];
}

function extractFaq(body: string) {
  const m = body.match(/<h2[^>]*>\s*Frequently asked questions/i);
  if (!m || m.index === undefined) return [];
  const tail = body.slice(m.index);
  const parts = tail.split(/<h2[^>]*>/i);
  if (parts.length < 2) return [];
  const block = parts[1];
  const out: any[] = [];
  const re = /<h3[^>]*>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/gi;
  let p;
  while ((p = re.exec(block)) !== null) {
    const q = strip(p[1]); const a = strip(p[2]);
    if (q && a) out.push({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } });
  }
  return out;
}
