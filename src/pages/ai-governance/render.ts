// Shared renderer for the transplanted WP chrome.
// Templates are imported as raw strings at build time (Vite ?raw), because
// the Cloudflare adapter forbids node:fs in bundled code.
import detailTpl from '../../templates/gov-detail.tpl.html?raw';
import hubTpl from '../../templates/gov-hub.tpl.html?raw';
import { govSchema } from '../../lib/govSchema';
import { entityNodes, webPageNode } from '../../lib/entityGraph';
import { rewriteAssets } from '../../lib/assets';
import { type Case } from './ai-lawsuits/caseHtml';

// The lawsuits feed is optional at build time; the hub section renders only
// when publish_lawsuits has shipped lawsuits.json into srj-content.
const lawMods = import.meta.glob('../../content/lawsuits/lawsuits.json', { eager: true });
const lawDoc = (Object.values(lawMods)[0] as any)?.default as { cases: Case[] } | undefined;

const SITE = 'https://srjconsultingservices.com';
const esc = (s: string) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function detailHtml(entry: any, bySlug: Record<string, any>): string {
  const tpl = detailTpl;
  const path = entry.parent ? `/ai-governance/${entry.parent}/${entry.slug}/` : `/ai-governance/${entry.slug}/`;
  const url = SITE + path;
  const parent = entry.parent ? bySlug[entry.parent] : null;

  // breadcrumbs html + ld
  const crumbs: [string, string | null][] = [['Home', SITE + '/'], ['AI Governance', SITE + '/ai-governance/']];
  if (parent) crumbs.push([parent.title, `${SITE}/ai-governance/${parent.slug}/`]);
  crumbs.push([entry.title, null]);
  const bcHtml = '<nav class="breadcrumbs" aria-label="Breadcrumb"><ol>' +
    crumbs.map(([n, h]) => h ? `<li><a href="${h}">${esc(n)}</a></li>` : `<li><span aria-current="page">${esc(n)}</span></li>`).join('') +
    '</ol></nav>';
  const bcLd = { '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: crumbs.map(([n, h], i) => ({ '@type': 'ListItem', position: i + 1, name: n, ...(h ? { item: h } : {}) })) };

  // children block (parents only), live markup shape
  const kids = (entry.children || []).map((s: string) => bySlug[s]).filter(Boolean);
  const children = kids.length
    ? '<ul class="srjgov-children-list">\n' + kids.map((k: any) =>
        `<li><a href="${url}${k.slug}/">${esc(k.title)}</a><span class="srjgov-child-teaser">${esc(k.short)}</span></li>`).join('\n') + '\n</ul>'
    : '';

  const ld = [bcLd, ...govSchema(entry, url)]
    .map((o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join('\n');

  // Production serves NO meta description on china-ai-regulation, global-ai-laws,
  // and sources. Falling back to entry.short invented one on all three and broke
  // SEO parity. Emit the real value when there is one, and strip the tag outright
  // when there is not, rather than shipping an empty content attribute.
  const html = tpl
    .replaceAll('{{TITLE}}', esc(entry.seo_title || entry.title))
    .replaceAll('{{DESC}}', esc(entry.meta_description || ''))
    .replaceAll('{{URL}}', url)
    .replace('{{JSONLD}}', ld)
    .replace('{{BREADCRUMBS}}', bcHtml)
    .replace('{{LABEL}}', `<div class="label">${esc(parent ? parent.title : 'AI Governance')}</div>`)
    .replace('{{H1}}', esc(entry.title))
    .replace('{{SUBTITLE}}', `<p style="font-family:Poppins,sans-serif;font-size:18px;font-style:italic;color:#7A8A9E;margin:0 0 32px;max-width:760px;">${esc(entry.subtitle)}</p>`)
    .replace('{{BODY}}', entry.body_html)
    .replace('{{CHILDREN}}', children)
    .replaceAll('{{KW}}', esc(entry.focus_keyword || entry.title));

  return entry.meta_description
    ? rewriteAssets(html)
    : rewriteAssets(html.replace(/[ \t]*<meta\s+name=["']description["'][^>]*>\s*\n?/i, ''));
}

// July 31 2026, Stephen's directive: the hub directory lists its category
// cards in alphabetical order. Sorted here at build time rather than by
// hand-reordering the template, so the order survives future template
// refreshes and newly added categories land in the right place by default.
// Plain lowercase comparison, not localeCompare, so the order is stable
// across build environments.
function alphabetizeDir(html: string): string {
  const openIdx = html.indexOf('<div class="srjgov-dir">');
  if (openIdx === -1) return html;
  const seg = html.slice(openIdx);
  const cards = seg.match(/<div class="srjgov-dir-cat">[\s\S]*?<\/div>\s*?\n/g);
  if (!cards || cards.length < 2) return html;
  const key = (c: string) => (c.match(/href="[^"]+">([^<]+)<\/a>/)?.[1] || '').trim().toLowerCase();
  const sorted = [...cards].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const start = seg.indexOf(cards[0]);
  const last = cards[cards.length - 1];
  const end = seg.indexOf(last) + last.length;
  return html.slice(0, openIdx) + seg.slice(0, start) + sorted.join('') + seg.slice(end);
}

export function hubHtml(): string {
  const tpl = alphabetizeDir(hubTpl);
  const url = SITE + '/ai-governance/';

  // The hub emitted only a hand-rolled Organization node and breadcrumbs, so it
  // was the one governance URL still failing schema parity after the detail
  // pages were fixed: production also carries Place, PostalAddress,
  // GeoCoordinates, ImageObject, WebSite, and WebPage here. Use the same shared
  // graph the detail pages and BaseLayout use, so the three cannot drift again.
  const entity = {
    '@context': 'https://schema.org',
    '@graph': [
      ...entityNodes(),
      webPageNode(url, 'AI Governance Reference Library'),
    ],
  };
  const bc = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Home', item: SITE + '/' },
    { '@type': 'ListItem', position: 2, name: 'AI Governance' }] };
  const ld = [entity, bc].map((o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join('\n');
  // The transplanted chrome loads seven stylesheets and three favicons from the
  // WordPress origin. Repointed at the asset bucket here, alongside the body,
  // so the governance pages do not go unstyled the moment the domain moves.
  // July 31 2026, Stephen's directive: the AI Legal Cases section no longer
  // shows on the hub. The database itself is untouched and stays linked from
  // the Free AI Resources index (03. AI Lawsuit Database) sitewide.
  return rewriteAssets(tpl.replace('{{JSONLD}}', ld));
}
