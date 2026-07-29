import glossary from '../content/resources/glossary.json';
import tools from '../content/resources/tools.json';

const SITE = 'https://srjconsultingservices.com';

function artifact(body: unknown): Response {
  return new Response(JSON.stringify(body, null, 1), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'access-control-allow-origin': '*',
    },
  });
}

function govUrl(entry: any): string {
  const p = entry.parent ? `${entry.parent}/${entry.slug}` : entry.slug;
  return `${SITE}/ai-governance/${p}/`;
}

export function buildGlossary() {
  const terms = (glossary as any).terms ?? [];
  return artifact({
    corpus: 'glossary', count: terms.length, generated_at: new Date().toISOString(),
    categories: (glossary as any).categories ?? [],
    terms: terms.map((t: any) => ({
      term: t.term, slug: t.slug, category: t.category, definition: t.definition,
      example: t.example ?? null, origin: t.origin ?? null,
      url: `${SITE}/ai-resources/ai-glossary/#${t.slug}`,
    })),
  });
}

export function buildTools() {
  const list = (tools as any).tools ?? [];
  return artifact({
    corpus: 'tools', count: list.length, generated_at: new Date().toISOString(),
    categories: (tools as any).categories ?? [],
    tools: list.map((t: any) => ({
      name: t.name, vendor: t.vendor ?? null, category: t.category,
      jurisdiction: t.jurisdiction ?? null, note: t.note ?? null,
      vendor_url: t.url ?? null, url: `${SITE}/ai-resources/ai-tools/`,
    })),
  });
}

export function buildLaws(entries: any[]) {
  const bySlug: Record<string, any> = Object.fromEntries(entries.map((e) => [e.slug, e]));
  return artifact({
    corpus: 'laws', count: entries.length, generated_at: new Date().toISOString(),
    laws: entries.map((e, i) => ({
      law_name: e.title, slug: e.slug,
      category: e.parent ? bySlug[e.parent]?.title ?? '' : '',
      url: govUrl(e), sort_order: i,
    })),
  });
}
