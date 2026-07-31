// AI Lawsuit Database routes. Static segments outrank the library's rest
// param, so /ai-governance/ai-lawsuits/* renders here while everything else
// stays with ../[...slug].ts. Each page is a synthetic governance entry fed
// through the same detailHtml chrome, which buys the breadcrumbs, schema
// graph, styling, and Free AI Resources panel for free.
//
// Data: src/content/lawsuits/lawsuits.json, published nightly by the
// srj-pipeline publish_lawsuits stage. The glob is optional on purpose: if
// the feed has not been published yet the build skips these routes instead
// of failing, matching how the news pages degrade.
import type { APIRoute } from 'astro';
import { detailHtml } from '../render';
import { caseBody, indexBody, methodologyBody, type Case } from './caseHtml';

export const prerender = true;

const mods = import.meta.glob('../../../content/lawsuits/lawsuits.json', { eager: true });
const doc = (Object.values(mods)[0] as any)?.default as { generated: string; cases: Case[] } | undefined;

const METHOD_SLUG = 'top-free-platforms-for-court-cases';

function entries() {
  if (!doc?.cases?.length) return null;
  const cases = doc.cases;
  const byCase: Record<string, Case> = Object.fromEntries(cases.map((c) => [c.slug, c]));

  // bySlug feeds detailHtml's breadcrumb lookups; only the parent is needed.
  const parentEntry = {
    slug: 'ai-lawsuits', parent: null, children: [],
    title: 'AI Legal Cases',
    subtitle: 'Active intellectual property, copyright, training data, and privacy lawsuits shaping AI law, tracked against the live court dockets.',
    short: 'The AI Lawsuit Database.',
    seo_title: 'AI Legal Cases | The AI Lawsuit Database',
    meta_description: 'Active AI copyright, training data, and privacy lawsuits tracked case by case against live court dockets, with executive summaries, docket timelines, and links to the public filings.',
    focus_keyword: 'AI lawsuits', citations: [], howto: null,
    body_html: indexBody(cases),
  };
  const bySlug: Record<string, any> = { 'ai-lawsuits': parentEntry };

  const caseEntries = cases.map((c) => ({
    slug: c.slug, parent: 'ai-lawsuits', children: [],
    title: c.case_name,
    subtitle: `${c.court} &middot; Docket ${c.docket}`,
    short: c.executive_summary,
    seo_title: `${c.case_name} | AI Lawsuit Database`,
    meta_description: c.executive_summary.length > 155 ? c.executive_summary.slice(0, 152).replace(/\s+\S*$/, '') + '...' : c.executive_summary,
    focus_keyword: c.case_name.split(' v. ')[0] + ' lawsuit',
    citations: [], howto: null,
    body_html: caseBody(c, byCase),
  }));

  const methodEntry = {
    slug: METHOD_SLUG, parent: 'ai-lawsuits', children: [],
    title: 'Top Free Platforms for Court Cases',
    subtitle: 'The free public sources behind the AI Lawsuit Database, and how to verify any case yourself.',
    short: 'How the AI Lawsuit Database is tracked.',
    seo_title: 'Top Free Platforms for Court Cases | AI Lawsuit Database',
    meta_description: 'The free platforms behind the AI Lawsuit Database: CourtListener and RECAP, Google Scholar case law, JudyRecords, Justia, FindLaw, state court portals, and how to use PACER for free.',
    focus_keyword: 'free court records', citations: [], howto: null,
    body_html: methodologyBody(),
  };

  return { parentEntry, caseEntries, methodEntry, bySlug };
}

export async function getStaticPaths() {
  const e = entries();
  if (!e) return [];
  const paths: any[] = [
    { params: { slug: 'index.html' }, props: { entry: e.parentEntry, bySlug: e.bySlug } },
    { params: { slug: `${e.methodEntry.slug}/index.html` }, props: { entry: e.methodEntry, bySlug: e.bySlug } },
  ];
  for (const c of e.caseEntries) {
    paths.push({ params: { slug: `${c.slug}/index.html` }, props: { entry: c, bySlug: e.bySlug } });
  }
  return paths;
}

export const GET: APIRoute = ({ props }) => {
  const { entry, bySlug } = props as any;
  return new Response(detailHtml(entry, bySlug), { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
};
