/**
 * Cloudflare Worker entry.
 *
 * Two jobs:
 *   1. serve /wp-content/* from R2 at its original paths  (gate 18)
 *   2. handle the form endpoints WordPress used to         (stage 4)
 *
 * GATE 18, verbatim from the architecture package:
 *
 *   "Asset parity: all 216 images + 8 PDFs served from Pages at same paths
 *    (/wp-content/uploads/... preserved verbatim to keep every external
 *    citation and AI-crawler reference alive)."
 *
 * The site references 1,236 assets, about 278 MB, too much to commit and serve
 * as static files. Serving them from the R2 bucket's own public URL would have
 * been easy and wrong: same bytes, different origin, and every external
 * citation to /wp-content/uploads/... dies at cutover. So the path stays on
 * this site and the storage stays in R2.
 *
 * ORDER OF RESOLUTION, and it matters:
 *   1. form endpoints, which must never be shadowed by a static file
 *   2. static assets from the build (env.ASSETS)
 *   3. /wp-content/* from R2
 *   4. otherwise the static handler's own miss behaviour, the 404 page
 */

import {
  handleContact, handleUpload, handleWorksheetAccess, handleWorksheetConfirm,
  handleNewsletter, type FormEnv,
} from './forms';

export interface Env extends FormEnv {
  /** The built site, bound by wrangler's [assets] block. */
  ASSETS: Fetcher;
  /** The migrated WordPress media tree. Public-readable content. */
  MEDIA: R2Bucket;
  /** Bearer token gating /api/archive corpus writes from the pipeline cron. */
  ARCHIVE_TOKEN?: string;
}

/**
 * Content types worth pinning. R2 stores whatever type the uploader set and
 * rclone sets sensible ones, but a missing or generic type on a stylesheet is
 * the difference between a styled page and a plain one, so the cases that
 * matter are not left to chance.
 */
