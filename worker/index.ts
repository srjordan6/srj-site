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

      // A genuine partial. R2Range is a union: {offset,length}, {offset},
      // {length}, or {suffix}. Normalise to first and last byte positions so
      // Content-Range is correct whichever form came back.
      //
      // Test the VALUES, not key presence. `'suffix' in range` was the first
      // attempt and it is wrong: R2 returns an object carrying all three keys
      // with undefined values, so that check passed for an ordinary
      // `bytes=0-99` request, took the suffix branch, and emitted
      // `bytes NaN-17208/17209`. The body was correct throughout, so only a
      // header inspection catches it.
      const range = wantsRange ? object.range : undefined;
      if (range) {
        const { offset, length, suffix } = range as {
          offset?: number; length?: number; suffix?: number;
        };
        const size = object.size;
        const first = suffix !== undefined ? size - suffix : offset ?? 0;
        const last =
          suffix !== undefined
            ? size - 1
            : length !== undefined
              ? first + length - 1
              : size - 1;
        headers.set('content-range', `bytes ${first}-${last}/${size}`);
        return new Response(object.body, { status: 206, headers });
      }

      return new Response(object.body, { status: 200, headers });
    }

    return env.ASSETS.fetch(request);
  },
};
