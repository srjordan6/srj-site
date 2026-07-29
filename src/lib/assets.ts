/**
 * Where wp-content assets are served from.
 *
 * THE PROBLEM THIS SOLVES. Every migrated page, and the transplanted chrome on
 * the governance pages, references its images, stylesheets, PDFs and favicons
 * at https://srjconsultingservices.com/wp-content/... That works today only
 * because WordPress is still answering on that domain. The moment DNS moves to
 * the new site, 1,236 assets 404 at once: seven stylesheets, so every page
 * renders unstyled, plus 1,101 images and the executive-briefing PDFs.
 *
 * So the references are rewritten at render time to point at an R2 bucket
 * holding the same tree under the same keys.
 *
 * WHY REWRITE AT RENDER AND NOT IN THE CONTENT FILE. The extracted markup in
 * migrated-pages.json is production's own bytes, and keeping it that way is
 * what makes the parity gates meaningful: re-running the extractor produces the
 * same file, and a diff against production stays readable. Baking a bucket URL
 * into it would make the content depend on infrastructure, and changing buckets
 * would mean re-extracting 68 pages.
 *
 * CHANGING THIS AT CUTOVER. r2.dev is rate-limited and Cloudflare explicitly
 * calls it non-production. It is correct for staging. When the domain moves to
 * Cloudflare, bind a custom domain to the bucket (assets.srjconsultingservices.com)
 * and change ASSET_BASE to it. That is the only edit; nothing else references
 * the bucket.
 */

/** Public base for the asset bucket. No trailing slash. */
export const ASSET_BASE = 'https://pub-a32f31a0c85144adbee466faf51e30a8.r2.dev';

/** The origin whose /wp-content/ references are being repointed. */
const LEGACY_ORIGIN = 'https://srjconsultingservices.com';

/**
 * Repoint every wp-content reference in a block of HTML at the asset bucket.
 *
 * Handles the three forms that actually occur in the markup:
 *   absolute  https://srjconsultingservices.com/wp-content/...
 *   protocol-relative  //srjconsultingservices.com/wp-content/...
 *   root-relative      /wp-content/...
 *
 * Root-relative is the one worth being careful about. On WordPress it resolved
 * against the same host; on the new site it would resolve against the Worker,
 * which has no /wp-content/ route, so those would 404 even before cutover. The
 * regex requires a quote or parenthesis immediately before the slash so it
 * matches an attribute or a CSS url() and cannot corrupt prose that happens to
 * contain the string.
 *
 * Only /wp-content/ is touched. /wp-json/, /wp-admin/ and /wp-includes/ are
 * left alone: they are application routes, not assets, and are dealt with
 * separately.
 */
export function rewriteAssets(html: string): string {
  if (!html) return html;
  return html
    .replaceAll(`${LEGACY_ORIGIN}/wp-content/`, `${ASSET_BASE}/wp-content/`)
    .replaceAll(`//srjconsultingservices.com/wp-content/`, `${ASSET_BASE.replace(/^https:/, '')}/wp-content/`)
    .replace(/(["'(\s])\/wp-content\//g, `$1${ASSET_BASE}/wp-content/`);
}

/** Repoint a single URL, for og:image and similar single-value fields. */
export function rewriteAssetUrl(url?: string): string | undefined {
  if (!url) return url;
  if (url.startsWith(`${LEGACY_ORIGIN}/wp-content/`)) {
    return ASSET_BASE + url.slice(LEGACY_ORIGIN.length);
  }
  if (url.startsWith('/wp-content/')) return ASSET_BASE + url;
  return url;
}
