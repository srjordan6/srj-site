// One endpoint renders the whole library from the transplanted WP chrome.
// Endpoints emit files, so every path targets .../index.html explicitly,
// preserving the /trailing-slash/ URL shape.
import { getCollection } from 'astro:content';
import type { APIRoute } from 'astro';
import { detailHtml, hubHtml } from './render';

// Hybrid output: endpoints must opt into static generation explicitly.
export const prerender = true;

export async function getStaticPaths() {
  const all = await getCollection('governance');
  const bySlug = Object.fromEntries(all.map((e) => [e.data.slug, e.data]));
  const paths = all.map((e) => {
    const d = e.data;
    const p = d.parent ? `${d.parent}/${d.slug}` : d.slug;
    return { params: { slug: `${p}/index.html` }, props: { kind: 'detail', entry: d, bySlug } };
  });
  paths.push({ params: { slug: 'index.html' }, props: { kind: 'hub', entry: null as any, bySlug } });
  return paths;
}

export const GET: APIRoute = ({ props }) => {
  const { kind, entry, bySlug } = props as any;
  const html = kind === 'hub' ? hubHtml() : detailHtml(entry, bySlug);
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
};
