import type { APIRoute } from 'astro';
import { buildGlossary } from '../../lib/syncArtifacts';
export const prerender = true;
export const GET: APIRoute = () => buildGlossary();
