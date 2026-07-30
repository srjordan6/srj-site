// Chrome transplant: fetch live WP governance pages and turn them into
// templates with content slots. The chrome (head links, inline styles,
// header, mobile nav, footer, floating CTA) is the live site's own bytes;
// only trackers and WP plumbing are stripped. Visual parity by identity.
import { writeFileSync, mkdirSync } from 'node:fs';

const UA = { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126.0' } };
const get = async (u) => (await fetch(u, UA)).text();

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
  html = html.replace(
    /<title>/i,
    '<link rel="stylesheet" href="/fonts/fonts.css" />\n<title>'
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
  console.error('Both chrome templates failed to refresh. Failing the build rather');
  console.error('than shipping stale chrome silently. Re-run, or commit templates');
  console.error('generated by running this script locally.');
  process.exit(1);
}
