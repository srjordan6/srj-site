// Pulls the governance content from the srj-content repo into the build.
// Local dev: copies from a sibling checkout if present.
// CI (Cloudflare): downloads the public tarball from GitHub.
//
// THIS SCRIPT IS AN ALLOW-LIST, which is the thing to remember about it. Every
// content directory must be named here twice, once in the sibling branch and
// once in the tarball branch. A directory that exists in srj-content but is not
// listed simply never reaches src/content, and the failure surfaces much later
// as an unresolved import inside astro build, which reads like a code error
// rather than a missing-file error.
//
// That is exactly what happened on 2026-07-28: leaderboard/leaderboard.json was
// pushed to srj-content and imported by the AI Tools category pages, the fetch
// script did not know about the directory, and the build failed while the
// previous deployment kept serving. Tool pages stayed up, the 23 new category
// pages 404ed, and nothing in the symptom pointed at this file.
//
// WHEN ADDING A NEW CONTENT DIRECTORY: add it to DIRS below. Both branches read
// from the same list, so it cannot be added to one and forgotten in the other,
// which was the original shape of this bug waiting to happen.
import { execSync } from 'node:child_process';
import { existsSync, cpSync, mkdirSync } from 'node:fs';

// governance is required: the library is the bulk of the site and a build
// without it is not worth deploying. The rest are optional at fetch time,
// because a page that hard-imports one will fail loudly on its own.
const REQUIRED = 'governance';

// Every other content directory, in one place so the two branches cannot drift.
//   news        - daily briefing, written by srj-pipeline publish_news
//   people      - AI Movers and Shakers
//   resources   - glossary, tools catalog, tool profiles (WordPress seed exports)
//   leaderboard - arena.ai model rankings, written by publish_leaderboard
//   legislation - AI bill tracker, written by publish_legislation
//   migrated    - the 68 Stage 2 pages lifted verbatim from production
const DIRS = ['news', 'people', 'resources', 'leaderboard', 'legislation', 'migrated'];

const sibling = `../srj-content/${REQUIRED}`;

if (existsSync(sibling)) {
  mkdirSync('src/content/governance', { recursive: true });
  cpSync(sibling, 'src/content/governance', { recursive: true });
  for (const d of DIRS) {
    const from = `../srj-content/${d}`;
    if (existsSync(from)) cpSync(from, `src/content/${d}`, { recursive: true });
    else console.warn(`content: sibling has no ${d}/, skipping`);
  }
  console.log('content: copied from sibling checkout');
} else {
  const tarball =
    'mkdir -p src/content && curl -sL ' +
    'https://codeload.github.com/srjordan6/srj-content/tar.gz/refs/heads/main -o /tmp/c.tgz';
  const pull = (d, required) =>
    ` && ${required ? '' : '('}tar -xzf /tmp/c.tgz -C src/content --strip-components=1 ` +
    `srj-content-main/${d}${required ? '' : ' 2>/dev/null || true)'}`;

  execSync(
    tarball + pull(REQUIRED, true) + DIRS.map((d) => pull(d, false)).join(''),
    { stdio: 'inherit' }
  );
  console.log('content: fetched from srj-content@main');
}

// Fail here, not 200 lines into astro build, when a directory a page hard-imports
// did not arrive. The error above would be a Vite "failed to resolve import",
// which sends you looking at the page rather than at the fetch.
const HARD_REQUIRED = [
  ['src/content/governance', 'the governance library'],
  ['src/content/resources/tools.json', 'the AI Tools catalog'],
  ['src/content/resources/tool-profiles.json', 'the tool profile pages'],
  ['src/content/leaderboard/leaderboard.json', 'the AI Tools category leaderboards'],
  ['src/content/migrated/migrated-pages.json', 'the 68 Stage 2 migrated pages'],
];
const missing = HARD_REQUIRED.filter(([p]) => !existsSync(p));
if (missing.length) {
  console.error('\ncontent: required files did not arrive from srj-content:\n');
  for (const [p, why] of missing) console.error(`  ${p}\n    needed by ${why}`);
  console.error(
    '\nIf the file exists in srj-content, its directory is probably missing from ' +
    'DIRS in scripts/fetch-content.mjs.\n'
  );
  process.exit(1);
}
