import { fileURLToPath } from 'node:url';
import nextra from 'nextra';

// The site is exported as static files and served at the root of docs.zx402.org by Vercel.

const withNextra = nextra({
  // Code blocks hold hashes and addresses that nobody searches for.
  search: { codeblocks: false },
});

export default withNextra({
  output: 'export',
  images: { unoptimized: true },
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
