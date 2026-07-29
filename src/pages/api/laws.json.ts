import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { buildLaws } from '../../lib/syncArtifacts';
export const prerender = true;
export const GET: APIRoute = async () => {
  const all = await getCollection('governance');
  return buildLaws(all.map((e) => e.data));
};
