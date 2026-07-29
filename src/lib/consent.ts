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

/** Bump when a new category or purpose is added. Forces a fresh ask. */
export const CONSENT_VERSION = 1;

/** First-party, no third party can read it. */
export const COOKIE_NAME = 'srj_consent';

/** Thirteen months, the CNIL guidance figure and a common EU reference point. */
export const COOKIE_MAX_AGE = 60 * 60 * 24 * 395;

export type Category = 'necessary' | 'statistics' | 'marketing';

export interface ConsentRecord {
  v: number;
  /** ISO timestamp of the decision. */
  t: string;
  necessary: true;
  statistics: boolean;
  marketing: boolean;
}

/**
 * The runtime script, emitted inline in <head> so it runs before anything else
 * on the page. Returned as a string rather than imported because it must be
 * inline: an external file is one more request that could fail and leave
 * trackers ungated.
 */
export function consentBootstrap(): string {
  return `
(function () {
  var NAME = '${COOKIE_NAME}';
  var VERSION = ${CONSENT_VERSION};
  var MAX_AGE = ${COOKIE_MAX_AGE};

  function read() {
    var m = document.cookie.match(new RegExp('(^|; )' + NAME + '=([^;]*)'));
    if (!m) return null;
    try {
      var v = JSON.parse(decodeURIComponent(m[2]));
      // A record from an older policy version is not consent to the current one.
      return (v && v.v === VERSION) ? v : null;
    } catch (e) { return null; }
  }

  function write(rec) {
    document.cookie = NAME + '=' + encodeURIComponent(JSON.stringify(rec)) +
      ';path=/;max-age=' + MAX_AGE + ';SameSite=Lax' +
      (location.protocol === 'https:' ? ';Secure' : '');
  }

  // ---- Google Consent Mode v2 -------------------------------------------
  // Must be established BEFORE any Google tag loads. Everything denied until
  // the visitor says otherwise. wait_for_update gives the banner time to apply
  // a stored decision before a tag would otherwise fire with the defaults.
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = window.gtag || gtag;

  gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
    functionality_storage: 'granted',
    security_storage: 'granted',
    wait_for_update: 500
  });

  function pushConsentMode(rec) {
    gtag('consent', 'update', {
      ad_storage: rec.marketing ? 'granted' : 'denied',
      ad_user_data: rec.marketing ? 'granted' : 'denied',
      ad_personalization: rec.marketing ? 'granted' : 'denied',
      analytics_storage: rec.statistics ? 'granted' : 'denied'
    });
  }

  // ---- Activate the scripts a decision permits ---------------------------
  // Trackers ship as <script type="text/plain" data-consent="statistics">, a
  // type no browser executes. Rewriting to a real script is what runs them, so
  // "not consented" means "never ran", not "ran and was ignored".
  function activate(rec) {
    var pending = document.querySelectorAll('script[type="text/plain"][data-consent]');
    Array.prototype.forEach.call(pending, function (node) {
      var cat = node.getAttribute('data-consent');
      if (!rec[cat]) return;
      var s = document.createElement('script');
      Array.prototype.forEach.call(node.attributes, function (a) {
        if (a.name === 'type' || a.name === 'data-consent' || a.name === 'data-src') return;
        s.setAttribute(a.name, a.value);
      });
      if (node.getAttribute('data-src')) s.src = node.getAttribute('data-src');
      else s.text = node.textContent;
      node.parentNode.replaceChild(s, node);
    });

    // Placeholders for third-party embeds, which are a network call to a third
    // party whether or not they set a cookie.
    var frames = document.querySelectorAll('[data-consent-frame]');
    Array.prototype.forEach.call(frames, function (holder) {
      if (!rec[holder.getAttribute('data-consent-frame')]) return;
      var src = holder.getAttribute('data-frame-src');
      if (!src) return;
      var f = document.createElement('iframe');
      f.src = src;
      f.loading = 'lazy';
      f.title = holder.getAttribute('data-frame-title') || '';
      f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      holder.innerHTML = '';
      holder.appendChild(f);
      holder.removeAttribute('data-frame-src');
    });
  }

  function apply(rec) {
    write(rec);
    pushConsentMode(rec);
    activate(rec);
    document.documentElement.setAttribute('data-consent-set', '1');
    window.dispatchEvent(new CustomEvent('srj:consent', { detail: rec }));
  }

  function decide(statistics, marketing) {
    apply({
      v: VERSION,
      t: new Date().toISOString(),
      necessary: true,
      statistics: !!statistics,
      marketing: !!marketing
    });
    var b = document.getElementById('srj-consent-banner');
    if (b) b.hidden = true;
  }

  // Exposed so the banner markup and the preferences page drive the same code
  // path. Two implementations of consent is how they drift apart.
  window.srjConsent = {
    get: read,
    accept: function () { decide(true, true); },
    reject: function () { decide(false, false); },
    save: decide,
    open: function () {
      var b = document.getElementById('srj-consent-banner');
      if (b) { b.hidden = false; b.querySelector('.srj-consent-detail').open = true; }
    }
  };

  var existing = read();
  if (existing) {
    apply(existing);
  } else {
    // No decision yet: show the banner once the markup exists. Nothing
    // non-essential has run at this point, which is the whole design.
    document.addEventListener('DOMContentLoaded', function () {
      var b = document.getElementById('srj-consent-banner');
      if (b) b.hidden = false;
    });
  }
})();
`.trim();
}