const TYPES: Record<string, string> = {
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const typeFor = (key: string): string | undefined =>
  TYPES[key.slice(key.lastIndexOf('.') + 1).toLowerCase()];

/**
 * Resolve a Range request header to first/last byte positions.
 *
 * WHY THIS PARSES THE HEADER INSTEAD OF READING object.range. Two attempts at
 * deriving Content-Range from R2's returned range object were wrong in
 * different ways, emitting `bytes NaN-17208/17209` and `bytes 0-17208` while
 * the body was a correct 100 bytes. R2 honours the header we hand it, so the
 * header is the authority on what the body contains and cannot disagree with
 * it. Parsing here is deterministic and testable without a deploy.
 *
 * Handles the three forms RFC 9110 allows for a single range:
 *   bytes=0-99     explicit first and last
 *   bytes=100-     first through end of object
 *   bytes=-500     final 500 bytes
 *
 * Returns null for anything unsatisfiable or multi-range, in which case the
 * caller serves the whole object with 200 rather than lying about a partial.
 */
function resolveRange(header: string | null, size: number): { first: number; last: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, startStr, endStr] = m;

  if (startStr === '') {
    if (endStr === '') return null;
    const n = Number(endStr);
    if (!Number.isFinite(n) || n <= 0) return null;
    return { first: Math.max(0, size - n), last: size - 1 };
  }

  const first = Number(startStr);
  if (!Number.isFinite(first) || first >= size) return null;
  const last = endStr === '' ? size - 1 : Math.min(Number(endStr), size - 1);
  if (!Number.isFinite(last) || last < first) return null;
  return { first, last };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 0. Canonical host. WordPress 301'd www to the apex, and the whole site
    //    assumes one host: canonical tags are absolute apex URLs, and the
    //    worksheet-unlock cookie is host-only, minted on the apex by the
    //    confirmation link. Serving www as a second first-class host broke
    //    exactly that: Stephen confirmed on the apex, browsed on www, and the
    //    library stayed locked with the cookie sitting on the other host
    //    (July 30, first gate test after cutover). One permanent redirect
    //    restores the WP behaviour and retires the cookie split.
    if (url.hostname === 'www.srjconsultingservices.com') {
      url.hostname = 'srjconsultingservices.com';
      return Response.redirect(url.toString(), 301);
    }

    // 0b. Corpus archive writes from the srj-pipeline cron. PUT-only, bearer
    // gated, and confined to corpus/ keys in the PRIVATE uploads bucket:
    // archived bodies are third-party press held for internal analysis, and
    // must never land anywhere publicly readable (srj-assets is public).
    if (url.pathname === '/api/archive') {
      if (request.method !== 'PUT') {
        return new Response('Method not allowed', { status: 405, headers: { allow: 'PUT' } });
      }
      const auth = request.headers.get('authorization') ?? '';
      if (!env.ARCHIVE_TOKEN || auth !== `Bearer ${env.ARCHIVE_TOKEN}`) {
        return new Response('Unauthorized', { status: 401 });
      }
      const key = url.searchParams.get('key') ?? '';
      if (!/^corpus\/[A-Za-z0-9._/-]+$/.test(key) || key.includes('..')) {
        return new Response('Bad key', { status: 400 });
      }
      await env.UPLOADS.put(key, request.body, {
        httpMetadata: { contentType: request.headers.get('content-type') ?? 'application/octet-stream' },
      });
      return new Response(JSON.stringify({ ok: true, key }), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    // 0b-temp. One-shot Chapter 05 figure swap for Book 06. REMOVE AFTER USE.
    // Figures 5.6 and 5.7 traded subjects in the manuscript, so this writes
    // the two new originals plus generated previews under their new names and
    // deletes the four objects carrying the old names. Hash-pinned, strict
    // name guard, fixed prefix, live for minutes.
    if (url.pathname === '/api/swap-ch05-figures') {
      const SRC = 'https://x0.at/tiFS.tar';
      const PIN = 'cde73f84d0e00cb8e6c3c02c2b5d3ddc69e3fc6d12affb1ef2b427de3a6cc03f';
      const PREFIX =
        'wp-content/uploads/The_Operating_Discipline_for_AI/The_AI_IT_Security_Implementation_and_Strategy/Graphics/Chapter_05/';
      const RETIRE = [
        'Ch05_Fig_5_6_Circuit_Breakers.png',
        'Ch05_Fig_5_6_Circuit_Breakers-srjprev400.png',
        'Ch05_Fig_5_7_Operating_Rhythm.png',
        'Ch05_Fig_5_7_Operating_Rhythm-srjprev400.png',
      ];
      const src = await fetch(SRC);
      if (!src.ok) return new Response('source ' + src.status, { status: 502 });
      const buf = new Uint8Array(await src.arrayBuffer());
      const digest = await crypto.subtle.digest('SHA-256', buf);
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      if (hex !== PIN) return new Response('sha mismatch ' + hex, { status: 409 });
      const dec = (a: Uint8Array) => new TextDecoder().decode(a).replace(/\0.*$/, '').trim();
      const safe =
        /^Ch05_Fig_5_(6_The_AI_Augmented_Operating_Rhythm|7_Agent_Circuit_Breakers)(-srjprev400)?\.png$/;
      let off = 0;
      const written: string[] = [];
      const skipped: string[] = [];
      while (off + 512 <= buf.length) {
        const head = buf.subarray(off, off + 512);
        if (head.every((b) => b === 0)) break;
        const name = dec(head.subarray(0, 100));
        const size = parseInt(dec(head.subarray(124, 136)) || '0', 8) || 0;
        const type = String.fromCharCode(head[156]);
        off += 512;
        if (type === '0' || type === '\0') {
          if (safe.test(name)) {
            await env.MEDIA.put(PREFIX + name, buf.subarray(off, off + size), {
              httpMetadata: { contentType: 'image/png' },
            });
            written.push(name);
          } else if (name) {
            skipped.push(name);
          }
        }
        off += Math.ceil(size / 512) * 512;
      }
      // Only retire the old names once all four new objects are in place.
      const retired: string[] = [];
      if (written.length === 4) {
        for (const name of RETIRE) {
          await env.MEDIA.delete(PREFIX + name);
          retired.push(name);
        }
      }
      return new Response(JSON.stringify({ ok: true, written, retired, skipped }, null, 1), {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    // 0c. Asset manifest. Read-only key listing of the PUBLIC media bucket,
    // for auditing what is stored versus what the site actually references
    // (the R2 dashboard paginates at ~30 rows and has no export). Bearer
    // gated with the same token as the archive route: every object here is
    // already public one URL at a time, but a complete index makes bulk
    // enumeration trivial, so it is not handed out anonymously. Never lists
    // UPLOADS, which is the private client bucket.
    if (url.pathname === '/api/assets-manifest') {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: { allow: 'GET' } });
      }
      const auth = request.headers.get('authorization') ?? '';
      if (!env.ARCHIVE_TOKEN || auth !== `Bearer ${env.ARCHIVE_TOKEN}`) {
        return new Response('Unauthorized', { status: 401 });
      }
      const keys: { key: string; size: number; uploaded: string }[] = [];
      let cursor: string | undefined;
      // R2 list() caps at 1000 per call, and this bucket holds more than
      // that, so paginate until truncated is false.
      do {
        const page = await env.MEDIA.list({ limit: 1000, cursor });
        for (const o of page.objects) {
          keys.push({ key: o.key, size: o.size, uploaded: o.uploaded.toISOString() });
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return new Response(JSON.stringify({ ok: true, count: keys.length, objects: keys }, null, 1), {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    // 1. Forms. Checked before assets so a stray file can never shadow them.
    //
    // /api/worksheet-confirm is the one GET in the set: it is the signed link
    // from the gate's confirmation email, so it arrives as a navigation, not a
    // form post.
    const POST_ROUTES: Record<string, (r: Request, e: FormEnv) => Promise<Response>> = {
      '/api/contact': handleContact,
      '/api/upload': handleUpload,
      '/api/worksheet-access': handleWorksheetAccess,
      '/api/newsletter': handleNewsletter,
    };
    if (url.pathname in POST_ROUTES || url.pathname === '/api/worksheet-confirm') {
      const isConfirm = url.pathname === '/api/worksheet-confirm';
      const allowed = isConfirm ? 'GET' : 'POST';
      if (request.method !== allowed) {
        return new Response('Method not allowed', { status: 405, headers: { allow: allowed } });
      }
      try {
        return isConfirm
          ? await handleWorksheetConfirm(request, env)
          : await POST_ROUTES[url.pathname](request, env);
      } catch (err) {
        console.error('form handler threw', url.pathname, err);
        return new Response(
          JSON.stringify({ ok: false, message: 'Something went wrong. Please email info@srjconsultingservices.com.' }),
          { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } },
        );
      }
    }

    // 2 and 3. Assets, then R2 for the migrated media tree.
    if (url.pathname.startsWith('/wp-content/')) {
      // Static handler gets first refusal, so anything genuinely in the build
      // still wins.
      const fromBuild = await env.ASSETS.fetch(request);
      if (fromBuild.status !== 404) return fromBuild;

      // R2 keys carry no leading slash, and the path arrives percent-encoded
      // because 901 of these filenames contain spaces. Decode before lookup or
      // every one of those 404s.
      const key = decodeURIComponent(url.pathname.slice(1));

      // Only ask R2 for a range when the client actually asked for one.
      // Passing `range: request.headers` unconditionally makes R2 report a
      // range on every response, which turned every plain image load into a
      // malformed 206.
      const wantsRange = request.headers.has('range');

      // R2 throws on an unsatisfiable range rather than returning null, so the
      // ranged read is guarded. Without this, `Range: bytes=17209-` on a 17209
      // byte object surfaced as a 500. RFC 9110 wants 416 with a Content-Range
      // naming the true size, which is what the catch does after a cheap head()
      // to learn it. The happy path costs nothing extra.
      let object: R2ObjectBody | R2Object | null;
      try {
        object = await env.MEDIA.get(key, {
          ...(wantsRange ? { range: request.headers } : {}),
          onlyIf: request.headers,
        });
      } catch (err) {
        if (!wantsRange) throw err;
        const meta = await env.MEDIA.head(key);
        if (!meta) {
          return new Response('Not found', {
            status: 404,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }
        return new Response(null, {
          status: 416,
          headers: { 'content-range': `bytes */${meta.size}`, 'accept-ranges': 'bytes' },
        });
      }
      if (!object) {
        return new Response('Not found', {
          status: 404,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set('etag', object.httpEtag);
      headers.set('accept-ranges', 'bytes');

      const guessed = typeFor(key);
      if (guessed && !headers.get('content-type')) headers.set('content-type', guessed);

      // Media here is content-addressed in practice: WordPress gives a changed
      // image a new filename, so a long max-age is safe and keeps the bucket's
      // Class B operations near zero.
      headers.set('cache-control', 'public, max-age=31536000, immutable');

      // A conditional request whose precondition failed, or a HEAD, comes back
      // without a body. Neither is a partial response.
      if (!('body' in object) || object.body === null) {
        return new Response(null, { status: 304, headers });
      }

      const resolved =
        wantsRange && object.range ? resolveRange(request.headers.get('range'), object.size) : null;
      if (resolved) {
        headers.set('content-range', `bytes ${resolved.first}-${resolved.last}/${object.size}`);
        return new Response(object.body, { status: 206, headers });
      }

      return new Response(object.body, { status: 200, headers });
    }

    return env.ASSETS.fetch(request);
  },
};
