// Chrome transplant: fetch live WP governance pages and turn them into
// templates with content slots. The chrome (head links, inline styles,
// header, mobile nav, footer, floating CTA) is the live site's own bytes;
// only trackers and WP plumbing are stripped. Visual parity by identity.
import { writeFileSync, mkdirSync } from 'node:fs';

const UA = { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126.0' } };
const get = async (u) => (await fetch(u, UA)).text();

const STRIP_LINK = /wp-includes\/css|complianz|relevanssi|godaddy-launch|uploads\/complianz/;
const STRIP_SCRIPT = /clarity|googletagmanager|gtag\(|cmplz|complianz|relevanssi|wp-emoji|wp-includes\/js|jquery|rocket-loader|stats\.wp/i;

function sanitize(html) {
  // drop stylesheet links for absent plugins
  html = html.replace(/<link rel='stylesheet'[^>]*href='([^']*)'[^>]*\/>\n?/g,
    (m, href) => (STRIP_LINK.test(href) ? '' : m));
  // drop tracker/plumbing scripts (external and inline), keep srj theme scripts
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, (m) => {
    if (/application\/ld\+json/.test(m)) return '';           // all JSON-LD re-injected per page
    if (/srj-nav-toggle|srjgov|floating-cta/.test(m)) return m; // theme behavior stays
    if (STRIP_SCRIPT.test(m)) return '';
    if (/<script[^>]*src=/.test(m)) return '';                 // external non-theme scripts
    return m;                                                  // other inline (harmless)
  });
  // strip WP head plumbing links
  html = html.replace(/<link rel=["'](?:https:\/\/api\.w\.org|EditURI|wlwmanifest|shortlink|alternate)["'][^>]*>\n?/g, '');
  html = html.replace(/<link rel="(?:preconnect|dns-prefetch)" href="[^"]*(?:clarity|google-analytics|googletagmanager)[^"]*"[^>]*>\n?/g, '');
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
  t = t.replace('</head>', '{{JSONLD}}\n</head>');
  writeFileSync('src/templates/gov-hub.tpl.html', t);
  console.log('hub template (verbatim):', t.length, 'bytes');
}

mkdirSync('src/templates', { recursive: true });
await buildDetail();
await buildHub();
