// Rank Math's sitemap URL set, preserved.
//
// WHY THIS EXISTS. Search Console has these exact paths registered:
// /sitemap_index.xml and the four child sitemaps beneath it. Replacing them
// with a single /sitemap.xml would make every registered sitemap 404 on the day
// the domain moves, and the loss is not cosmetic: Google drops URLs it can no
// longer confirm are in a sitemap, and the recovery is a recrawl of 138 pages.
//
// So the shape is kept. Membership is generated from the same data the routes
// are generated from, not from the WordPress export, so it cannot drift; but
// which page belongs to which child sitemap is Rank Math's own split, captured
// from production on 2026-07-28 and encoded below.
//
// The split is not derivable from the URL. /insights/ is a post, /about/ is a
// page, and /ai-audit-free-beta/ is a post despite reading like a landing page,
// because WordPress post type is what decides, not the path. Guessing would put
// pages in the wrong child sitemap, which is a silent inconsistency with what
// Search Console already has.
import migrated from '../content/migrated/migrated-pages.json';

export const SITE = 'https://srjconsultingservices.com';

/** Paths Rank Math places in post-sitemap.xml. Everything else in the migrated
 *  set that is not a category archive is a page. */
export const POST_PATHS = new Set([
  '/insights/',
  '/ai-audit-free-beta/',
  '/ai-maturity-assessment/',
  '/ai-readiness-assessment-baseline/',
  '/srj-consulting-is-transitioning-fully-to-ai-advisory/',
  '/ai-governance-audit-gap/',
  '/ai-governance-for-executives/',
  '/ai-pilot-to-production-ey-microsoft-1b-signal/',
  '/shadow-ai-breach-cost-governance/',
  '/srj-consulting-services-now-live/',
  '/why-we-are-not-an-ai-tool-vendor-and-why-that-matters-to-your-leadership-team/',
]);

export const migratedPaths = (): string[] =>
  ((migrated as any).pages ?? []).map((p: any) => p.path);

export const isCategory = (p: string) => p.startsWith('/category/');

export function xmlUrlset(paths: string[]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><?xml-stylesheet type="text/xsl" href="//srjconsultingservices.com/main-sitemap.xsl"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    [...new Set(paths)].sort().map((u) => `\t<url>\n\t\t<loc>${SITE}${u}</loc>\n\t</url>`).join('\n') +
    `\n</urlset>\n`
  );
}

export const xmlHeaders = {
  'Content-Type': 'application/xml; charset=UTF-8',
};
