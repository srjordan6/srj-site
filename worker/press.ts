// @ts-nocheck
/**
 * The press kit, served natively from this Worker at /press/press_kit/.
 *
 * Ported from the standalone srj-press Worker on 2026-09-10. That Worker had
 * no repo, no bindings, and reached everything it needed over public HTTP,
 * which is how it silently died when its data source moved off Render, how it
 * hit Cloudflare error 1042 fetching a sibling Worker, and how it timed out
 * (522) fetching its own logo once it was proxied under this site. Every one of
 * those failures came from the same fact: it lived outside the site it served.
 *
 * Inside the site it has what it needs by binding, not by URL:
 *   env.MCP     service binding to srj-mcp, which serves /press.json from the
 *               press_* tables in Postgres through Hyperdrive
 *   env.ASSETS  the built site, where public/press/brand and covers live
 *   env.MEDIA   the R2 media tree, where the older covers live under
 *               /wp-content/uploads/
 *
 * Nothing is pre-rendered. Every PDF and the zip are built on request from
 * the live payload, cached five minutes at the edge, and never written
 * anywhere. Edit a press_* row and the next download reflects it.
 *
 * What the kit contains is the press_assets table: the documents this module
 * renders, the brand files it reads, and one cover per Library volume. A file
 * not in that table is not in the kit, and the kit cannot claim a resolution
 * it does not have, because the labels are the table's.
 *
 * Secrets: CF_API_TOKEN, Cloudflare API token with Account > Browser
 * Rendering > Edit. Set on this Worker, srj-site.
 */

export const PRESS_KIT_PREFIX = '/press/press_kit';

// ---------- Config ----------

// Cloudflare account hosting this Worker (visible in the dashboard URL).
const CF_ACCOUNT_ID = "2db97ad8218dd8a17d22368d32e41161";

const WP_BASE = "https://srjconsultingservices.com/wp-content/uploads/";
// Fallbacks only. The real asset list, with resolutions, comes from
// press.assets (the press_assets table) so the kit can never claim a file
// or a resolution it does not have.
const ASSETS  = {
  logo:  WP_BASE + "SRJ-Consulting-Services-Medium.jpg",
  photo: WP_BASE + "stephen-jordan-medium.jpg",
  cover: WP_BASE + "Book_Cover.png",
};

/** First brand asset with a given code, e.g. LOGO or PHOTO. */
const brandAsset = (press, code) =>
  ((press.assets && press.assets.brand) || []).find((a) => a.code === code);
/** Cover for a Library volume, from press.assets.covers. */
const coverAsset = (press, n) =>
  ((press.assets && press.assets.covers) || []).find((a) => Number(a.book_number) === n);

const AMAZON_SERIES = "https://www.amazon.com/dp/B0H5KPF2BG";

const C = {
  navy:"#201868", orange:"#F07800", gray:"#7A8A9E",
  ink:"#1A1D29", soft:"#F5F6F9", line:"#E2E5EC",
};
const CACHE_SECONDS = 300;

// ---------- Data ----------
const esc = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function parasToHtml(text) {
  if (!text) return "<p><em>Bio unavailable.</em></p>";
  return text.split(/\n\s*\n/).map((p) => `<p>${esc(p.trim())}</p>`).join("");
}

/**
 * Fetch the whole press kit in one request.
 *
 * Throws on anything other than a usable payload. Callers that can degrade (the
 * live page) catch it; callers that cannot (the PDFs) let it surface as a 500,
 * because a press kit PDF with silently missing sections is worse than one that
 * failed to build.
 */
