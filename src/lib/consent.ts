/**
 * Consent management for a static site.
 *
 * WHY THIS EXISTS. Complianz cannot be carried over: it needs WordPress REST
 * endpoints, so complianz.min.js 404s and the banner never initialises. What
 * shipped on the migrated pages was the markup with no script behind it, which
 * rendered consent theatre that collected nothing while StatCounter and the
 * LinkedIn Insight Tag fired regardless. Both sides of that have been removed.
 *
 * WHAT THIS HAS TO GET RIGHT, because these are the points enforcement actions
 * actually turn on:
 *
 *   1. PRIOR BLOCKING. Non-essential scripts must not run before consent. Not
 *      "load but do nothing" — not load at all. Trackers are declared as
 *      <script type="text/plain" data-consent="statistics" data-src="..."> and
 *      the browser will not execute an unknown type. They are rewritten to real
 *      scripts only on grant. This is the requirement most banners fail.
 *
 *   2. REJECT AS EASY AS ACCEPT. Same level, same prominence, same number of
 *      clicks. A banner where refusing takes an extra step is the single most
 *      commonly fined pattern in the EU. Both are buttons, side by side.
 *
 *   3. NO PRE-TICKED BOXES. Every non-essential category defaults to off.
 *
 *   4. WITHDRAWABLE AS EASILY AS GIVEN. A persistent control reopens the
 *      preferences at any time, from any page.
 *
 *   5. A RECORD. The stored value carries the categories, the timestamp, and
 *      the policy version, so what was agreed and when is answerable later.
 *
 *   6. RE-ASK WHEN PURPOSES CHANGE. Adding a tracker in a new category bumps
 *      CONSENT_VERSION and everyone is asked again. Consent to analytics is not
 *      consent to advertising.
 *
 * GOOGLE CONSENT MODE V2 is initialised denied-by-default before any Google tag
 * can run, and updated on grant. Without it GA4 is both non-compliant for EEA
 * traffic and silently lossy.
 */

/*
 * THE RUNTIME LIVES IN consentBootstrap.mjs, re-exported below.
 *
 * Not for tidiness. scripts/make-chrome.mjs must inject the identical bootstrap
 * into the governance chrome, because those 64 pages carry transplanted
 * WordPress chrome and never pass through this layout. That script runs under
 * plain node, and Cloudflare's build image is Node 22.16.0, which cannot import
 * a .ts file: unflagged type stripping only arrived in 22.18. Importing this
 * file from the build script worked locally on 22.22 and failed the Cloudflare
 * build with ERR_UNKNOWN_FILE_EXTENSION, killing two deploys before the cause
 * was found.
 *
 * So the code sits in a file every Node version can load, and both consumers
 * import it. One implementation, two chrome paths. Do not copy the bootstrap
 * into either consumer: a consent gate that differs between page types is worse
 * than no gate, because it looks uniform and is not.
 */
export {
  CONSENT_VERSION,
  COOKIE_NAME,
  COOKIE_MAX_AGE,
  consentBootstrap,
} from './consentBootstrap.mjs';

export type Category = 'necessary' | 'statistics' | 'marketing';

export interface ConsentRecord {
  v: number;
  /** ISO timestamp of the decision. */
  t: string;
  necessary: true;
  statistics: boolean;
  marketing: boolean;
}
