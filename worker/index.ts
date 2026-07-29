/**
 * Cloudflare Worker entry.
 *
 * WHAT THIS EXISTS FOR: gate 18 of the architecture package.
 *
 *   "Asset parity: all 216 images + 8 PDFs served from Pages at same paths
 *    (/wp-content/uploads/... preserved verbatim to keep every external
 *    citation and AI-crawler reference alive)."
 *
 * The site references 1,236 assets, about 278 MB, which is too much to commit
 * and serve as static files. Serving them from the R2 bucket's own public URL
 * would have been easy and wrong: same bytes, different origin, and every
 * external citation to /wp-content/uploads/... dies at cutover. That is exactly
 * the failure gate 18 is written to prevent.
 *
 * So the path stays on this site and the storage stays in R2. A request for
 * /wp-content/anything is answered from the bucket with the URL unchanged.
 * Nothing in the content, the templates, or anybody's citation has to know.
 *
 * ORDER OF RESOLUTION, and it matters:
 *   1. Static assets from the build (env.ASSETS). The site's own pages, CSS
 *      and JS win over everything.
 *   2. /wp-content/* from R2.
 *   3. Otherwise the static handler's own miss behaviour, which is the 404 page.
 *
 * Putting R2 second means anything later committed under public/wp-content/
 * shadows the bucket rather than fighting it.
 */

export interface Env {
  /** The built site, bound by wrangler's [assets] block. */
  ASSETS: Fetcher;
  /** The migrated WordPress media tree. */
  MEDIA: R2Bucket;
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
 * different ways, both emitting `bytes NaN-17208/17209` or `bytes 0-17208`
 * while the body was a correct 100 bytes. R2 honours the header we hand it, so
 * the header is the authority on what the body contains and cannot disagree
 * with it. Parsing here is deterministic and testable without a deploy.
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
      //
      // Passing `range: request.headers` unconditionally, which is what this
      // did first, makes R2 report a range on every response covering the whole
      // object. The status ternary below then picked 206 for every request,
      // including plain image loads, and no Content-Range was ever set. A 206
      // without Content-Range is malformed; browsers shrug at it, crawlers and
      // intermediary caches are entitled not to.
      const wantsRange = request.headers.has('range');

      const object = await env.MEDIA.get(key, {
        ...(wantsRange ? { range: request.headers } : {}),
        onlyIf: request.headers,
      });
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

      // A genuine partial. Derive the byte positions from the request header
      // rather than from object.range: R2 was handed this exact header, so the
      // body it returned matches it, and the header parses deterministically.
      const resolved = wantsRange && object.range
        ? resolveRange(request.headers.get('range'), object.size)
        : null;
      if (resolved) {
        headers.set('content-range', `bytes ${resolved.first}-${resolved.last}/${object.size}`);
        return new Response(object.body, { status: 206, headers });
      }

      return new Response(object.body, { status: 200, headers });
    }

    return env.ASSETS.fetch(request);
  },
};