async function loadPress(env) {
  if (!env.MCP) throw new Error("MCP service binding is not configured on srj-site");
  const res = await env.MCP.fetch(new Request("https://srj-mcp/press.json"));
  if (!res.ok) throw new Error(`press.json ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  if (!d || !d.counts) throw new Error("press.json returned no payload");
  return d;
}

/** Roman numerals for volume labels. The library will not exceed nine. */
const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX"];

/** Books that are actually published, in order. */
const published = (press) => (press.books || []).filter((b) => b.status === "available");

/** "Volumes I–IV of 9 in print" — derived, never written down. */
function volumeLine(press) {
  const books = press.books || [];
  const out = published(press);
  if (!out.length) return `${books.length} volumes planned`;
  const span = out.length === 1 ? ROMAN[1] : `${ROMAN[1]}&ndash;${ROMAN[out.length]}`;
  const label = out.length === 1 ? "Volume" : "Volumes";
  return `${label} ${span} of ${books.length} in print`;
}

/** Pick one ISBN for a book, preferring hardback, then paperback. */
function primaryIsbn(book) {
  const list = book.isbns || [];
  const pick = list.find((i) => i.format === "Hardback")
            || list.find((i) => i.format === "Paperback")
            || list[0];
  return pick ? pick.isbn : "";
}

/** "Hardcover $59.99 · Paperback $22.99 · Kindle $9.99" for a book. */
function priceLine(book) {
  const NAME = { Hardback: "Hardcover", Paperback: "Paperback", Ebook: "Kindle" };
  return (book.isbns || [])
    .filter((i) => i.list_price != null)
    .map((i) => `${NAME[i.format] || i.format} $${Number(i.list_price).toFixed(2)}`)
    .join(" &middot; ");
}

const copyOf = (press, key, fallback = "") =>
  (press.copy && press.copy[key]) ? press.copy[key] : fallback;

function todayLabel() {
  return new Date().toLocaleDateString("en-US", {
    timeZone: "America/Chicago", month: "long", day: "numeric", year: "numeric",
  });
}

// ---------- Brand assets ----------
const SITE = "https://srjconsultingservices.com";

/**
 * Read an asset. Same-site URLs never leave the Worker: the build's asset
 * layer answers first (public/press/*, /covers/*), then the R2 media tree
 * (/wp-content/*). Anything off-site is fetched normally. This is the fix
 * for the 522 loop: a Worker fetching its own zone over HTTP re-enters
 * itself, and the request times out waiting on the request it is handling.
 */
async function fetchBinary(env, url) {
  const u = new URL(url, SITE);
  if (u.hostname === "srjconsultingservices.com") {
    const local = await env.ASSETS.fetch(new Request(u.toString()));
    if (local.ok) return new Uint8Array(await local.arrayBuffer());
    const key = decodeURIComponent(u.pathname.slice(1));
    const obj = await env.MEDIA.get(key);
    if (obj) return new Uint8Array(await obj.arrayBuffer());
    throw new Error(`Asset ${u.pathname} not found in build or R2`);
  }
  const res = await fetch(u.toString(), { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!res.ok) throw new Error(`Asset ${url} ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
function u8ToBase64(u8) {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(s);
}
function dataUri(u8, mime) { return `data:${mime};base64,${u8ToBase64(u8)}`; }
function imgMime(u8) {
  if (u8 && u8[0] === 0x89 && u8[1] === 0x50) return "image/png";
  return "image/jpeg";
}
async function loadAssets(env, press) {
  const logoUrl  = (brandAsset(press, "LOGO")  || {}).url || ASSETS.logo;
  const photoUrl = (brandAsset(press, "PHOTO") || {}).url || ASSETS.photo;
  const coverUrl = (coverAsset(press, 1) || {}).url || ASSETS.cover;
  const [logoBytes, photoBytes, coverBytes] = await Promise.all([
    fetchBinary(env, logoUrl),
    fetchBinary(env, photoUrl),
    fetchBinary(env, coverUrl).catch(() => null),
  ]);
  return {
    logoBytes, photoBytes, coverBytes,
    logoUri:  dataUri(logoBytes,  imgMime(logoBytes)),
    photoUri: dataUri(photoBytes, imgMime(photoBytes)),
    coverUri: coverBytes ? dataUri(coverBytes, imgMime(coverBytes)) : "",
  };
}

// ---------- Shared template chrome ----------
//
// FONTS_HEAD is used by the PDF templates only. Those are rendered server-side
// by Cloudflare Browser Rendering, so no visitor's IP reaches Google.
//
// The live HTML page uses FONTS_HEAD_PUBLIC instead, which self-hosts. Loading
// fonts.googleapis.com on a page a person visits transmits their IP to Google
// before any consent can be sought, which the Munich Regional Court held to be
// a GDPR violation (3 O 17493/20). The main site was moved off Google Fonts for
// this reason; this page should not be the exception.
const FONTS_HEAD = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,500;0,600;0,700;1,400;1,500&family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
`;
const FONTS_HEAD_PUBLIC = `
<link rel="stylesheet" href="/fonts/fonts.css">
`;

const BRAND_VARS = `
:root{
  --navy:${C.navy}; --orange:${C.orange}; --gray:${C.gray};
  --ink:${C.ink}; --soft:${C.soft}; --line:${C.line};
}
*{ box-sizing:border-box; margin:0; padding:0; }
html{ -webkit-print-color-adjust:exact; print-color-adjust:exact; }
`;

// ===================================================================
// TEMPLATE: Short Bio (1 page)
// ===================================================================
function shortBioHtml({ assets, press }) {
  const body = parasToHtml(press.bios && press.bios.short);
  const series = copyOf(press, "series.name", "The Operating Discipline for AI Library&trade;");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
${FONTS_HEAD}
<style>
${BRAND_VARS}
@page{ size:Letter; margin:0; }
body{ font-family:'Poppins',sans-serif; color:var(--ink); font-size:11pt; line-height:1.62; }
.page{ width:8.5in; min-height:11in; padding:0.7in 0.85in 0.6in; position:relative; }
.top{ display:flex; justify-content:space-between; align-items:flex-start; gap:24px;
  border-bottom:3px solid var(--navy); padding-bottom:18px; }
.top .logo{ height:42px; margin-bottom:20px; }
.eyebrow{ font-weight:600; font-size:8pt; letter-spacing:0.22em; text-transform:uppercase; color:var(--orange); }
h1{ font-family:'Lora',serif; font-size:27pt; color:var(--navy); line-height:1.05; margin-top:4px; font-weight:600; }
.role{ font-family:'Lora',serif; font-style:italic; font-size:11.5pt; color:var(--gray); margin-top:6px; }
.photo{ width:1.35in; height:1.35in; object-fit:cover; border-radius:6px; flex:none;
  border:3px solid #fff; box-shadow:0 4px 16px rgba(32,24,104,0.18); }
.body{ margin-top:26px; }
.body p{ margin-bottom:13px; }
.body em{ font-style:italic; }
.contact{ margin-top:30px; padding-top:16px; border-top:1px solid var(--line);
  display:flex; flex-wrap:wrap; gap:6px 28px; font-size:9pt; color:var(--gray); }
.contact b{ color:var(--navy); font-weight:600; }
.foot{ position:absolute; bottom:0.45in; left:0.85in; right:0.85in; font-size:7.6pt; color:var(--gray);
  border-top:1px solid var(--line); padding-top:8px; display:flex; justify-content:space-between; }
</style></head><body>
<div class="page">
  <div class="top">
    <div>
      <img class="logo" src="${assets.logoUri}">
      <div class="eyebrow">Short Biography</div>
      <h1>Stephen R. Jordan</h1>
      <div class="role">Founder &amp; Principal Advisor, SRJ Consulting &amp; Services LLC<br>Author, <em>${series}</em></div>
    </div>
    <img class="photo" src="${assets.photoUri}">
  </div>
  <div class="body">${body}</div>
  <div class="contact">
    <span><b>Press</b>&nbsp; 415-413-7772</span>
    <span><b>Email</b>&nbsp; info@srjconsultingservices.com</span>
    <span><b>Web</b>&nbsp; srjconsultingservices.com</span>
  </div>
  <div class="foot">
    <span>SRJ Consulting &amp; Services LLC &middot; Short Biography</span>
    <span>Generated ${todayLabel()}</span>
  </div>
</div></body></html>`;
}

// ===================================================================
// TEMPLATE: Executive Bio (résumé-style, multi-page)
// ===================================================================
function executiveBioHtml({ assets, press }) {
  const series    = copyOf(press, "series.name", "The Operating Discipline for AI Library&trade;");
  const publisher = copyOf(press, "publisher", "SRJ Consulting & Services Publishing");
  const out       = published(press);

  // Authorship: one line per published volume, generated. The previous version
  // listed three books in hand-written HTML and did not gain a fourth when
  // Book 04 shipped.
  const authorship = out.map((b, i) => {
    const pages = b.pages ? ` ${b.pages} pages;` : "";
    return `<div class="line"><b>${esc(b.title)}</b>, Author. ${esc(publisher)}, ${
      b.published_on ? b.published_on.slice(0, 4) : "2026"
    }. Volume ${ROMAN[i + 1]} of <em>${series}</em>.${pages} hardcover, paperback, and Kindle.</div>`;
  }).join("");

  // The summary's volume count is derived for the same reason.
  const titlesSentence = out.length
    ? `Author of <em>${series}</em>, ${out.length === 1 ? "one volume" : `${["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][out.length]} volumes`} in print.`
    : "";

  const currentRoleTitles = out.map((b) => `<em>${esc(b.title)}</em>`).join(", ");
  const nServices = (press.service_lines || []).length;

  // Experience: rendered straight from press.chronology, in API order. The API
  // sorts by sort_order and filters is_active; do not re-sort or filter here.
  // Three career-break rows are deliberately excluded server-side.
  const jobs = (press.chronology || []).map((j) => `
<div class="job">
  <div class="r1"><div class="org">${esc(j.org)}, <span class="ttl">${esc(j.role)}</span></div><div class="when">${esc(j.period)}</div></div>
  <p class="jd">${esc(j.detail)}</p>
</div>`).join("");

  // Prose sections from press_copy. A missing key omits its section entirely;
  // there are deliberately no hardcoded fallbacks, so a fact corrected in the
  // database can never be shadowed by a stale string in this file.
  const proseSec = (title, key) => {
    const v = copyOf(press, key, "");
    return v ? `<h2 class="sec">${title}</h2>\n<div class="line">${esc(v)}</div>\n` : "";
  };

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
${FONTS_HEAD}
<style>
${BRAND_VARS}
@page{ size:Letter; margin:0.55in 0.62in; }
body{ font-family:'Poppins',sans-serif; color:var(--ink); font-size:9.4pt; line-height:1.4; }
h1,h2,h3,.serif{ font-family:'Lora',serif; }
.head{ display:flex; justify-content:space-between; align-items:flex-start; gap:20px; }
.head .logo{ height:38px; margin-bottom:14px; }
.head h1{ font-size:25pt; color:var(--navy); line-height:1.02; font-weight:600; }
.head .role{ font-family:'Lora'; font-style:italic; font-size:11pt; color:var(--gray); margin-top:5px; max-width:6in; }
.head .contact{ font-size:8.4pt; color:#3a3f50; margin-top:9px; }
.head .contact b{ color:var(--navy); }
.head img.photo{ width:1.05in; height:1.05in; object-fit:cover; border-radius:5px; flex:none;
  border:2px solid #fff; box-shadow:0 3px 12px rgba(32,24,104,0.16); }
.bar{ height:3px; background:var(--navy); margin:13px 0 0; }
.summary{ margin-top:13px; font-size:9.6pt; line-height:1.5; color:#2c3142; }
h2.sec{ font-size:8.4pt; font-weight:600; letter-spacing:0.16em; text-transform:uppercase; color:var(--orange);
  border-bottom:1.5px solid var(--line); padding-bottom:4px; margin:17px 0 10px; font-family:'Poppins';
  page-break-after:avoid; }
.job{ margin-bottom:10px; page-break-inside:avoid; }
.job .r1{ display:flex; justify-content:space-between; align-items:baseline; gap:14px; }
.job .org{ font-family:'Lora'; font-weight:600; font-size:11pt; color:var(--navy); }
.job .org .ttl{ color:var(--ink); font-weight:400; font-style:italic; }
.job .when{ font-size:8.2pt; color:var(--gray); white-space:nowrap; flex:none; font-weight:500; }
.job .loc{ font-size:8.2pt; color:var(--gray); margin-top:1px; }
.job ul{ margin:5px 0 0 0; padding-left:15px; }
.job li{ margin-bottom:3px; font-size:9.2pt; color:#33384a; }
.job li::marker{ color:var(--orange); }
.job .jd{ margin-top:4px; font-size:9.2pt; color:#33384a; }
.line{ font-size:9.2pt; color:#33384a; margin-bottom:5px; }
.line b{ color:var(--navy); font-weight:600; }
ul.rec{ padding-left:15px; }
ul.rec li{ font-size:9.2pt; color:#33384a; margin-bottom:3px; }
ul.rec li::marker{ color:var(--orange); }
</style></head><body>

<div class="head">
  <div>
    <img class="logo" src="${assets.logoUri}">
    <h1>Stephen R. Jordan</h1>
    <div class="role">Founder &amp; Principal Advisor, SRJ Consulting &amp; Services LLC &middot; Author, <em>${series}</em></div>
    <div class="contact"><b>Frisco, Texas</b>&nbsp; &middot; &nbsp;415-413-7772&nbsp; &middot; &nbsp;info@srjconsultingservices.com&nbsp; &middot; &nbsp;srjconsultingservices.com</div>
  </div>
  <img class="photo" src="${assets.photoUri}">
</div>
<div class="bar"></div>

<div class="summary">
  Operator-led AI advisor with three decades in enterprise operations, security, and risk, including the programs of Citi, Intel, McAfee, and Optiv. Built and ran security programs at global scale, 500,000 endpoints across 165 countries, product-security incident response across multibillion-dollar portfolios, then translated that operating experience into a documented advisory methodology, The AI Operating System&trade;. Advises owners and executives on running AI as a managed business function, with no software, vendor, or implementation conflicts. ${titlesSentence}
</div>

<h2 class="sec">Experience</h2>
${jobs}

<h2 class="sec">Authorship</h2>
${authorship}

${proseSec("Intellectual Property", "bio.intellectual_property")}
${proseSec("Education", "bio.education")}
${proseSec("Certifications", "bio.certifications")}
${proseSec("Professional Development", "bio.professional_development")}
${proseSec("Recognition", "bio.recognition")}
${proseSec("Professional Affiliations", "bio.affiliations")}
${proseSec("Areas of Expertise", "bio.expertise")}
</body></html>`;
}

// ===================================================================
// TEMPLATE: Fact Sheet (1 page, 2-column)
// ===================================================================
function factSheetHtml({ assets, press }) {
  const series    = copyOf(press, "series.name", "The Operating Discipline for AI Library&trade;");
  const publisher = copyOf(press, "publisher", "SRJ Consulting & Services Publishing");
  const services  = press.service_lines || [];
  const out       = published(press);

  const serviceList = services
    .map((s) => `<li>${esc(s.name)}</li>`).join("");

  const volumeRows = out.map((b, i) =>
    `<dt>Vol ${ROMAN[i + 1]}</dt><dd>${esc(b.title)}${b.pages ? ` &middot; ${b.pages} pp` : ""}</dd>`
  ).join("");

  // The four AI Operating System layers come from press_copy, so a change to
  // the methodology does not need a code edit here.
  const layers = [1, 2, 3, 4].map((n) => {
    const k = String(n).padStart(2, "0");
    const t = copyOf(press, `aios.${k}.title`);
    const b = copyOf(press, `aios.${k}.body`);
    return t ? `<li><b>${esc(t)}</b>, ${esc(b.replace(/\.$/, ""))}</li>` : "";
  }).join("");

  const countWord = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"][services.length] || services.length;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
${FONTS_HEAD}
<style>
${BRAND_VARS}
@page{ size:Letter; margin:0; }
body{ font-family:'Poppins',sans-serif; color:var(--ink); font-size:8.4pt; line-height:1.34; }
.page{ width:8.5in; padding:0.34in 0.62in 0.3in; position:relative; }
h1,h2,h3,.serif{ font-family:'Lora',serif; }
.head{ display:flex; justify-content:space-between; align-items:flex-start; border-bottom:3px solid var(--navy); padding-bottom:10px; }
.head .logo{ height:46px; }
.head .eyebrow{ font-weight:600; font-size:7.5pt; letter-spacing:0.22em; text-transform:uppercase; color:var(--orange); }
.head h1{ font-size:21pt; color:var(--navy); line-height:1.05; margin-top:3px; font-weight:600; }
.head .tag{ font-family:'Lora'; font-style:italic; font-size:9.5pt; color:var(--gray); margin-top:3px; }
.head .right{ text-align:right; font-size:8pt; color:#3a3f50; line-height:1.6; padding-top:4px; }
.head .right b{ color:var(--navy); }
.cols{ display:flex; gap:22px; margin-top:11px; }
.col{ flex:1; }
.col.left{ flex:1.05; }
.sec{ margin-bottom:6px; }
.sec h2{ font-size:8pt; font-weight:600; letter-spacing:0.14em; text-transform:uppercase; color:var(--orange);
  border-bottom:1px solid var(--line); padding-bottom:3px; margin-bottom:6px; font-family:'Poppins'; }
dl{ display:grid; grid-template-columns:auto 1fr; gap:5px 12px; }
dt{ color:var(--gray); font-size:8pt; }
dd{ font-weight:500; }
dd b{ font-weight:600; color:var(--navy); }
p{ margin-bottom:5px; }
.lead{ font-size:8.8pt; }
ul{ margin:2px 0 0 0; padding-left:14px; }
li{ margin-bottom:3px; }
li::marker{ color:var(--orange); }
.principal{ display:flex; gap:13px; align-items:flex-start; margin-bottom:9px; }
.principal img{ width:0.85in; height:0.85in; object-fit:cover; border-radius:5px; border:2px solid #fff;
  box-shadow:0 3px 12px rgba(32,24,104,0.18); flex:none; }
.principal .nm{ font-family:'Lora'; font-size:13pt; font-weight:600; color:var(--navy); line-height:1.1; }
.principal .rl{ font-size:8pt; color:var(--gray); margin-top:2px; }
.facts{ display:grid; grid-template-columns:1fr 1fr; gap:1px; background:var(--line); border:1px solid var(--line); border-radius:5px; overflow:hidden; }
.fact{ background:#fff; padding:6px 10px; }
.fact .big{ font-family:'Lora'; font-weight:700; font-size:12.5pt; color:var(--navy); line-height:1; }
.fact .cap{ font-size:7pt; color:var(--gray); margin-top:3px; line-height:1.25; }
.book{ background:var(--soft); border-left:3px solid var(--orange); border-radius:4px; padding:10px 12px; }
.book .t{ font-family:'Lora'; font-weight:600; font-size:10pt; color:var(--navy); }
.book .s{ font-size:7.6pt; color:var(--gray); font-style:italic; margin:2px 0 6px; }
.book dl{ gap:3px 10px; }
.book dt,.book dd{ font-size:7.8pt; }
.ip{ font-size:8pt; }
.ip b{ color:var(--navy); }
.foot{ display:flex; justify-content:space-between; margin-top:8px;
  font-size:7pt; color:var(--gray); border-top:1px solid var(--line); padding-top:7px; }
</style></head><body>
<div class="page">

  <div class="head">
    <div>
      <div class="eyebrow">Company Fact Sheet</div>
      <h1>SRJ Consulting &amp; Services LLC</h1>
      <div class="tag">Operator-led AI advisory for executives accountable for AI outcomes</div>
    </div>
    <div class="right">
      <img class="logo" src="${assets.logoUri}"><br>
      <b>415-413-7772</b><br>
      info@srjconsultingservices.com<br>
      srjconsultingservices.com
    </div>
  </div>

  <div class="cols">
    <div class="col left">
      <div class="sec">
        <h2>The Company</h2>
        <dl>
          <dt>Legal name</dt><dd><b>${esc(copyOf(press, "entity.legal_name", "SRJ Consulting & Services LLC"))}</b></dd>
          <dt>Entity</dt><dd>${esc(copyOf(press, "entity.formation", ""))}</dd>
          <dt>Headquarters</dt><dd>Frisco, Texas 75035 (Dallas&ndash;Fort Worth)</dd>
          <dt>Founder</dt><dd>Stephen R. Jordan, Principal Advisor</dd>
          <dt>Practice</dt><dd>AI governance, operating discipline &amp; business performance</dd>
          <dt>Clients</dt><dd>Mid-market to large multinational conglomerates</dd>
          <dt>Wikidata</dt><dd>Q140622666</dd>
          <dt>Registry</dt><dd>OpenCorporates us_tx/0806615653 (Texas)</dd>
        </dl>
      </div>

      <div class="sec">
        <h2>What Makes It Different</h2>
        <p class="lead">SRJ sells no software, holds no vendor partnerships, and earns no implementation fees. Most AI advisory is sold by firms that also sell the tools, the build, or the staffing, so the advice bends toward what's being sold. SRJ carries none of those conflicts. The only product is operating judgment.</p>
      </div>

      <div class="sec">
        <h2>Methodology, ${esc(copyOf(press, "aios.name", "The AI Operating System™"))}</h2>
        <p>A framework for governing AI as a permanent business function across four operating layers:</p>
        <ul>${layers}</ul>
      </div>

      <div class="sec">
        <h2>${countWord} Service Lines</h2>
        <ul style="columns:2;column-gap:16px;">${serviceList}</ul>
      </div>
    </div>

    <div class="col">
      <div class="sec">
        <h2>The Principal</h2>
        <div class="principal">
          <img src="${assets.photoUri}">
          <div>
            <div class="nm">Stephen R. Jordan</div>
            <div class="rl">Founder &amp; Principal Advisor &middot; Author, <em>${series}</em></div>
          </div>
        </div>
        <p>Three decades in enterprise operations, security, and risk, including the programs of <b>Citi, Intel, McAfee, and Optiv</b>, the foundation of the SRJ methodology. Career highlights:</p>
        <ul>
          <li><b>Citi</b>, owned endpoint security across 500,000 devices in 165 countries</li>
          <li><b>McAfee</b>, led global product-security incident response; 120+ security architects</li>
          <li><b>Intel</b>, led product security incident response and disclosure across the portfolio</li>
          <li><b>Optiv</b>, senior advisor scoping enterprise security engagements at the C-suite</li>
          <li>Earlier: co-owned an insurance brokerage across the U.S. and China; began as a college instructor</li>
        </ul>
      </div>

      <div class="sec">
        <h2>Background &amp; Credentials</h2>
        <dl>
          <dt>Education</dt><dd>M.A. Political Science &amp; B.B.A. Accounting, West Texas A&amp;M; doctoral coursework, East Texas A&amp;M (102 graduate hours)</dd>
          <dt>Certification</dt><dd>${esc(copyOf(press, "bio.certifications", ""))}</dd>
          <dt>Development</dt><dd>${esc(copyOf(press, "bio.professional_development", ""))}</dd>
          <dt>Affiliation</dt><dd>${esc(copyOf(press, "bio.affiliations", ""))}</dd>
        </dl>
      </div>

      <div class="sec">
        <h2>Career Fast Facts</h2>
        <div class="facts">
          <div class="fact"><div class="big">3 decades</div><div class="cap">Enterprise operations, security &amp; risk</div></div>
          <div class="fact"><div class="big">500,000</div><div class="cap">Endpoints / 165 countries</div></div>
          <div class="fact"><div class="big">120+</div><div class="cap">Security architects led</div></div>
          <div class="fact"><div class="big">Texas LLC</div><div class="cap">Effective May 22, 2026</div></div>
        </div>
      </div>

      <div class="sec">
        <h2>The Library</h2>
        <div class="book">
          <div class="t">${series}</div>
          <div class="s">${volumeLine(press)} &middot; ${esc(publisher)}, 2026</div>
          <dl>
            ${volumeRows}
            <dt>Formats</dt><dd>Hardcover &middot; Paperback &middot; Kindle</dd>
            <dt>Order</dt><dd>${AMAZON_SERIES.replace("https://www.", "")}</dd>
          </dl>
        </div>
      </div>

      <div class="sec">
        <h2>Intellectual Property</h2>
        <p class="ip"><b>The AI Business Enablement Audit&trade;</b>, USPTO trademark application filed May 31, 2026, International Class 16 (printed publications).</p>
      </div>
    </div>
  </div>

  <div class="foot"><span>SRJ Consulting &amp; Services LLC &middot; Company Fact Sheet</span><span>info@srjconsultingservices.com &middot; 415-413-7772 &middot; Generated ${todayLabel()}</span></div>
</div>
</body></html>`;
}

// ===================================================================
// TEMPLATE: Press Kit (6 pages)
// ===================================================================
function pressKitHtml({ assets, press }) {
  const execBioParas  = parasToHtml(press.bios && press.bios.medium);
  const shortBioParas = parasToHtml(press.bios && press.bios.short);
  const series    = copyOf(press, "series.name", "The Operating Discipline for AI Library&trade;");
  const publisher = copyOf(press, "publisher", "SRJ Consulting & Services Publishing");
  const services  = press.service_lines || [];
  const out       = published(press);
  const nServices = services.length;
  const countWord = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"][nServices] || nServices;

  // Background snapshot: the current role and the four before it, straight
  // from press.chronology (rows 0-4: SRJ, Optiv, Citi, McAfee PSIRT, Intel).
  // The earlier version skipped row 0 and left a 2026 kit ending in 2020.
  const bgRoles = (press.chronology || []).slice(0, 5).map((j) => {
    const firstSentence = ((j.detail || "").split(". ")[0] + ".").replace(/\.\.$/, ".");
    return `<div class="role"><div class="org">${esc(j.org)}</div><div><div class="meta">${esc(j.role)} &middot; ${esc(j.period)}</div><div class="desc">${esc(firstSentence)}</div></div></div>`;
  }).join("");

  const coverImg = assets.coverUri
    ? `<img src="${assets.coverUri}">`
    : `<div style="width:2.05in;height:3.05in;background:var(--soft);border:1px solid var(--line);border-radius:3px;display:flex;align-items:center;justify-content:center;color:var(--gray);font-family:'Lora';font-size:10pt;">Book Cover</div>`;

  const layerBlocks = [1, 2, 3, 4].map((n) => {
    const k = String(n).padStart(2, "0");
    const t = copyOf(press, `aios.${k}.title`);
    const b = copyOf(press, `aios.${k}.body`);
    return t ? `<div class="layer"><div class="n">${k}</div><div><h3>${esc(t)}</h3><p>${esc(b)}</p></div></div>` : "";
  }).join("");

  const svcGrid = services.map((s) =>
    `<div class="svc"><div class="t">${esc(s.name)}</div><div class="d">${esc(s.pillar)}</div></div>`
  ).join("");

  const specRows = out.map((b, i) => {
    const isbn = primaryIsbn(b);
    return `<li><span>Volume ${ROMAN[i + 1]}</span><span>${esc(b.title)}${
      b.pages ? ` &middot; ${b.pages} pp` : ""}${isbn ? ` &middot; ISBN ${isbn}` : ""}</span></li>`;
  }).join("");

  // In This Kit, from press.assets. Labels and resolutions are the table's;
  // this file no longer describes any file it does not ship.
  const A = press.assets || {};
  const docs   = A.documents || [];
  const brand  = A.brand || [];
  const covers = A.covers || [];
  const kitRows = (list, icon = (a) => a.code) => list.map((a) =>
    `<div class="dl"><div class="ic">${esc(icon(a))}</div><div><div class="nm">${esc(a.label)}</div><div class="ds">${esc(a.description)}</div></div></div>`
  ).join("");

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
${FONTS_HEAD}
<style>
${BRAND_VARS}
@page{ size:Letter; margin:0; }
body{ font-family:'Poppins',sans-serif; color:var(--ink); font-size:10.2pt; line-height:1.5; }
.page{ width:8.5in; min-height:11in; padding:0.72in 0.8in; position:relative; page-break-after:always; }
.page:last-child{ page-break-after:auto; }
h1,h2,h3,.serif{ font-family:'Lora',serif; }
.eyebrow{ font-family:'Poppins',sans-serif; font-weight:600; font-size:8pt; letter-spacing:0.18em;
  text-transform:uppercase; color:var(--orange); margin-bottom:8px; }
.rule{ height:3px; width:46px; background:var(--orange); border:0; margin:10px 0 16px; }
p{ margin-bottom:9px; }
strong{ font-weight:600; }
a{ color:var(--navy); text-decoration:none; }
.hero{ padding:0; }
.hero .band{ background:var(--navy); color:#fff; padding:0.85in 0.8in 0.7in; }
.hero .logobox{ display:inline-block; background:#fff; border-radius:9px; padding:11px 16px; margin-bottom:42px; box-shadow:0 4px 16px rgba(0,0,0,0.18); }
.hero .logobox img{ height:42px; display:block; }
.hero .kicker{ font-family:'Poppins'; font-weight:600; font-size:8.5pt; letter-spacing:0.32em;
  text-transform:uppercase; color:#F07800; margin-bottom:14px; }
.hero h1{ font-size:40pt; line-height:1.02; font-weight:600; letter-spacing:-0.01em; }
.hero .subrole{ font-family:'Lora'; font-style:italic; font-size:12.5pt; color:#C9CEEA; margin-top:13px; line-height:1.5; max-width:6.5in; }
.hero .body{ display:flex; gap:34px; padding:40px 0.8in 0; align-items:flex-start; }
.hero .photo{ width:2.1in; height:2.1in; border-radius:6px; object-fit:cover; flex:none;
  border:4px solid #fff; box-shadow:0 6px 22px rgba(32,24,104,0.18); }
.hero .intro{ font-family:'Lora'; font-size:12.5pt; line-height:1.55; color:#2A2E3D; }
.contact{ display:flex; flex-wrap:wrap; gap:6px 26px; margin-top:22px; padding-top:18px;
  border-top:1px solid var(--line); font-size:9pt; color:var(--gray); }
.contact b{ color:var(--ink); font-weight:600; }
.hero .footnote{ position:absolute; bottom:0.5in; left:0.8in; right:0.8in; font-size:7.6pt;
  color:var(--gray); border-top:1px solid var(--line); padding-top:8px; }
.secthead{ font-size:21pt; font-weight:600; color:var(--navy); line-height:1.1; }
.lead{ font-size:11pt; color:#33384a; }
.block{ margin-bottom:20px; }
.label{ font-family:'Poppins'; font-weight:600; font-size:8pt; letter-spacing:0.12em;
  text-transform:uppercase; color:var(--gray); margin-bottom:5px; }
.card{ background:var(--soft); border-left:3px solid var(--orange); border-radius:4px;
  padding:13px 16px; margin-bottom:11px; }
.card h3{ font-size:11.5pt; color:var(--navy); margin-bottom:3px; }
.card p{ margin:0; font-size:9.4pt; color:#3a3f50; }
.two{ display:flex; gap:22px; }
.two>div{ flex:1; }
.layer{ display:flex; gap:13px; margin-bottom:12px; align-items:flex-start; }
.layer .n{ font-family:'Lora'; font-size:15pt; font-weight:700; color:var(--orange);
  width:30px; flex:none; line-height:1; padding-top:2px; }
.layer h3{ font-size:11.5pt; color:var(--navy); }
.layer p{ margin:1px 0 0; font-size:9.4pt; color:#3a3f50; }
.grid{ display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:4px; }
.svc{ background:#fff; border:1px solid var(--line); border-radius:5px; padding:12px 14px; }
.svc .t{ font-family:'Lora'; font-weight:600; font-size:10.8pt; color:var(--navy); }
.svc .d{ font-size:8.8pt; color:var(--gray); margin-top:3px; }
.book{ display:flex; gap:30px; align-items:flex-start; margin-top:6px; }
.book img{ width:2.05in; border-radius:3px; box-shadow:0 8px 26px rgba(32,24,104,0.22); flex:none; }
.specs{ list-style:none; font-size:9.2pt; margin:10px 0 14px; }
.specs li{ padding:4px 0; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:14px; }
.specs li span:first-child{ color:var(--gray); }
.specs li span:last-child{ font-weight:600; text-align:right; }
.buy{ display:inline-block; background:var(--orange); color:#fff; font-weight:600; font-size:9.5pt;
  padding:9px 20px; border-radius:5px; letter-spacing:0.02em; }
.facts{ display:grid; grid-template-columns:1fr 1fr 1fr; gap:1px; background:var(--line);
  border:1px solid var(--line); border-radius:6px; overflow:hidden; margin-top:6px; }
.fact{ background:#fff; padding:14px 14px; }
.fact .big{ font-family:'Lora'; font-weight:700; font-size:16pt; color:var(--navy); line-height:1; }
.fact .cap{ font-size:8pt; color:var(--gray); margin-top:5px; line-height:1.3; }
.role{ display:flex; gap:14px; padding:9px 0; border-bottom:1px solid var(--line); }
.role .org{ font-family:'Lora'; font-weight:600; font-size:10.6pt; color:var(--navy); width:1.5in; flex:none; }
.role .meta{ font-size:8.4pt; color:var(--gray); }
.role .desc{ font-size:9.2pt; color:#3a3f50; }
.dl{ display:flex; align-items:center; gap:12px; background:var(--soft); border-radius:5px;
  padding:11px 14px; margin-bottom:8px; }
.dl .ic{ width:30px; height:30px; border-radius:5px; background:var(--navy); color:#fff;
  font-family:'Poppins'; font-weight:600; font-size:7pt; display:flex; align-items:center;
  justify-content:center; flex:none; letter-spacing:0.03em; }
.dl .nm{ font-weight:600; font-size:9.6pt; color:var(--ink); }
.dl .ds{ font-size:8.4pt; color:var(--gray); }
.foot{ position:absolute; bottom:0.5in; left:0.8in; right:0.8in; display:flex; justify-content:space-between;
  font-size:7.6pt; color:var(--gray); border-top:1px solid var(--line); padding-top:8px; }
.cta{ background:var(--navy); color:#fff; border-radius:7px; padding:20px 24px; margin-top:8px; }
.cta .l{ font-size:8pt; letter-spacing:0.18em; text-transform:uppercase; color:#F07800; font-weight:600; }
.cta .e{ font-family:'Lora'; font-size:14pt; margin-top:6px; }
.cta .e a{ color:#fff; }
</style></head><body>

<div class="page hero">
  <div class="band">
    <div class="logobox"><img src="${assets.logoUri}"></div>
    <div class="kicker">Press &amp; Media Kit</div>
    <h1>Stephen R. Jordan</h1>
    <div class="subrole">Founder &amp; Principal Advisor, SRJ Consulting &amp; Services LLC<br>Author, <em>${series}</em></div>
  </div>
  <div class="body">
    <img class="photo" src="${assets.photoUri}">
    <div class="intro">
      An operator-led AI advisory practice for executives accountable for AI outcomes, built on three decades in enterprise operations, security, and risk, including the programs of Citi, Intel, McAfee, and Optiv. The practice sells no software, holds no vendor partnerships, and earns no implementation fees. The only product is operating judgment.
      <div class="contact">
        <span><b>Press contact</b>&nbsp; 415-413-7772</span>
        <span><b>Email</b>&nbsp; info@srjconsultingservices.com</span>
        <span><b>Web</b>&nbsp; srjconsultingservices.com</span>
        <span><b>Based in</b>&nbsp; Frisco, Texas (DFW)</span>
      </div>
    </div>
  </div>
  <div class="footnote">SRJ Consulting &amp; Services LLC &middot; ${esc(copyOf(press, "entity.formation", ""))} &middot; Media inquiries welcome</div>
</div>

<div class="page">
  <div class="eyebrow">Biographies</div>
  <div class="secthead">For attribution, use as written</div>
  <hr class="rule">
  <div class="block">
    <div class="label">Executive bio</div>
    ${execBioParas}
  </div>
  <div class="block">
    <div class="label">Short bio</div>
    ${shortBioParas}
  </div>
  <div class="block">
    <div class="label">Company boilerplate</div>
    <div class="card" style="border-left-color:var(--navy);">
      <p>SRJ Consulting &amp; Services LLC is an operator-led AI advisory practice serving executives accountable for AI outcomes. The firm sells no software, holds no vendor partnerships, and earns no implementation fees; its only product is operating judgment, delivered through The AI Operating System&trade; across ${nServices} service lines. Founded in 2023 and based in Frisco, Texas, SRJ serves clients from mid-market organizations to large multinational conglomerates. <strong>srjconsultingservices.com</strong></p>
    </div>
  </div>
</div>

<div class="page">
  <div class="eyebrow">The Methodology</div>
  <div class="secthead">${esc(copyOf(press, "aios.name", "The AI Operating System™"))}</div>
  <hr class="rule">
  <p class="lead" style="margin-bottom:16px;">A structured framework for governing AI as a permanent business function, treating it not as a technology to install, but as a class of business activity that must be visible, accountable, controlled, and measured. Four operating layers:</p>
  ${layerBlocks}
  <div class="label" style="margin-top:22px;">${countWord} service lines</div>
  <div class="grid">${svcGrid}</div>
</div>

<div class="page">
  <div class="eyebrow">The Library</div>
  <div class="secthead">${series}</div>
  <hr class="rule">
  <div class="book">
    ${coverImg}
    <div style="flex:1;">
      <p style="font-family:'Lora';font-style:italic;color:var(--gray);margin-bottom:10px;">${volumeLine(press)} &middot; ${esc(publisher)}, 2026</p>
      <ul class="specs">
        ${specRows}
        <li><span>Formats</span><span>Hardcover &middot; Paperback &middot; Kindle</span></li>
      </ul>
      <a class="buy" href="${AMAZON_SERIES}">View the series on Amazon &rarr;</a>
    </div>
  </div>
  <div class="block" style="margin-top:20px;">
    <div class="label">About Volume I, the diagnostic foundation</div>
    <p>The operating system for running AI as a permanent business function. Written for owners, presidents, CFOs, and COOs at organizations between 20 and 1,000 employees who would rather decide than guess, it closes the gap between AI technology primers and prompt collections.</p>
    <p>The book provides a complete framework to audit every AI tool and embedded feature in the business, govern AI usage without slowing the work, meet the regulatory bar without consulting-firm overhead, and turn AI from experiment into managed business function, structured as a working executive reference, not a narrative or a polemic.</p>
  </div>
</div>

<div class="page">
  <div class="eyebrow">Background</div>
  <div class="secthead">Three decades of operating leadership</div>
  <hr class="rule">
  ${bgRoles}
  <div class="label" style="margin-top:24px;">Fast facts</div>
  <div class="facts">
    <div class="fact"><div class="big">3 decades</div><div class="cap">Enterprise operations, security &amp; risk</div></div>
    <div class="fact"><div class="big">500,000</div><div class="cap">Endpoints secured across 165 countries</div></div>
    <div class="fact"><div class="big">120+</div><div class="cap">Senior security architects led at McAfee PSIRT</div></div>
    <div class="fact"><div class="big">$1M+</div><div class="cap">Technology budget managed</div></div>
    <div class="fact"><div class="big">121&ndash;146%</div><div class="cap">Of quota; multiple President's Club awards</div></div>
    <div class="fact"><div class="big">Texas LLC</div><div class="cap">SRJ effective May 22, 2026 (originally Nevada, April 21, 2023)</div></div>
  </div>
  <div class="foot"><span>Stephen R. Jordan &middot; Press &amp; Media Kit</span><span>srjconsultingservices.com</span></div>
</div>

<div class="page">
  <div class="eyebrow">In This Kit</div>
  <div class="secthead">Documents &amp; brand assets</div>
  <hr class="rule">
  <div class="two">
    <div>
      <div class="label">Documents (PDF)</div>
      ${kitRows(docs)}
    </div>
    <div>
      <div class="label">Brand assets</div>
      ${kitRows(brand)}
      <div class="label" style="margin-top:14px;">Book covers</div>
      ${kitRows(covers, (a) => "VOL " + ROMAN[Number(a.book_number)])}
    </div>
  </div>
  <div class="cta">
    <div class="l">Media &amp; speaking inquiries</div>
    <div class="e">415-413-7772 &nbsp;&middot;&nbsp; <a href="mailto:info@srjconsultingservices.com">info@srjconsultingservices.com</a></div>
    <div style="font-size:9pt;color:#C9CEEA;margin-top:8px;">Available for executive keynotes, board briefings, conference panels, and interviews on AI governance, operating discipline, and the practical management of AI as a business function.</div>
  </div>
  <div class="foot"><span>SRJ Consulting &amp; Services LLC &middot; Frisco, Texas</span><span>Generated ${todayLabel()}</span></div>
</div>

</body></html>`;
}

// ===================================================================
// TEMPLATE: Live HTML Page
// ===================================================================
function livePageHtml({ press, updated, notice }) {
  const execBio  = parasToHtml(press.bios && press.bios.medium);
  const shortBio = parasToHtml(press.bios && press.bios.short);
  const series   = copyOf(press, "series.name", "The Operating Discipline for AI Library&trade;");
  const publisher = copyOf(press, "publisher", "SRJ Consulting & Services Publishing");
  const books    = press.books || [];
  const out      = published(press);

  const factSheetBlock = Object.entries(press.fact_groups || {}).map(([group, rows]) => `
      <div class="factcol">
        <h3>${esc(group)}</h3>
        ${rows.map((r) => `<div class="fact"><span class="k">${esc(r.fact)}</span><span class="v">${esc(r.value)}</span></div>`).join("")}
      </div>`).join("");

  const layers = [1, 2, 3, 4].map((n) => {
    const k = String(n).padStart(2, "0");
    const t = copyOf(press, `aios.${k}.title`);
    const b = copyOf(press, `aios.${k}.body`);
    return t ? `<div class="layer"><span class="n">${k}</span><div><h4>${esc(t)}</h4><p>${esc(b)}</p></div></div>` : "";
  }).join("");

  // Book cards, grouped by pillar, with status straight from the database. The
  // previous version wrote these nine cards by hand, which is how Book 04 sat
  // marked "Forthcoming" for five days after it published.
  const pillars = [];
  for (const b of books) {
    let p = pillars.find((x) => x.name === b.pillar);
    if (!p) { p = { name: b.pillar, items: [] }; pillars.push(p); }
    p.items.push(b);
  }
  const bookBlocks = pillars.map((p, idx) => {
    const cards = p.items.map((b) => {
      const badge = b.status === "available"
        ? `<span style="color:var(--orange);font-weight:600">Available Now</span>`
        : "Forthcoming";
      const num = String(b.book_number).padStart(2, "0");
      return `<div><b>${esc(b.title)}</b><span style="display:block;font-size:12.5px;color:var(--gray);margin-top:4px;font-family:'Poppins',sans-serif;font-weight:400">Book ${num} &middot; ${badge}</span></div>`;
    }).join("");
    return `<div class="label"${idx ? "" : ` style="margin-top:26px"`}>Pillar ${ROMAN[idx + 1]} &middot; ${esc(p.name)}&trade;</div><div class="svc">${cards}</div>`;
  }).join("");

  const libraryLine = out.map((b) => {
    const isbn = primaryIsbn(b);
    return `<em>${esc(b.title)}</em> (${b.pages ? `${b.pages} pp, ` : ""}ISBN ${isbn})`;
  }).join(", ");

  const dl = (path, label, sub) =>
    `<a class="dl" href="${path}"><span class="dlt">${label}</span><span class="dls">${sub}</span></a>`;
  const A = press.assets || {};
  const docCount = (A.documents || []).length;
  const coverCount = (A.covers || []).length;
  const docLinks = (A.documents || []).map((d) => dl(PRESS_KIT_PREFIX + d.url, `${d.label} (PDF)`, d.description)).join("\n      ");

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stephen R. Jordan, Press &amp; Media Kit | SRJ Consulting &amp; Services</title>
<meta name="description" content="Press and media kit for Stephen R. Jordan, founder of SRJ Consulting & Services LLC and author of The Operating Discipline for AI Library.">
${FONTS_HEAD_PUBLIC}
<style>
  ${BRAND_VARS}
  body{font-family:'Poppins',system-ui,sans-serif;color:var(--ink);line-height:1.6;background:#fff}
  .wrap{max-width:920px;margin:0 auto;padding:0 22px}
  a{color:var(--navy)}
  h1,h2,h3,.serif{font-family:'Lora',Georgia,serif}
  .hero{background:var(--navy);color:#fff;padding:54px 0 46px}
  .hero .logo{height:46px;background:#fff;padding:9px 13px;border-radius:8px;margin-bottom:30px}
  .eyebrow{font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:var(--orange);font-weight:600}
  .hero h1{font-size:46px;line-height:1.03;margin:10px 0 0;font-weight:600}
  .hero .role{font-style:italic;color:#C9CEEA;font-size:18px;margin-top:12px;max-width:34em}
  .hero .contact{margin-top:22px;font-size:14px;color:#C9CEEA;display:flex;flex-wrap:wrap;gap:6px 24px}
  .hero .contact b{color:#fff;font-weight:600}
  section{padding:40px 0;border-bottom:1px solid var(--line)}
  section h2{font-size:13px;letter-spacing:.16em;text-transform:uppercase;font-family:'Poppins';font-weight:600;color:var(--orange);margin-bottom:18px}
  .downloads{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
  .dl{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:9px;padding:15px 17px;text-decoration:none;transition:.15s;background:#fff}
  .dl:hover{border-color:var(--orange);box-shadow:0 4px 16px rgba(240,120,0,.12)}
  .dlt{font-weight:600;color:var(--navy);font-size:15px}
  .dls{font-size:12.5px;color:var(--gray);margin-top:3px}
  .bio p{margin-bottom:13px;font-size:16px}
  .bio .label,.label{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--gray);font-weight:600;margin:22px 0 8px}
  .facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:26px}
  .factcol h3{font-size:15px;color:var(--navy);margin-bottom:10px;border-bottom:2px solid var(--orange);display:inline-block;padding-bottom:3px}
  .fact{display:flex;justify-content:space-between;gap:14px;padding:6px 0;border-bottom:1px solid var(--line);font-size:14px}
  .fact .k{color:var(--gray)}.fact .v{font-weight:500;text-align:right}
  .layers{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .layer{display:flex;gap:12px}.layer .n{font-family:'Lora';font-weight:600;color:var(--orange);font-size:20px}
  .layer h4{color:var(--navy);font-size:15px}.layer p{font-size:13.5px;color:#3a3f50}
  .svc{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:6px}
  .svc div{background:var(--soft);border-radius:6px;padding:10px 13px;font-size:14px}
  .svc b{font-family:'Lora';color:var(--navy);font-weight:600}
  .foot{padding:30px 0 50px;color:var(--gray);font-size:13px;text-align:center}
  .stamp{font-size:12px;color:var(--gray);margin-top:18px}
  @media(max-width:640px){.hero h1{font-size:34px}.layers,.svc{grid-template-columns:1fr}}
</style></head><body>

<header class="hero"><div class="wrap">
  <img class="logo" src="${ASSETS.logo}" alt="SRJ Consulting & Services">
  <div class="eyebrow">Press &amp; Media Kit</div>
  <h1>Stephen R. Jordan</h1>
  <div class="role">Founder &amp; Principal Advisor, SRJ Consulting &amp; Services LLC &middot; Author, <em>${series}</em></div>
  <div class="contact">
    <span><b>Press</b> 415-413-7772</span>
    <span><b>Email</b> info@srjconsultingservices.com</span>
    <span><b>Web</b> srjconsultingservices.com</span>
    <span><b>Based in</b> Frisco, Texas (DFW)</span>
  </div>
</div></header>

<main class="wrap">
  ${notice ? `<section><div style="background:#FFF4E8;border:1px solid #F3C796;border-radius:8px;padding:12px 16px;color:#8a4b00;font-size:14px">${esc(notice)}</div></section>` : ""}

  <section>
    <h2>Download (built on demand)</h2>
    <div class="downloads">
      ${dl(PRESS_KIT_PREFIX + "/kit.zip", "Everything (.zip)", `${docCount} PDFs, brand assets, and ${coverCount} book covers, freshly built`)}
      ${docLinks}
    </div>
  </section>

  <section class="bio">
    <h2>Biography</h2>
    <div class="label">Executive bio</div>
    ${execBio}
    <div class="label">Short bio</div>
    ${shortBio}
  </section>

  <section>
    <h2>${esc(copyOf(press, "aios.name", "The AI Operating System™"))}</h2>
    <div class="layers">${layers}</div>
    ${bookBlocks}
  </section>

  <section>
    <h2>Fact Sheet</h2>
    <div class="facts">${factSheetBlock}</div>
  </section>

  <section>
    <h2>The Library</h2>
    <p style="font-size:16px"><strong>${series}</strong>, ${volumeLine(press)}. ${esc(publisher)}, 2026. ${libraryLine}. Hardcover, paperback, and Kindle. <a href="${AMAZON_SERIES}" target="_blank" rel="noopener">View the series on Amazon &rarr;</a></p>
  </section>

  <div class="stamp">Every download on this page is built fresh on request: the Worker reads the SRJ database, renders the PDFs, and assembles the zip. Page generated ${updated}.</div>
</main>

<footer class="foot">SRJ Consulting &amp; Services LLC &middot; Frisco, Texas &middot; info@srjconsultingservices.com &middot; 415-413-7772</footer>
</body></html>`;
}

// ===================================================================
// PDF rendering via Cloudflare Browser Rendering REST API
// ===================================================================
async function renderPdf(env, html) {
  if (!env.CF_API_TOKEN) throw new Error("CF_API_TOKEN secret is not set");
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/browser-rendering/pdf`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      html,
      viewport: { width: 816, height: 1056, deviceScaleFactor: 2 },
      gotoOptions: { waitUntil: "networkidle0", timeout: 30000 },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Browser Rendering ${res.status}: ${text.slice(0, 500)}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

// ===================================================================
// Inline ZIP writer (store-only, no compression)
// ===================================================================
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function w16(view, off, v) { view.setUint16(off, v & 0xFFFF, true); }
function w32(view, off, v) { view.setUint32(off, v >>> 0, true); }

function buildZip(entries) {
  const enc = new TextEncoder();
  const fileChunks = [];
  const centralChunks = [];
  let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const nameBytes = enc.encode(name);
    const c = crc32(data);
    const size = data.length;

    const lf = new ArrayBuffer(30 + nameBytes.length);
    const lv = new DataView(lf);
    w32(lv, 0, 0x04034b50);
    w16(lv, 4, 20);
    w16(lv, 6, 0);
    w16(lv, 8, 0);
    w16(lv, 10, 0);
    w16(lv, 12, 0x21);
    w32(lv, 14, c);
    w32(lv, 18, size);
    w32(lv, 22, size);
    w16(lv, 26, nameBytes.length);
    w16(lv, 28, 0);
    new Uint8Array(lf, 30).set(nameBytes);
    fileChunks.push(new Uint8Array(lf));
    fileChunks.push(data);

    const cd = new ArrayBuffer(46 + nameBytes.length);
    const cv = new DataView(cd);
    w32(cv, 0, 0x02014b50);
    w16(cv, 4, 20);
    w16(cv, 6, 20);
    w16(cv, 8, 0);
    w16(cv, 10, 0);
    w16(cv, 12, 0);
    w16(cv, 14, 0x21);
    w32(cv, 16, c);
    w32(cv, 20, size);
    w32(cv, 24, size);
    w16(cv, 28, nameBytes.length);
    w16(cv, 30, 0);
    w16(cv, 32, 0);
    w16(cv, 34, 0);
    w16(cv, 36, 0);
    w32(cv, 38, 0);
    w32(cv, 42, offset);
    new Uint8Array(cd, 46).set(nameBytes);
    centralChunks.push(new Uint8Array(cd));

    offset += 30 + nameBytes.length + size;
  }

  let centralStart = 0;
  for (const c of fileChunks) centralStart += c.length;
  let centralSize = 0;
  for (const c of centralChunks) centralSize += c.length;

  const eocd = new ArrayBuffer(22);
  const ev = new DataView(eocd);
  w32(ev, 0, 0x06054b50);
  w16(ev, 4, 0);
  w16(ev, 6, 0);
  w16(ev, 8, centralChunks.length);
  w16(ev, 10, centralChunks.length);
  w32(ev, 12, centralSize);
  w32(ev, 16, centralStart);
  w16(ev, 20, 0);

  const total = centralStart + centralSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of fileChunks) { out.set(c, p); p += c.length; }
  for (const c of centralChunks) { out.set(c, p); p += c.length; }
  out.set(new Uint8Array(eocd), p);
  return out;
}

// ===================================================================
// Response helpers
// ===================================================================
function pdfResponse(bytes, filename) {
  return new Response(bytes, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": `public, max-age=${CACHE_SECONDS}`,
    },
  });
}
function zipResponse(bytes, filename) {
  return new Response(bytes, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": `public, max-age=${CACHE_SECONDS}`,
    },
  });
}
function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_SECONDS}`,
    },
  });
}
function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

// ===================================================================
// Cache wrapper
// ===================================================================
async function cached(request, ctx, generator) {
  const cache = caches.default;
  const cacheKey = new Request(request.url, { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const response = await generator();
  if (response.status === 200) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}

// ===================================================================
// Route handlers
// ===================================================================
async function handleLive(request, env, ctx) {
  return cached(request, ctx, async () => {
    try {
      const press = await loadPress(env);
      const updated = new Date().toLocaleString("en-US", {
        timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short",
      }) + " CT";
      return htmlResponse(livePageHtml({ press, updated, notice: "" }));
    } catch (err) {
      // The page shell and download buttons still render. Degrading here is
      // right: a journalist who cannot see the bios can still reach the PDFs
      // and the contact details.
      return htmlResponse(livePageHtml({
        press: { bios: {}, fact_groups: {}, books: [], service_lines: [], copy: {} },
        updated: new Date().toUTCString(),
        notice: "Live content is temporarily unavailable; downloads still build on request. (" + err.message + ")",
      }), 200);
    }
  });
}
async function handleShortBio(request, env, ctx) {
  return cached(request, ctx, async () => {
    const press = await loadPress(env);
    const assets = await loadAssets(env, press);
    const pdf = await renderPdf(env, shortBioHtml({ assets, press }));
    return pdfResponse(pdf, "SRJ_Short_Bio.pdf");
  });
}
async function handleExecBio(request, env, ctx) {
  return cached(request, ctx, async () => {
    const press = await loadPress(env);
    const assets = await loadAssets(env, press);
    const pdf = await renderPdf(env, executiveBioHtml({ assets, press }));
    return pdfResponse(pdf, "SRJ_Executive_Bio.pdf");
  });
}
async function handleFactSheet(request, env, ctx) {
  return cached(request, ctx, async () => {
    const press = await loadPress(env);
    const assets = await loadAssets(env, press);
    const pdf = await renderPdf(env, factSheetHtml({ assets, press }));
    return pdfResponse(pdf, "SRJ_Company_Fact_Sheet.pdf");
  });
}
async function handlePressKit(request, env, ctx) {
  return cached(request, ctx, async () => {
    const press = await loadPress(env);
    const assets = await loadAssets(env, press);
    const pdf = await renderPdf(env, pressKitHtml({ assets, press }));
    return pdfResponse(pdf, "SRJ_Press_Kit.pdf");
  });
}
async function handleKitZip(request, env, ctx) {
  return cached(request, ctx, async () => {
    const press = await loadPress(env);
    const assets = await loadAssets(env, press);
    const templates = [
      ["SRJ_Press_Kit.pdf",          pressKitHtml({ assets, press })],
      ["SRJ_Executive_Bio.pdf",      executiveBioHtml({ assets, press })],
      ["SRJ_Short_Bio.pdf",          shortBioHtml({ assets, press })],
      ["SRJ_Company_Fact_Sheet.pdf", factSheetHtml({ assets, press })],
    ];
    const pdfPairs = await Promise.all(
      templates.map(async ([name, html]) => [name, await renderPdf(env, html)])
    );

    // Every file in the zip comes from press_assets. Documents are the PDFs
    // rendered above; brand files and covers are fetched by their table URL
    // and stored at their table zip_path. A fetch that fails is left out and
    // named in the README, never silently substituted.
    const A = press.assets || {};
    const files = [...(A.brand || []), ...(A.covers || [])].filter((a) => a.zip_path);
    const fetched = await Promise.all(files.map(async (a) => {
      try { return [a, await fetchBinary(env, a.url)]; } catch (e) { return [a, null]; }
    }));

    const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
    const lines = [];
    for (const d of (A.documents || [])) lines.push(`  ${pad(d.zip_path || "", 52)}${d.description}`);
    for (const [a, bytes] of fetched) {
      lines.push(`  ${pad(a.zip_path, 52)}${a.description}${bytes ? "" : "  (unavailable at build time)"}`);
    }
    const readme = new TextEncoder().encode(
`SRJ Consulting & Services, Press Kit
Generated ${todayLabel()} on demand from the SRJ database.

Contents:
${lines.join("\n")}

Contact:
  Stephen R. Jordan, Founder & Principal Advisor
  SRJ Consulting & Services LLC, Frisco, Texas
  415-413-7772, info@srjconsultingservices.com, srjconsultingservices.com
`);

    const entries = {};
    for (const [name, bytes] of pdfPairs) entries[name] = bytes;
    for (const [a, bytes] of fetched) if (bytes) entries[a.zip_path] = bytes;
    entries["README.txt"] = readme;

    return zipResponse(buildZip(entries), "SRJ_Press_Kit.zip");
  });
}

// ===================================================================
// Entry, called from worker/index.ts for anything under PRESS_KIT_PREFIX
// ===================================================================
export async function handlePress(request, env, ctx) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return textResponse("Method Not Allowed", 405);
  }
  const url = new URL(request.url);
  // One canonical address for the kit page.
  if (url.pathname === PRESS_KIT_PREFIX) {
    return Response.redirect(`${url.origin}${PRESS_KIT_PREFIX}/${url.search}`, 301);
  }
  const path = url.pathname.slice(PRESS_KIT_PREFIX.length).toLowerCase() || "/";
  try {
    switch (path) {
      case "/":                  return await handleLive(request, env, ctx);
      case "/kit.zip":           return await handleKitZip(request, env, ctx);
      case "/press-kit.pdf":     return await handlePressKit(request, env, ctx);
      case "/executive-bio.pdf": return await handleExecBio(request, env, ctx);
      case "/short-bio.pdf":     return await handleShortBio(request, env, ctx);
      case "/fact-sheet.pdf":    return await handleFactSheet(request, env, ctx);
      default:                   return textResponse("Not Found", 404);
    }
  } catch (err) {
    return textResponse(
      "Press kit service error: " + err.message + "\n\n" +
      "If this persists, contact info@srjconsultingservices.com.",
      500,
    );
  }
}
