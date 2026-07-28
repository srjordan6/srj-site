// Pulls the governance content from the srj-content repo into the build.
// Local dev: copies from a sibling checkout if present.
// CI (Cloudflare): downloads the public tarball from GitHub.
import { execSync } from 'node:child_process';
import { existsSync, cpSync, mkdirSync } from 'node:fs';

const dest = 'src/content/governance';
const sibling = '../srj-content/governance';
const newsSibling = '../srj-content/news';
const peopleSibling = '../srj-content/people';

if (existsSync(sibling)) {
  mkdirSync(dest, { recursive: true });
  cpSync(sibling, dest, { recursive: true });
  if (existsSync(newsSibling)) cpSync(newsSibling, 'src/content/news', { recursive: true });
  if (existsSync(peopleSibling)) cpSync(peopleSibling, 'src/content/people', { recursive: true });
  console.log('content: copied from sibling checkout');
} else {
  execSync(
    'mkdir -p src/content && curl -sL https://codeload.github.com/srjordan6/srj-content/tar.gz/refs/heads/main -o /tmp/c.tgz' +
    ' && tar -xzf /tmp/c.tgz -C src/content --strip-components=1 srj-content-main/governance' +
    ' && (tar -xzf /tmp/c.tgz -C src/content --strip-components=1 srj-content-main/news 2>/dev/null || true)' +
    ' && (tar -xzf /tmp/c.tgz -C src/content --strip-components=1 srj-content-main/people 2>/dev/null || true)',
    { stdio: 'inherit' }
  );
  console.log('content: fetched from srj-content@main');
}
