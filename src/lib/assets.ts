/**
 * Where wp-content assets are served from.
 *
 * GATE 18, VERBATIM FROM THE ARCHITECTURE PACKAGE (July 27, 2026):
 *
 *   "Asset parity: all 216 images + 8 PDFs served from Pages at same paths
 *    (/wp-content/uploads/... preserved verbatim to keep every external
 *    citation and AI-crawler reference alive)."
 *
 * So ASSET_BASE is empty and every reference stays root-relative. An asset
 * that lived at srjconsultingservices.com/wp-content/uploads/x.png keeps that
 * exact address after cutover, and every external citation, social card, and
 * AI-crawler reference to it keeps resolving.
 *
 * WHY THIS WAS BRIEFLY WRONG, recorded so it is not repeated. An earlier
 * version pointed this at the R2 public bucket URL. That serves the same bytes
 * from a different origin, which silently fails gate 18: the paths change, and
 * every citation to the old address dies at cutover. The bucket is the right
 * storage; the subdomain was the wrong address.
 *
 * WHERE THE BYTES ACTUALLY COME FROM. 1,236 referenced assets, ~278 MB, which
 * is too much to commit. The Worker serves /wp-content/* from the R2 binding
 * (see worker/index.ts and wrangler.toml), so the path is the site's and the
 * storage is the bucket's. Nothing in the content or templates knows or cares.
 */

/**
 * Public base for asset URLs. Empty by design: assets are same-origin.
 *
 * If this ever needs to become an absolute origin again, note that doing so
 * breaks gate 18 unless the old paths are simultaneously redirected, and that
 * redirecting 1,236 asset URLs is not a thing anyone should want to own.
 */
export const ASSET_BASE = '';

/** The origin whose /wp-content/ references are being made relative. */
const LEGACY_ORIGIN = 'https://srjconsultingservices.com';

/**
 * Normalise every wp-content reference in a block of HTML to a root-relative
 * path on this site.
 *
 * Handles the three forms that occur in the extracted markup:
 *   absolute           https://srjconsultingservices.com/wp-content/...
 *   protocol-relative  //srjconsultingservices.com/wp-content/...
 *   root-relative      /wp-content/...                     (already correct)
 *
 * The third is left alone. The regex on the others requires a quote, paren or
 * space immediately before the path so it matches an attribute or a CSS url()
 * and cannot corrupt prose that happens to contain the string.
 *
 * Only /wp-content/ is touched. /wp-json/, /wp-admin/ and /wp-includes/ are
 * application routes, not assets, and are handled separately.
 */
export function rewriteAssets(html: string): string {
  if (!html) return html;
  return html
    .replaceAll(`${LEGACY_ORIGIN}/wp-content/`, `/wp-content/`)
    .replaceAll(`//srjconsultingservices.com/wp-content/`, `/wp-content/`);
}

/** Same, for a single-value field such as og:image. */
export function rewriteAssetUrl(url?: string): string | undefined {
  if (!url) return url;
  if (url.startsWith(`${LEGACY_ORIGIN}/wp-content/`)) {
    return url.slice(LEGACY_ORIGIN.length);
  }
  return url;
}
