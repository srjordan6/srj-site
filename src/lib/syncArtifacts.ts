/**
 * Platform sync artifacts. Gate 19 of the architecture package:
 *
 *   "Platform sync parity: audit platform ingests glossary=522, tools=320,
 *    laws=63 from the new JSON endpoints before WP's are retired."
 *
 * The package offered two directions and recommended this one:
 *
 *   (a) the build publishes the same JSON as static artifacts at stable URLs,
 *       and the platform pulls those  <-- this file
 *   (b) invert: platform Postgres becomes canonical and the site builds from it
 *
 * (a) wins because it needs no platform change beyond a URL, and because the
 * content repo is already the single source the site renders from. Adding a
 * second writer would recreate the dual-truth failure the whole replatform is
 * meant to retire.
 *
 * WHAT THE PLATFORM ALREADY DOES, verified against srj_audit on 2026-07-29
 * rather than assumed. Its synced_* tables are append-with-supersession: rows
 * that leave the payload are marked is_active = false and kept. Counts were:
 *
 *   corpus     active   total     content repo
 *   glossary      522     536              522   exact match
 *   tools         320     634              320   exact match
 *   laws           66      73               63   +3, see below
 *
 * So these endpoints must emit the CURRENT set only. The platform handles
 * retirement. Emitting history here would resurrect superseded rows.
 *
 * THE THREE EXTRA LAWS are duplicate URLs already in the platform, not missing
 * content: NIS2 / "NIS2 Directive", AI Tools / "AI Tools Catalog", and
 * "four matter" / Federal AI Legislation. The last is a parsing artifact whose
 * name is not a law. All three pairs resolve to one governance page each, so 63
 * is correct and the next sync retires the strays on its own.
 *
 * URLS ARE ABSOLUTE, and that is the point of the exercise: the platform's
 * stored URLs currently all say srjconsultingservices.com, which is right both
 * before and after cutover because the domain does not change. Only the origin
 * serving it does.
 */
import glossary from '../content/resources/glossary.json';
import tools from '../content/resources/tools.json';

const SITE = 'https://srjconsultingservices.com';

/** Stable JSON response with a short cache: the platform polls, it does not stream. */
function artifact(body: unknown): Response {
  return new Response(JSON.stringify(body, null, 1), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'access-control-allow-origin': '*',
    },
  });
}

/**
 * Governance page URL.
 *
 * ONE level of parent, matching src/pages/ai-governance/[...slug].ts exactly:
 *
 *   const p = d.parent ? `${d.parent}/${d.slug}` : d.slug;
 *
 * An earlier draft walked the parent chain recursively, which would have
 * emitted URLs the site does not serve for any grandchild entry. The route is
 * the authority on its own shape; this mirrors it rather than reasoning about
 * what the nesting ought to be.
 */
function govUrl(entry: any): string {
  const p = entry.parent ? `${entry.parent}/${entry.slug}` : entry.slug;
  return `${SITE}/ai-governance/${p}/`;
}

export function buildGlossary() {
  const terms = (glossary as any).terms ?? [];
  return artifact({
    corpus: 'glossary',
    count: terms.length,
    generated_at: new Date().toISOString(),
    categories: (glossary as any).categories ?? [],
    terms: terms.map((t: any) => ({
      term: t.term,
      slug: t.slug,
      category: t.category,
      definition: t.definition,
      example: t.example ?? null,
      origin: t.origin ?? null,
      url: `${SITE}/ai-resources/ai-glossary/#${t.slug}`,
    })),
  });
}

export function buildTools() {
  const list = (tools as any).tools ?? [];
  return artifact({
    corpus: 'tools',
    count: list.length,
    generated_at: new Date().toISOString(),
    categories: (tools as any).categories ?? [],
    tools: list.map((t: any) => ({
      name: t.name,
      vendor: t.vendor ?? null,
      category: t.category,
      jurisdiction: t.jurisdiction ?? null,
      note: t.note ?? null,
      // The vendor's own site. Distinct from url below, which is ours.
      vendor_url: t.url ?? null,
      url: `${SITE}/ai-resources/ai-tools/`,
    })),
  });
}

export function buildLaws(entries: any[]) {
  const bySlug: Record<string, any> = Object.fromEntries(entries.map((e) => [e.slug, e]));
  return artifact({
    corpus: 'laws',
    count: entries.length,
    generated_at: new Date().toISOString(),
    laws: entries.map((e, i) => ({
      law_name: e.title,
      slug: e.slug,
      category: e.parent ? bySlug[e.parent]?.title ?? '' : '',
      url: govUrl(e),
      sort_order: i,
    })),
  });
}
