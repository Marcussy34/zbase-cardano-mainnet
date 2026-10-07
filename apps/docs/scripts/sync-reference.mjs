// Copies the deep documents from docs/ into content/reference/ so the site can render them.
// The copies are generated and git-ignored. Edit the files under docs/, never the copies.
// It runs before `next dev` and `next build` through the predev and prebuild scripts.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const docsDir = join(repoRoot, 'docs');
const outDir = join(here, '..', 'content', 'reference');
const github = 'https://github.com/Marcussy34/zx402';

// Source file (relative to docs/), page slug, and sidebar title. The order is the sidebar order.
const pages = [
  ['HANDOFF.md', 'handoff', 'Handoff'],
  ['PRD.md', 'prd', 'Product requirements'],
  ['SPEC.md', 'spec', 'Technical specification'],
  ['research/2026-10-07-comparison-with-base.md', 'comparison-with-base', 'Comparison with Base'],
  ['measurements.md', 'measurements', 'Measurements'],
  ['SETUP.md', 'setup', 'Setup'],
  ['CEREMONY.md', 'ceremony', 'Setup ceremony'],
  ['RUNBOOK-PREPROD.md', 'runbook-preprod', 'Preprod runbook'],
  ['RUNBOOK-M0.md', 'runbook-m0', 'Mainnet canary runbook'],
  ['TEST-PLAN.md', 'test-plan', 'Test plan'],
  ['TEST-VECTORS.md', 'test-vectors', 'Test vectors'],
  ['PLAN-M0.md', 'plan-m0', 'M0 implementation plan'],
];

// Maps a docs/ path to its page slug, so links between the documents stay inside the site.
const slugByPath = new Map(pages.map(([file, slug]) => [file, slug]));

// Rewrites one markdown link target. Links to synced documents point at the site page.
// Other relative links point at the file on GitHub, because the site does not carry them.
function rewriteTarget(target, sourceFile) {
  if (/^(https?:|mailto:|#)/.test(target)) return target;
  const [path, anchor] = target.split('#');
  const fromDir = posix.dirname(sourceFile);
  const resolvedInDocs = posix.normalize(posix.join(fromDir, path));
  const slug = slugByPath.get(resolvedInDocs);
  if (slug) return `/reference/${slug}${anchor ? `#${anchor}` : ''}`;
  const repoPath = posix.normalize(posix.join('docs', resolvedInDocs));
  const kind = repoPath.endsWith('/') || !posix.extname(repoPath) ? 'tree' : 'blob';
  return `${github}/${kind}/main/${repoPath}`;
}

function convert(markdown, sourceFile) {
  return markdown.replace(/\]\(([^)\s]+)\)/g, (_, target) => `](${rewriteTarget(target, sourceFile)})`);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const [file, slug, title] of pages) {
  const source = readFileSync(join(docsDir, file), 'utf8');
  const body = convert(source, file);
  const note = `> Copied from [docs/${file}](${github}/blob/main/docs/${file}) at build time. Edit that file.\n\n`;
  writeFileSync(join(outDir, `${slug}.md`), `---\ntitle: ${JSON.stringify(title)}\n---\n\n${note}${body}`);
}

const meta = Object.fromEntries(pages.map(([, slug, title]) => [slug, title]));
writeFileSync(join(outDir, '_meta.js'), `export default ${JSON.stringify(meta, null, 2)};\n`);
console.log(`synced ${pages.length} reference pages into ${outDir}`);
