import { defineCollection, z } from 'astro:content';

// Governance library: JSON data collection, one file per page.
// body_html is verbatim from the WordPress config export (parity by
// construction). _meta.json is read directly by the hub, not part of
// the collection schema.
const governance = defineCollection({
  type: 'data',
  schema: z.object({
    slug: z.string(),
    title: z.string(),
    subtitle: z.string(),
    short: z.string(),
    parent: z.string().nullable(),
    children: z.array(z.string()),
    seo_title: z.string().nullable(),
    meta_description: z.string().nullable(),
    focus_keyword: z.string().nullable(),
    citations: z.array(z.any()),
    howto: z.any().nullable(),
    body_html: z.string(),
  }),
});

export const collections = { governance };
