/**
 * Consent bootstrap, as plain JavaScript.
 *
 * WHY THIS IS .mjs AND NOT PART OF consent.ts. scripts/make-chrome.mjs has to
 * inject the identical bootstrap into the governance chrome, and it runs under
 * plain node. Cloudflare's build image is Node 22.16.0, which cannot import a
 * .ts file: unflagged type stripping only arrived in 22.18. Importing consent.ts
 * from the build script worked locally on 22.22 and failed the build on
 * Cloudflare with ERR_UNKNOWN_FILE_EXTENSION, which killed two deploys.
 *
 * So the runtime lives here, in a file every Node can load, and consent.ts
 * re-exports it for the Astro components. ONE implementation, two consumers. A
 * consent gate that differs between page types is worse than no gate, because it
 * looks uniform and is not.
 *
 * The full reasoning about prior blocking, equal-prominence Reject, Consent Mode
 * v2, and consent versioning is in consent.ts. Read that before changing this.
 */

/** Bump when a new category or purpose is added. Forces a fresh ask. */
export const CONSENT_VERSION = 1;

/** First-party, no third party can read it. */
export const COOKIE_NAME = 'srj_consent';

/** Thirteen months, the CNIL guidance figure and a common EU reference point. */
export const COOKIE_MAX_AGE = 60 * 60 * 24 * 395;

/**
 * The runtime script, emitted inline in <head> so it runs before anything else
 * on the page. Returned as a string rather than imported because it must be
 * inline: an external file is one more request that could fail and leave
 * trackers ungated.
 */
export function consentBootstrap() {
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

  // Load one embed on demand, without granting anything.
  //
  // A visitor who clicks "Load this video" has asked for that video. That is a
  // specific, informed, revocable act, and treating it as blanket consent to a
  // category would be reading far more into one click than it contains. So this
  // swaps in the single iframe and writes no consent record.
  window.srjLoadFrame = function (holder) {
    if (!holder) return;
    var src = holder.getAttribute('data-frame-src');
    if (!src) return;
    var f = document.createElement('iframe');
    f.src = src;
    f.loading = 'lazy';
    f.title = holder.getAttribute('data-frame-title') || '';
    f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    f.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
    f.setAttribute('allowfullscreen', '');
    holder.innerHTML = '';
    holder.appendChild(f);
    holder.removeAttribute('data-frame-src');
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
