import { fileURLToPath } from 'node:url';
import nextra from 'nextra';

// The site is exported as static files. On GitHub Pages it lives under the repository name,
// so the workflow sets NEXT_PUBLIC_BASE_PATH to "/zx402". Locally it stays empty.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

const withNextra = nextra({
  // Code blocks hold hashes and addresses that nobody searches for.
  search: { codeblocks: false },
});

export default withNextra({
  output: 'export',
  images: { unoptimized: true },
  basePath,
  ...(basePath ? { assetPrefix: basePath } : {}),
  // Every page becomes a folder with an index.html, which static hosts serve without rewrites.
  trailingSlash: true,
  reactStrictMode: true,
  turbopack: {
    // The monorepo root, so Next.js does not guess it from lockfiles above the repository.
    root: fileURLToPath(new URL('../..', import.meta.url)),
    resolveAlias: {
      'next-mdx-import-source-file': './mdx-components.jsx',
    },
  },
});
