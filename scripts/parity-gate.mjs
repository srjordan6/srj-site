// The migration's evidence generator. Runs the fidelity gates for the
// governance path against a target origin (staging or production) using
// the July 27, 2026 inventory as the contract. Exit 0 = all gates pass.
// Usage: node scripts/parity-gate.mjs https://srj-site.srjordan.workers.dev
import { readFileSync } from 'node:fs';

const origin = process.argv[2];
if (!origin) { console.error('usage: node scripts/parity-gate.mjs <origin>'); process.exit(2); }

const inventory = JSON.parse(readFileSync('scripts/governance-contract.json', 'utf8'));
const dupes = new Set(inventory.retired_duplicates);
let pass = 0, fail = 0;
const failures = [];

const strip = (h) => h.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
  .replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

for (const page of inventory.pages) {
  if (dupes.has(page.path)) continue;
  const res = await fetch(origin + page.path, { redirect: 'manual' });
  const checks = [];
  checks.push(['200', res.status === 200]);
  if (res.status === 200) {
    const html = await res.text();
    checks.push(['canonical', html.includes(`rel="canonical" href="https://srjconsultingservices.com${page.path}"`)]);
    if (page.title_marker) checks.push(['title', html.includes(page.title_marker)]);
    if (!page.words_exempt) {
    const words = strip(html).split(' ').length;
    // template chrome differs from WP by a constant; the gate bounds the
    // BODY delta: |new - (live - chrome)| within 2% of live body.
    const bodyLive = page.words - inventory.wp_chrome_words;
    const bodyNew = words - inventory.new_chrome_words;
    checks.push(['words±2%', Math.abs(bodyNew - bodyLive) <= Math.max(20, bodyLive * 0.02)]);
    }
    if (page.schema_types) for (const t of page.schema_types)
      checks.push(['schema:' + t, html.includes(`"@type":"${t}"`)]);
  }
  const bad = checks.filter(([, ok]) => !ok);
  if (bad.length) { fail++; failures.push(page.path + ' -> ' + bad.map(([n]) => n).join(', ')); }
  else pass++;
}
console.log(`parity gate: ${pass} pass, ${fail} fail`);
for (const f of failures) console.log('  FAIL', f);
process.exit(fail ? 1 : 0);
