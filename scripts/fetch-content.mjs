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
//   books       - bibliographic facts from press_books, for the specs block and
//                 Book/Offer schema on the nine book detail pages
//   lawsuits    - AI Lawsuit Database, written nightly by publish_lawsuits
//   intel       - AI watch feed for Everything else AI, written by publish_intel
const DIRS = ['news', 'people', 'resources', 'leaderboard', 'legislation', 'migrated', 'books', 'lawsuits', 'intel'];

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
  // Resolve main to an exact commit before downloading. The branch tarball at
  // codeload.github.com/.../refs/heads/main is cached for a short time, and the
  // pipeline triggers this build seconds after it commits content, so on
  // 2026-09-23 a build fetched the previous commit and deployed a whole day of
  // page changes as unchanged: the log showed only search indexes uploaded, no
  // pages. git ls-remote asks the repository itself, which is not cached, and a
  // tarball addressed by commit ID cannot be stale. If the lookup fails the
  // build falls back to the branch, as before, and the log says so.
  let ref = 'refs/heads/main';
  let sha = '';
  try {
    sha = execSync('git ls-remote https://github.com/srjordan6/srj-content.git refs/heads/main',
      { encoding: 'utf8' }).split(/\s/)[0];
    if (/^[0-9a-f]{40}$/.test(sha)) ref = sha; else sha = '';
  } catch { sha = ''; }

  execSync(
    'rm -rf /tmp/c && mkdir -p /tmp/c src/content && ' +
    `curl -sfL https://codeload.github.com/srjordan6/srj-content/tar.gz/${ref} -o /tmp/c.tgz && ` +
    'tar -xzf /tmp/c.tgz -C /tmp/c --strip-components=1',
    { stdio: 'inherit' }
  );
  cpSync(`/tmp/c/${REQUIRED}`, `src/content/${REQUIRED}`, { recursive: true });
  for (const d of DIRS) {
    if (existsSync(`/tmp/c/${d}`)) cpSync(`/tmp/c/${d}`, `src/content/${d}`, { recursive: true });
    else console.warn(`content: srj-content has no ${d}/, skipping`);
  }
  console.log(sha
    ? `content: fetched from srj-content@${sha.slice(0, 7)} (main, resolved by git ls-remote)`
    : 'content: fetched from srj-content@main (commit lookup failed, branch tarball may lag)');
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
