// Chrome transplant: fetch live WP governance pages and turn them into
// templates with content slots. The chrome (head links, inline styles,
// header, mobile nav, footer, floating CTA) is the live site's own bytes;
// only trackers and WP plumbing are stripped. Visual parity by identity.
import { writeFileSync, mkdirSync } from 'node:fs';

// The governance pages carry transplanted WordPress chrome rather than
// BaseLayout, so nothing the Astro layout adds reaches them. Consent and the
// tracker declarations have to be injected here instead.
//
// This imports the SAME consent.ts the Astro components use. Node 22 runs
// TypeScript directly, so there is one implementation of the consent gate for
// the whole site rather than a copy in each chrome path. A copy is how the two
// would drift, and a consent gate that differs between page types is worse than
// no gate at all, because it looks uniform and is not.
import { consentBootstrap } from '../src/lib/consent.ts';

const UA = { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126.0' } };
const get = async (u) => (await fetch(u, UA)).text();

// ---------------------------------------------------------------------------
// Consent-gated trackers for the governance chrome.
//
// Every tracker ships as <script type="text/plain">, a type no browser
// executes. The bootstrap rewrites it to a real script only once the matching
// category is granted, so "not consented" means NEVER RAN rather than "ran and
// was ignored".
//
// These ids match src/components/Trackers.astro. They are duplicated here
// because a build script cannot render an Astro component; the consent LOGIC is
// shared via consent.ts, which is the part that would be dangerous to fork.
// ---------------------------------------------------------------------------
const GA4_ID = 'G-WWP3BSKN5N';
const CLARITY_ID = 'wxtqd3ud7i';
const STATCOUNTER_PROJECT = '13170872';
const STATCOUNTER_SECURITY = 'd3cb9c8b';

/**
 * Clarity runs on the governance pages.
 *
 * It is excluded from /contact/ and /client-upload/ because session recording
 * captures keystrokes and those pages carry client-confidential input. No
 * governance page has a form, so there is nothing to record but reading
 * behaviour, which is what Clarity is for.
 */
function trackerDeclarations() {
  return [
    `<script type="text/plain" data-consent="statistics" data-src="https://www.googletagmanager.com/gtag/js?id=${GA4_ID}" async></script>`,
    `<script type="text/plain" data-consent="statistics">`,
    `window.dataLayer = window.dataLayer || [];`,
    `function gtag(){ dataLayer.push(arguments); }`,
    `gtag('js', new Date());`,
    `gtag('config', '${GA4_ID}', { anonymize_ip: true });`,
    `</script>`,
    `<script type="text/plain" data-consent="statistics">`,
    `(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};`,
    `t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;`,
    `y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","${CLARITY_ID}");`,
    `</script>`,
    // No <noscript> pixel. A no-JS fallback fires without consent by definition,
    // since consent is enforced in JavaScript, and that is exactly how
    // StatCounter was running ungated on these pages before.
    `<script type="text/plain" data-consent="statistics">`,
    `var sc_project=${STATCOUNTER_PROJECT};var sc_invisible=1;var sc_security="${STATCOUNTER_SECURITY}";`,
    `</script>`,
    `<script type="text/plain" data-consent="statistics" data-src="https://www.statcounter.com/counter/counter.js" async></script>`,
  ].join('\n');
}

/**
 * The consent banner, rendered hidden and revealed by the bootstrap only when no
 * current decision exists.
 *
 * Reject and Accept are the same element, side by side, one click each. Making
 * refusal visually subordinate is the pattern EU regulators have fined most
 * consistently. If this markup is edited, that symmetry is the thing not to
 * break.
 *
 * Kept in step with src/components/ConsentBanner.astro by hand. The ids and
 * classes are the contract the shared bootstrap relies on: srj-consent-banner,
 * srj-consent-accept, srj-consent-reject, srj-consent-save, srj-cat-statistics,
 * srj-cat-marketing.
 */
function consentBannerHtml() {
  return `
<div id="srj-consent-banner" class="srj-consent" role="dialog" aria-modal="false" aria-labelledby="srj-consent-title" hidden>
  <div class="srj-consent-inner">
    <h2 id="srj-consent-title">Cookies on this site</h2>
    <p>We use cookies that are necessary for the site to work. With your agreement we
      also use analytics that count page views and, on most pages, a tool that records
      how a page is used, including mouse movement, clicks and scrolling, so we can see
      where readers get stuck. You can accept, refuse, or choose by category, and you
      can change your mind at any time.
      <a href="/privacy/">Read the privacy policy</a>.</p>
    <details class="srj-consent-detail">
      <summary>Choose by category</summary>
      <div class="srj-consent-cat"><label><input type="checkbox" checked disabled />
        <span><strong>Necessary</strong> &mdash; required for the site to function. Always on.</span></label></div>
      <div class="srj-consent-cat"><label><input type="checkbox" id="srj-cat-statistics" />
        <span><strong>Statistics</strong> &mdash; page views and traffic sources (Google Analytics,
        StatCounter), and session recording that captures mouse movement, clicks and
        scrolling (Microsoft Clarity). Recording does not run on the contact or
        client upload pages.</span></label></div>
      <div class="srj-consent-cat"><label><input type="checkbox" id="srj-cat-marketing" />
        <span><strong>Marketing</strong> &mdash; measuring which publications and campaigns reach their audience.</span></label></div>
      <button type="button" class="srj-consent-btn srj-consent-save" id="srj-consent-save">Save my choices</button>
    </details>
    <div class="srj-consent-actions">
      <button type="button" class="srj-consent-btn srj-consent-reject" id="srj-consent-reject">Reject all</button>
      <button type="button" class="srj-consent-btn srj-consent-accept" id="srj-consent-accept">Accept all</button>
    </div>
  </div>
</div>
<script>
(function () {
  var b = document.getElementById('srj-consent-banner');
  if (!b || !window.srjConsent) return;
  document.getElementById('srj-consent-accept').addEventListener('click', function () { window.srjConsent.accept(); });
  document.getElementById('srj-consent-reject').addEventListener('click', function () { window.srjConsent.reject(); });
  document.getElementById('srj-consent-save').addEventListener('click', function () {
    window.srjConsent.save(
      document.getElementById('srj-cat-statistics').checked,
      document.getElementById('srj-cat-marketing').checked);
  });
})();
</script>`;
}

const STRIP_LINK = /wp-includes\/css|complianz|relevanssi|godaddy-launch|uploads\/complianz/;
const STRIP_SCRIPT = /clarity|googletagmanager|gtag\(|cmplz|complianz|relevanssi|wp-emoji|wp-includes\/js|jquery|rocket-loader|stats\.wp/i;

// Trackers that survive STRIP_SCRIPT because they are INLINE and carry none of
// its keywords. Each was live on 67 governance pages until this was added.
//
//   statcounter   analytics, gated by Complianz on WordPress and ungated here
//   linkedin      Insight Tag, a marketing tracker, the worst of these for CPRA
//   trustedsite   badge/telemetry
//   godaddy       _trfd/_trfq/tccl telemetry, meaningless once off GoDaddy
//
// The consent layer that gated these on WordPress cannot work on a static site:
// complianz.min.js needs WP REST endpoints, so it 404s and the banner never
// initialises. Carrying the markup forward would render consent theatre that
// collects nothing while the trackers fire regardless. Both sides go.
const STRIP_INLINE_TRACKER =
  /statcounter|_linkedin_partner_id|lintrk|licdn\.com|trustedsite|_trfd|_trfq|tccl\.baseHost|tccl-tti/i;

/**
 * Remove an element and its subtree by id, counting tag depth.
 *
 * The Complianz banner is a div containing ~40 nested divs. A regex cannot
 * match its close tag, and a lazy match stops at the first </div>, leaving a
 * broken fragment. Depth counting is the only correct approach here.
 */
function removeElementById(html, id, tag = 'div') {
  const open = new RegExp(`<${tag}\\b[^>]*\\bid=["']${id}["'][^>]*>`, 'i');
  const m = open.exec(html);
  if (!m) return html;
  const start = m.index;
  const step = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, 'gi');
  step.lastIndex = start;
  let depth = 0;
  let hit;
  while ((hit = step.exec(html))) {
    depth += hit[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(0, start) + html.slice(hit.index + hit[0].length);
  }
  return html; // unbalanced; leave it rather than truncate the document
}

function sanitize(html) {
  // drop stylesheet links for absent plugins
  html = html.replace(/<link rel='stylesheet'[^>]*href='([^']*)'[^>]*\/>\n?/g,
    (m, href) => (STRIP_LINK.test(href) ? '' : m));
  // drop tracker/plumbing scripts (external and inline), keep srj theme scripts
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, (m) => {
    if (/application\/ld\+json/.test(m)) return '';           // all JSON-LD re-injected per page
    if (/srj-nav-toggle|srjgov|floating-cta/.test(m)) return m; // theme behavior stays
    if (STRIP_SCRIPT.test(m)) return '';
    if (STRIP_INLINE_TRACKER.test(m)) return '';               // inline trackers, see above
    if (/<script[^>]*src=/.test(m)) return '';                 // external non-theme scripts
    return m;                                                  // other inline (harmless)
  });
  // the StatCounter fallback pixel is a <noscript><img>, so no script rule sees it
  html = html.replace(/<noscript>[\s\S]*?<\/noscript>/g, (m) =>
    STRIP_INLINE_TRACKER.test(m) ? '' : m);
  // the Complianz banner and its re-open button are plain markup, not scripts
  html = removeElementById(html, 'cmplz-cookiebanner-container');
  html = removeElementById(html, 'cmplz-manage-consent');
  // strip WP head plumbing links.
  //
  // The api.w.org rel value carries a TRAILING SLASH — rel="https://api.w.org/"
  // — so an alternation ending at ".org" never matched it and the REST API
  // discovery link shipped on all 67 governance pages. It is also what put
  // /wp-json/ into the asset manifest as a phantom missing asset. The /? fixes
  // both.
  html = html.replace(/<link rel=["'](?:https:\/\/api\.w\.org\/?|EditURI|wlwmanifest|shortlink|alternate)["'][^>]*>\n?/g, '');
  html = html.replace(/<link rel="(?:preconnect|dns-prefetch)" href="[^"]*(?:clarity|google-analytics|googletagmanager)[^"]*"[^>]*>\n?/g, '');
  // dns-prefetch for the stripped trackers, emitted with single quotes by WP
  html = html.replace(/<link rel=['"](?:preconnect|dns-prefetch)['"] href=['"][^'"]*(?:statcounter|trustedsite|licdn)[^'"]*['"][^>]*\/?>\n?/gi, '');

  // Google Fonts. The governance pages carry WordPress chrome rather than
  // BaseLayout, so removing the <link> from the layout left these 64 pages
  // still transmitting every visitor's IP to Google on load. That request
  // fires while <head> parses, before any consent banner can be answered, so
  // consent cannot cure it. The fonts are self-hosted and injected below.
  html = html.replace(/<link[^>]*fonts\.(?:googleapis|gstatic)\.com[^>]*>\n?/gi, '');

  // Put the self-hosted replacement in, at a public path both chrome paths
  // share. BaseLayout links the same file, so there is one copy of the
  // @font-face rules and one set of woff2 files for the whole site.
  //
  // The consent bootstrap goes in the same insertion, and it must be FIRST in
  // <head>: it establishes Google Consent Mode denied-by-default and defines the
  // activation function, and both have to exist before any tracker declaration
  // is parsed. The stylesheet link follows it.
  html = html.replace(
    /<title>/i,
    `<script>${consentBootstrap()}</script>\n` +
    '<link rel="stylesheet" href="/fonts/fonts.css" />\n' +
    '<link rel="stylesheet" href="/consent.css" />\n' +
    trackerDeclarations() +
    '<title>'
  );
  // Internal navigation becomes root-relative.
  //
  // WordPress emits every internal link as an absolute
  // https://srjconsultingservices.com/... URL. Carried across unchanged, that
  // means 133 of 138 pages on the staging site link straight back to the live
  // WordPress site: click any nav item and you leave. After cutover the domain
  // moves and they resolve, so this is invisible in production and completely
  // broken in staging, which is the worst way round.
  //
  // Only <a href> is rewritten. Canonicals, og:url and every URL inside JSON-LD
  // must stay absolute: those identify the page on the web rather than point at
  // it from inside the site.
  //
  // /resources/ is additionally remapped to /ai-resources/. It was retired into
  // that hub, and an absolute link skips the redirect and lands on WordPress.
  html = html.replace(
    /(<a\b[^>]*?\bhref=["'])https:\/\/srjconsultingservices\.com(\/[^"']*)?(["'])/g,
    (_m, pre, path, post) => pre + ((path === '/resources/' ? '/ai-resources/' : path) || '/') + post
  );

  // The consent banner goes last in the body, so it never displaces page
  // content. It renders hidden; the bootstrap in <head> reveals it only when no
  // current decision exists, by which point nothing non-essential has run.
  html = html.replace(/<\/body>/i, consentBannerHtml() + '\n</body>');

  return html;
}

function slotHead(html, marks) {
  // title
  html = html.replace(/<title>[\s\S]*?<\/title>/, '<title>{{TITLE}}</title>');
  // meta description (rank math emits name="description")
  if (/<meta name="description"/.test(html))
    html = html.replace(/<meta name="description" content="[^"]*"/, '<meta name="description" content="{{DESC}}"');
  else
    html = html.replace('<title>', '<meta name="description" content="{{DESC}}"/>\n<title>');
  // canonical + og url/title/desc
  html = html.replace(/<link rel="canonical" href="[^"]*"/, '<link rel="canonical" href="{{URL}}"');
  html = html.replace(/<meta property="og:title" content="[^"]*"/, '<meta property="og:title" content="{{TITLE}}"');
  html = html.replace(/<meta property="og:description" content="[^"]*"/, '<meta property="og:description" content="{{DESC}}"');
  html = html.replace(/<meta property="og:url" content="[^"]*"/, '<meta property="og:url" content="{{URL}}"');
  // JSON-LD slot goes right before </head>
  html = html.replace('</head>', '{{JSONLD}}\n</head>');
  return html;
}

async function buildDetail() {
  let t = sanitize(await get('https://srjconsultingservices.com/ai-governance/state-ai-laws/colorado-ai-act/'));
  t = slotHead(t);
  // breadcrumbs
  t = t.replace(/<nav class="breadcrumbs"[\s\S]*?<\/nav>/, '{{BREADCRUMBS}}');
  // hero label + h1
  t = t.replace(/<div class="label">[\s\S]*?<\/div>\s*<h1>[\s\S]*?<\/h1>/, '{{LABEL}}<h1>{{H1}}</h1>');
  // subtitle paragraph (italic gray, before detail body)
  t = t.replace(/<p style="font-family:Poppins,sans-serif;font-size:18px;font-style:italic;[^"]*">[\s\S]*?<\/p>/, '{{SUBTITLE}}');
  // body: everything inside srjgov-detail-body up to the CTA block
  const bodyStart = t.indexOf('<div class="srjgov-detail-body">');
  const ctaStart = t.indexOf('<div class="srjgov-cta"', bodyStart);
  if (bodyStart < 0 || ctaStart < 0) throw new Error('detail markers not found');
  t = t.slice(0, bodyStart) + '<div class="srjgov-detail-body">\n{{BODY}}\n{{CHILDREN}}\n</div>\n' + t.slice(ctaStart);
  // CTA: swap the topic keyword so every page gets its own
  t = t.replace(/(<div class="srjgov-cta"[\s\S]*?<\/div>)/, (m) => m
    .replace(/Colorado AI Act/g, '{{KW}}'));
  writeFileSync('src/templates/gov-detail.tpl.html', t);
  console.log('detail template:', t.length, 'bytes');
}

async function buildHub() {
  // The hub is transplanted VERBATIM: every build refetches the live page,
  // so the hub stays synced with WordPress until cutover, at which point
  // the last capture becomes the baseline. Only the JSON-LD slot is added
  // (sanitize strips all ld+json; the renderer re-injects breadcrumbs+org).
  let t = sanitize(await get('https://srjconsultingservices.com/ai-governance/'));
  if (!t.includes('srjgov-dir')) throw new Error('hub markers not found (challenge page?)');
  t = t.replace('</head>', '{{JSONLD}}\n</head>');
  writeFileSync('src/templates/gov-hub.tpl.html', t);
  console.log('hub template (verbatim):', t.length, 'bytes');
}

mkdirSync('src/templates', { recursive: true });
// The fetch is a best-effort refresh: Sucuri may block the CI container's
// requests, so committed templates are the fallback. A failed fetch keeps
// the last committed capture and the build proceeds.
// Refresh both templates from live WordPress.
//
// A failed refresh falls back to the committed copy rather than breaking the
// deploy: a transient Sucuri challenge against a datacenter IP should not stop
// a release. But it must be LOUD, because a silent fallback means the chrome can
// sit months stale with no signal at all.
//
// That is exactly what happened. On 2026-07-29 the Google Fonts strip was added
// here, the build succeeded, and all 64 governance pages kept loading
// fonts.googleapis.com. The strip was correct and never ran: the fetch failed on
// Cloudflare's build network, this catch swallowed it, and the committed
// templates shipped unchanged. It took hand-patching the committed templates to
// close the leak, and the cause was only found by reading this file.
//
// So: warn with a banner, record the outcome, and exit non-zero if BOTH failed.
// One template falling back is survivable. Both failing means the generator is
// not working and the build should say so rather than quietly shipping whatever
// was last committed.
const results = [];

try {
  await buildDetail();
  results.push(['detail', 'refreshed']);
} catch (e) {
  results.push(['detail', 'FELL BACK: ' + e.message]);
}

try {
  await buildHub();
  results.push(['hub', 'refreshed']);
} catch (e) {
  results.push(['hub', 'FELL BACK: ' + e.message]);
}

const failed = results.filter(([, r]) => r.startsWith('FELL BACK'));

if (failed.length) {
  console.warn('');
  console.warn('='.repeat(72));
  console.warn('  CHROME TEMPLATES NOT REFRESHED');
  console.warn('');
  for (const [name, r] of results) console.warn(`  ${name.padEnd(8)} ${r}`);
  console.warn('');
  console.warn('  The committed .tpl.html files are being used instead. Any change to');
  console.warn('  sanitize() in this script has NOT reached the governance pages.');
  console.warn('  Most likely cause: the Sucuri WAF challenged this build\'s IP.');
  console.warn('='.repeat(72));
  console.warn('');
} else {
  for (const [name, r] of results) console.log(`  ${name}: ${r}`);
}

if (failed.length === results.length) {
  // Deliberately NOT a build failure.
  //
  // An earlier version exited 1 here, on the reasoning that both templates
  // failing means the generator is broken. That was wrong, and it broke every
  // deploy: on Cloudflare's build network the Sucuri WAF challenges the request,
  // so BOTH refreshes fail on every single build. The condition I treated as an
  // alarm is the normal case in that environment.
  //
  // The committed templates are therefore the real source until WordPress is
  // retired, and the working pattern is: run this script locally, where the
  // fetch succeeds, and commit its output. The banner above is what makes that
  // step visible rather than invisible, which was the actual defect.
  console.warn('  Both refreshes fell back. On Cloudflare\'s build network this is expected:');
  console.warn('  the Sucuri WAF challenges the build container. The committed templates');
  console.warn('  are the source of truth. To pick up a change to sanitize(), run this');
  console.warn('  script locally and commit src/templates/*.tpl.html.');
  console.warn('');
}
