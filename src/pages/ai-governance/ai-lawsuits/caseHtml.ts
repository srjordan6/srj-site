// AI Lawsuit Database renderers. Each function returns body_html for a
// synthetic governance entry, so every page here rides the same gov-detail
// chrome, schema graph, and Free AI Resources panel as the rest of the
// library. Data arrives as lawsuits/lawsuits.json, written nightly by the
// srj-pipeline publish_lawsuits stage; nothing on these pages is hand-kept.

export type Case = {
  slug: string; case_name: string; court: string; docket: string;
  judge: string | null; filed_date: string; plaintiffs: string; defendants: string;
  category: string; status: string; status_badge: string;
  latest_development: string | null; latest_development_date: string | null;
  courtlistener_url: string | null; executive_summary: string | null; why_it_matters: string | null;
  target_models: string[]; disputed_datasets: string[]; materials_at_issue: string;
  plaintiff_counsel: string | null; defendant_counsel: string | null;
  claims: { claim: string; basis?: string; status?: string }[];
  timeline: { date: string; title: string; url?: string; doc_no?: string }[];
  tags: string[]; related_slugs: string[]; display_order: number; verified_date: string;
};

const esc = (s: string | null | undefined) => (s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmtDate = (d: string | null | undefined) => {
  if (!d) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return d;
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[+m[2] - 1]} ${+m[3]}, ${+m[1]}`;
};

const CAT_LABEL: Record<string, string> = {
  'copyright': 'Copyright', 'training-data': 'Training Data',
  'privacy': 'Privacy', 'trademark': 'Trademark',
};
const catLabel = (c: string) => CAT_LABEL[c] || c;

const badgeClass = (b: string) => ({
  'Active Litigation': 'is-active', 'Settled': 'is-settled',
  'Decided': 'is-decided', 'Appellate Phase': 'is-appellate',
} as Record<string, string>)[b] || 'is-active';

// Shared styles, emitted once per page inside body_html, mirroring how the
// governance config pages carry their section CSS.
const CSS = `<style>
.srjlaw-badge { display:inline-block; font-family:Poppins,sans-serif; font-size:12px; font-weight:600; letter-spacing:1px; text-transform:uppercase; padding:5px 12px; border-radius:3px; }
.srjlaw-badge.is-active { background:#F07800; color:#fff; }
.srjlaw-badge.is-settled { background:#1A1357; color:#fff; }
.srjlaw-badge.is-decided { background:#201868; color:#fff; }
.srjlaw-badge.is-appellate { background:#7A8A9E; color:#fff; }
.srjlaw-meta { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:14px 28px; background:#FFF6EC; border:1px solid #F0D6B0; border-radius:6px; padding:22px 26px; margin:0 0 32px; font-family:Poppins,sans-serif; }
.srjlaw-meta dt { font-size:12px; letter-spacing:1.5px; text-transform:uppercase; color:#7A8A9E; font-weight:600; margin:0 0 3px; }
.srjlaw-meta dd { margin:0; font-size:15px; line-height:1.55; color:#1A1A2E; }
.srjlaw-meta dd a { color:#F07800; text-decoration:none; }
.srjlaw-meta dd a:hover { text-decoration:underline; }
.srjlaw-latest { border-left:4px solid #F07800; background:#fff; box-shadow:0 1px 4px rgba(32,24,104,.08); padding:18px 22px; margin:0 0 32px; font-family:Poppins,sans-serif; }
.srjlaw-latest .srjlaw-latest-label { font-size:12px; letter-spacing:2px; text-transform:uppercase; color:#F07800; font-weight:600; margin:0 0 8px; }
.srjlaw-latest p { margin:0; font-size:15px; line-height:1.6; color:#1A1A2E; }
.srjlaw-chips { display:flex; flex-wrap:wrap; gap:8px; margin:6px 0 0; padding:0; list-style:none; }
.srjlaw-chips li { background:#fff; border:1px solid #E2D4C2; border-radius:3px; font-family:Poppins,sans-serif; font-size:13px; color:#201868; padding:4px 10px; }
.srjlaw-timeline { list-style:none; margin:0 0 8px; padding:0; font-family:Poppins,sans-serif; }
.srjlaw-timeline li { position:relative; padding:0 0 18px 26px; border-left:2px solid #E2D4C2; margin-left:8px; }
.srjlaw-timeline li::before { content:''; position:absolute; left:-6px; top:4px; width:10px; height:10px; border-radius:50%; background:#F07800; }
.srjlaw-timeline li:last-child { padding-bottom:4px; }
.srjlaw-timeline .srjlaw-tdate { font-size:13px; font-weight:600; color:#201868; letter-spacing:.5px; }
.srjlaw-timeline p { margin:3px 0 0; font-size:14px; line-height:1.55; color:#1A1A2E; }
.srjlaw-timeline a { color:#F07800; text-decoration:none; font-size:13px; }
.srjlaw-timeline a:hover { text-decoration:underline; }
.srjlaw-note { font-family:Poppins,sans-serif; font-size:13px; color:#7A8A9E; margin:16px 0 0; }
.srjlaw-related { list-style:none; margin:0; padding:0; font-family:Poppins,sans-serif; }
.srjlaw-related li { padding:10px 0; border-bottom:1px solid #EFE6D8; }
.srjlaw-related li:last-child { border-bottom:0; }
.srjlaw-related a { color:#201868; font-weight:600; text-decoration:none; }
.srjlaw-related a:hover { color:#F07800; }
</style>`;

// ---------------------------------------------------------------- case page
export function caseBody(c: Case, bySlug: Record<string, Case>): string {
  const parts: string[] = [CSS];

  parts.push(`<p style="margin:0 0 18px;"><span class="srjlaw-badge ${badgeClass(c.status_badge)}">${esc(c.status_badge)}</span></p>`);

  const meta: [string, string][] = [
    ['Court', esc(c.court)],
    ['Docket', esc(c.docket)],
    ['Filed', fmtDate(c.filed_date)],
    ['Category', esc(catLabel(c.category))],
  ];
  if (c.judge) meta.push(['Judge', esc(c.judge)]);
  meta.push(['Plaintiffs', esc(c.plaintiffs)]);
  meta.push(['Defendants', esc(c.defendants)]);
  meta.push(['Current status', esc(c.status)]);
  if (c.courtlistener_url) meta.push(['Docket and filings', `<a href="${esc(c.courtlistener_url)}" target="_blank" rel="noopener">View on CourtListener</a>`]);
  parts.push('<dl class="srjlaw-meta">' + meta.map(([t, d]) => `<div><dt>${t}</dt><dd>${d}</dd></div>`).join('') + '</dl>');

  if (c.latest_development) {
    parts.push(`<div class="srjlaw-latest"><p class="srjlaw-latest-label">Latest development${c.latest_development_date ? ' &middot; ' + fmtDate(c.latest_development_date) : ''}</p><p>${esc(c.latest_development)}</p></div>`);
  }

  // Auto-promoted cases arrive from the discovery stage with no written
  // analysis yet: 76 of 89 as of Aug 3 2026. Render the docket facts we do
  // have and say plainly that the analysis is pending, rather than printing
  // an empty section or, as before, crashing the build on a null read.
  if (c.executive_summary) {
    parts.push(`<h2 id="summary">Executive summary</h2><p>${esc(c.executive_summary)}</p>`);
  } else {
    parts.push(`<h2 id="summary">Executive summary</h2><p>This case is tracked against its live court docket. A written summary has not been published yet; the docket facts above are current as of the last check.</p>`);
  }
  if (c.why_it_matters) {
    parts.push(`<h2 id="why-it-matters">Why it matters</h2><p>${esc(c.why_it_matters)}</p>`);
  }

  if (c.claims && c.claims.length) {
    parts.push('<h2 id="claims">Claims</h2><ul>' + c.claims.map((k) =>
      `<li><strong>${esc(k.claim)}</strong>${k.basis ? ', ' + esc(k.basis) : ''}${k.status ? ' &mdash; ' + esc(k.status) : ''}</li>`).join('') + '</ul>');
  }

  parts.push('<h2 id="whats-at-issue">Models, datasets, and materials at issue</h2>');
  if (c.target_models?.length) parts.push(`<h3>Target models</h3><ul class="srjlaw-chips">${c.target_models.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>`);
  if (c.disputed_datasets?.length) parts.push(`<h3>Disputed datasets</h3><ul class="srjlaw-chips">${c.disputed_datasets.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>`);
  if (c.materials_at_issue) parts.push(`<h3>Materials at issue</h3><p>${esc(c.materials_at_issue)}</p>`);

  if (c.plaintiff_counsel || c.defendant_counsel) {
    parts.push('<h2 id="counsel">Counsel</h2>');
    if (c.plaintiff_counsel) parts.push(`<p><strong>For plaintiffs:</strong> ${esc(c.plaintiff_counsel)}</p>`);
    if (c.defendant_counsel) parts.push(`<p><strong>For defendants:</strong> ${esc(c.defendant_counsel)}</p>`);
  }

  if (c.timeline && c.timeline.length) {
    const tl = [...c.timeline].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 20);
    parts.push('<h2 id="timeline">Docket timeline</h2><ul class="srjlaw-timeline">' + tl.map((t) => {
      const link = t.url ? ` <a href="${esc(t.url)}" target="_blank" rel="noopener">Docket${t.doc_no ? ' #' + esc(t.doc_no) : ''} &rarr;</a>` : '';
      return `<li><span class="srjlaw-tdate">${fmtDate(t.date)}</span><p>${esc(t.title)}${link}</p></li>`;
    }).join('') + '</ul>');
    parts.push('<p class="srjlaw-note">Docket entries sync nightly from CourtListener and the RECAP Archive. Full filings are one click away on the linked docket.</p>');
  }

  const related = (c.related_slugs || []).map((s) => bySlug[s]).filter(Boolean);
  if (related.length) {
    parts.push('<h2 id="related">Related cases</h2><ul class="srjlaw-related">' + related.map((r) =>
      `<li><a href="/ai-governance/ai-lawsuits/${r.slug}/">${esc(r.case_name)}</a></li>`).join('') + '</ul>');
  }

  parts.push(`<p class="srjlaw-note">Facts on this page were last verified against the docket on ${fmtDate(c.verified_date)}. See <a href="/ai-governance/ai-lawsuits/top-free-platforms-for-court-cases/">how we track these cases</a>, or return to <a href="/ai-governance/ai-lawsuits/">all tracked cases</a>.</p>`);

  return parts.join('\n');
}

// -------------------------------------------------------------- index page
export function indexBody(cases: Case[]): string {
  const cats = [...new Set(cases.map((c) => c.category))].sort();
  const badges = [...new Set(cases.map((c) => c.status_badge))].sort();

  const chips = (name: string, vals: string[], labeler: (v: string) => string) =>
    `<div class="srjlaw-fgroup"><span class="srjlaw-flabel">${name}</span>` +
    vals.map((v) => `<button type="button" class="srjlaw-fbtn" data-filter="${name.toLowerCase()}" data-value="${esc(v)}">${esc(labeler(v))}</button>`).join('') +
    '</div>';

  const cards = cases.map((c) => `
  <li class="srjlaw-card" data-category="${esc(c.category)}" data-status="${esc(c.status_badge)}">
    <div class="srjlaw-card-top">
      <span class="srjlaw-badge ${badgeClass(c.status_badge)}">${esc(c.status_badge)}</span>
      <span class="srjlaw-card-court">${esc(c.court)}</span>
    </div>
    <h3><a href="/ai-governance/ai-lawsuits/${c.slug}/">${esc(c.case_name)}</a></h3>
    <p class="srjlaw-card-sum">${esc(c.executive_summary || 'Tracked against the live court docket. Summary pending.')}</p>
    <p class="srjlaw-card-meta">Docket ${esc(c.docket)} &middot; Filed ${fmtDate(c.filed_date)}${c.latest_development_date ? ' &middot; Updated ' + fmtDate(c.latest_development_date) : ''}</p>
  </li>`).join('');

  return CSS + `<style>
.srjlaw-filters { font-family:Poppins,sans-serif; margin:0 0 26px; }
.srjlaw-fgroup { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin:0 0 10px; }
.srjlaw-flabel { font-size:12px; letter-spacing:1.5px; text-transform:uppercase; color:#7A8A9E; font-weight:600; margin-right:4px; }
.srjlaw-fbtn { font-family:Poppins,sans-serif; font-size:13px; color:#201868; background:#fff; border:1px solid #E2D4C2; border-radius:3px; padding:5px 12px; cursor:pointer; }
.srjlaw-fbtn:hover { border-color:#F07800; color:#F07800; }
.srjlaw-fbtn.is-on { background:#201868; border-color:#201868; color:#fff; }
.srjlaw-cards { list-style:none; margin:0; padding:0; }
.srjlaw-card { background:#fff; border:1px solid #E2D4C2; border-radius:6px; padding:22px 26px; margin:0 0 18px; }
.srjlaw-card-top { display:flex; flex-wrap:wrap; align-items:center; gap:12px; margin:0 0 10px; }
.srjlaw-card-court { font-family:Poppins,sans-serif; font-size:13px; color:#7A8A9E; }
.srjlaw-card h3 { font-family:Lora,serif; font-size:21px; margin:0 0 8px; line-height:1.35; }
.srjlaw-card h3 a { color:#201868; text-decoration:none; }
.srjlaw-card h3 a:hover { color:#F07800; }
.srjlaw-card-sum { font-family:Poppins,sans-serif; font-size:15px; line-height:1.6; color:#1A1A2E; margin:0 0 10px; }
.srjlaw-card-meta { font-family:Poppins,sans-serif; font-size:13px; color:#7A8A9E; margin:0; }
.srjlaw-card.is-hidden { display:none; }
</style>
<p>Every case below is tracked against its live court docket, not against news coverage. Statuses, latest developments, and docket timelines sync nightly from CourtListener and the RECAP Archive, and each entry links to the full public filing so you can read the source yourself. Read <a href="/ai-governance/ai-lawsuits/top-free-platforms-for-court-cases/">how we track these cases</a> for the platforms and method behind the database.</p>
<div class="srjlaw-filters">
${chips('Category', cats, catLabel)}
${chips('Status', badges, (v) => v)}
</div>
<ul class="srjlaw-cards">${cards}</ul>
<script>(function(){
var on={category:null,status:null};
function apply(){document.querySelectorAll('.srjlaw-card').forEach(function(c){
  var hide=(on.category&&c.dataset.category!==on.category)||(on.status&&c.dataset.status!==on.status);
  c.classList.toggle('is-hidden',!!hide);});}
document.querySelectorAll('.srjlaw-fbtn').forEach(function(b){b.addEventListener('click',function(){
  var f=b.dataset.filter,v=b.dataset.value;
  on[f]=(on[f]===v)?null:v;
  document.querySelectorAll('.srjlaw-fbtn[data-filter="'+f+'"]').forEach(function(x){x.classList.toggle('is-on',on[f]===x.dataset.value);});
  apply();});});
})();</script>`;
}

// --------------------------------------------------- hub section (section 2)
// Rendered into the {{LAWSUITS}} placeholder on the governance hub. Shows the
// most recently updated cases and routes into the full database.
export function hubSection(cases: Case[]): string {
  const recent = [...cases]
    .sort((a, b) => ((b.latest_development_date || b.filed_date) < (a.latest_development_date || a.filed_date) ? -1 : 1))
    .slice(0, 5);
  const rows = recent.map((c) => `
    <li><a href="/ai-governance/ai-lawsuits/${c.slug}/">${esc(c.case_name)}</a>
    <span class="srjgov-child-teaser">${esc(c.status_badge)}${c.latest_development_date ? ' &middot; updated ' + fmtDate(c.latest_development_date) : ''} &middot; ${esc(c.court)}</span></li>`).join('\n');
  return `
<section id="ai-legal-cases" class="srjlaw-hub-section">
  <h2 class="srjlaw-section-h">2. AI Legal Cases</h2>
  <p class="srjlaw-hub-intro">Active intellectual property, copyright, training data, and privacy lawsuits shaping AI law, tracked case by case against the live court dockets and verified before anything publishes. Each case page carries the executive summary, why it matters, the models and datasets at issue, and a docket timeline that links straight to the public filings.</p>
  <ul class="srjgov-children-list">${rows}
  </ul>
  <p class="srjlaw-hub-links"><a class="srjgov-cta-btn" href="/ai-governance/ai-lawsuits/">Browse all tracked cases</a> <a class="srjlaw-hub-method" href="/ai-governance/ai-lawsuits/top-free-platforms-for-court-cases/">How we track these cases</a></p>
</section>`;
}

// ------------------------------------------------------- methodology page
// Substance supplied by Stephen R. Jordan; house-styled for the site.
export function methodologyBody(): string {
  return `
<p>The AI Lawsuit Database is built entirely from public court records. Every platform below is free, and together they cover federal dockets, state courts, and judicial opinions nationwide. These are the sources we work from, and they are the same sources you can use to verify any case on this site yourself.</p>

<h2 id="courtlistener">1. CourtListener and the RECAP Archive</h2>
<p><strong>Best for:</strong> Federal and state dockets, full text opinions, and downloadable filings.</p>
<p><strong>How it works:</strong> Maintained by the non-profit Free Law Project, CourtListener hosts hundreds of millions of case records, opinions, and audio recordings of oral arguments.</p>
<p><strong>The RECAP advantage:</strong> Official federal court filings are housed on PACER, which usually charges $0.10 per page. CourtListener's browser extension, RECAP, automatically uploads any documents purchased or retrieved by its massive network of users into a public, 100% free searchable archive.</p>

<h2 id="google-scholar">2. Google Scholar (Case Law)</h2>
<p><strong>Best for:</strong> Searching judicial opinions across state supreme and appellate courts and federal courts.</p>
<p><strong>How it works:</strong> Go to Google Scholar and select the "Case law" radio button under the search bar. You can filter searches by specific state or federal jurisdictions to read full court opinions and see which subsequent cases cited those opinions.</p>

<h2 id="judyrecords">3. JudyRecords</h2>
<p><strong>Best for:</strong> Searching nationwide lawsuit filings and party names.</p>
<p><strong>How it works:</strong> JudyRecords is a free nationwide search engine covering over 700 million state and federal court records. It excels at cross-referencing names or business entities across various jurisdictions without requiring an account.</p>

<h2 id="justia-findlaw">4. Justia and FindLaw</h2>
<p><strong>Best for:</strong> User-friendly summaries of major state and federal court opinions, organized by legal topic or court level.</p>
<p><strong>How it works:</strong> Both sites maintain comprehensive databases of historic and recent court decisions, making it easy to look up cases by party name, volume number, or keyword.</p>

<h2 id="state-portals">5. Official State and County Court Portals</h2>
<p><strong>Best for:</strong> Local criminal, civil, family, or traffic court records.</p>
<p><strong>How it works:</strong> Most county clerk of court websites offer a public search portal, often called Smart Search, Odyssey Portal, or Public Access Inquiry. These local portals allow you to search local court dockets, hearing dates, and case statuses for free.</p>

<h2 id="pacer">Free access options for federal records (PACER)</h2>
<p>If you need official filings from PACER, the federal courts' Public Access to Court Electronic Records system:</p>
<ul>
<li><strong>The $30 per quarter rule:</strong> PACER charges $0.10 per page viewed. However, if your bill is $30 or less in a calendar quarter, the fee is completely waived, effectively making light research free.</li>
<li><strong>Court opinions:</strong> Written judge opinions on PACER are always 100% free to download.</li>
<li><strong>Courthouse public terminals:</strong> Visiting any federal courthouse library or clerk's office allows you to search and view PACER documents for free on their public access terminals.</li>
</ul>

<h2 id="how-we-use-them">How the database uses these sources</h2>
<p>Each case in the <a href="/ai-governance/ai-lawsuits/">AI Lawsuit Database</a> is anchored to its CourtListener docket. A nightly sync pulls new docket entries, updates case statuses, and watches for newly filed AI lawsuits across the RECAP Archive. Nothing is published from a news article alone: statuses and timeline entries come from the docket itself, and every case page links to the full public filings so you can read the source directly.</p>`;
}
