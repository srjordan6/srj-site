// SEO and AEO schema builders for the new /ai-resources/ sections.
//
// The migrated pages inherit whatever WordPress and Rank Math already emitted,
// and parity is the rule there. These sections are new content, so parity does
// not apply and they are held to the full standard instead.
//
// AEO, answer engine optimization, is the reason most of this exists. An answer
// engine cannot cite a page it cannot parse into discrete claims. Three things
// make a reference page citable:
//
//   1. A typed collection. A glossary is a DefinedTermSet of DefinedTerm nodes,
//      not a wall of headings. A catalog is an ItemList. Saying so lets an
//      engine lift a single definition and attribute it, instead of quoting an
//      unlabelled paragraph or skipping the page.
//   2. A direct answer near the top, in one self-contained paragraph that makes
//      sense with no surrounding context, because that is the unit that gets
//      extracted.
//   3. Real questions with real answers, marked as FAQPage, matching the way
//      the question is actually asked.
//
// Breadcrumbs are here too. Every governance page emits BreadcrumbList and none
// of the new sections did, which is both an SEO gap and a structural one: it is
// how a crawler learns these pages are a hub-and-section hierarchy rather than
// 500 loose URLs.

const SITE = 'https://srjconsultingservices.com';

export interface Crumb {
  name: string;
  url?: string; // omitted on the current page, per schema.org guidance
}

/**
 * BreadcrumbList. The last crumb carries no item, marking it as current.
 */
export function breadcrumbList(crumbs: Crumb[]): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      ...(c.url ? { item: c.url.startsWith('http') ? c.url : SITE + c.url } : {}),
    })),
  };
}

/**
 * Derive breadcrumbs from a pathname, so every page gets them without each
 * template hand-rolling a trail that can drift.
 */
const SEGMENT_NAMES: Record<string, string> = {
  'ai-resources': 'AI Resources',
  'ai-governance': 'AI Governance',
  'ai-glossary': 'AI Glossary',
  'ai-tools': 'AI Tools',
  'ai-people': 'AI Movers and Shakers',
  'ai-news': 'AI News',
  'ai-events': 'AI News Events',
  'everything-else': 'Everything Else',
  resources: 'Resources',
};

export function crumbsFromPath(pathname: string, currentName?: string): Crumb[] {
  const parts = pathname.split('/').filter(Boolean);
  const crumbs: Crumb[] = [{ name: 'Home', url: '/' }];
  let acc = '';
  parts.forEach((p, i) => {
    acc += `/${p}`;
    const last = i === parts.length - 1;
    const name = last && currentName ? currentName : SEGMENT_NAMES[p] ?? titleCase(p);
    crumbs.push(last ? { name } : { name, url: `${acc}/` });
  });
  return crumbs;
}

const titleCase = (s: string) =>
  s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * DefinedTermSet, the correct type for a glossary. Each entry is a DefinedTerm
 * with a stable @id pointing at its in-page anchor, which is what lets an answer
 * engine cite one definition rather than the whole page.
 *
 * termCode carries the category so the set stays navigable when flattened.
 */
export function definedTermSet(opts: {
  url: string;
  name: string;
  description: string;
  terms: { term: string; slug: string; category: string; definition: string }[];
}): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'DefinedTermSet',
    '@id': `${opts.url}#glossary`,
    name: opts.name,
    description: opts.description,
    url: opts.url,
    inLanguage: 'en-US',
    publisher: { '@id': `${SITE}/#organization` },
    hasDefinedTerm: opts.terms.map((t) => ({
      '@type': 'DefinedTerm',
      '@id': `${opts.url}#term-${t.slug}`,
      name: t.term,
      description: t.definition,
      termCode: t.category,
      inDefinedTermSet: { '@id': `${opts.url}#glossary` },
    })),
  };
}

/**
 * ItemList for a catalog. position is required for an ordered list to be
 * understood as ranked or sequenced rather than arbitrary.
 */
export function itemList(opts: {
  url: string;
  name: string;
  description: string;
  items: { name: string; url?: string; description?: string; anchor?: string }[];
}): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    '@id': `${opts.url}#list`,
    name: opts.name,
    description: opts.description,
    numberOfItems: opts.items.length,
    itemListOrder: 'https://schema.org/ItemListOrderAscending',
    itemListElement: opts.items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      ...(it.url ? { url: it.url } : {}),
      ...(it.description ? { description: it.description } : {}),
    })),
  };
}

/**
 * FAQPage. Answers are plain text on purpose: answer engines extract the text
 * node, and markup inside it is either stripped or, worse, read literally.
 */
export function faqPage(url: string, qa: { q: string; a: string }[]): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    '@id': `${url}#faq`,
    mainEntity: qa.map(({ q, a }) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  };
}

/**
 * CollectionPage, the right WebPage subtype for a hub or index whose job is to
 * point at a set rather than to argue a thesis.
 */
export function collectionPage(opts: {
  url: string;
  name: string;
  description: string;
  partOfUrl?: string;
}): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    '@id': `${opts.url}#collection`,
    url: opts.url,
    name: opts.name,
    description: opts.description,
    inLanguage: 'en-US',
    isPartOf: { '@id': `${SITE}/#website` },
    about: { '@id': `${SITE}/#organization` },
    ...(opts.partOfUrl ? { breadcrumb: { '@id': `${opts.partOfUrl}#breadcrumb` } } : {}),
  };
}
