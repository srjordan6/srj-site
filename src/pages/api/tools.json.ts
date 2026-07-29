import type { APIRoute } from 'astro';
import { buildTools } from '../../lib/syncArtifacts';
export const prerender = true;
export const GET: APIRoute = () => buildTools();
