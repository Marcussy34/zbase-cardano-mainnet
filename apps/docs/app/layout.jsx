import { Footer, Layout, Navbar } from 'nextra-theme-docs';
import { Head } from 'nextra/components';
import { getPageMap } from 'nextra/page-map';
import 'nextra-theme-docs/style.css';

const repository = 'https://github.com/Marcussy34/zbase-cardano-mainnet';

export const metadata = {
  title: { default: 'zBase Cardano', template: '%s | zBase Cardano' },
  description: 'How zBase Cardano works: private x402 payments for AI agents on Cardano.',
};

const navbar = <Navbar logo={<b>zBase Cardano</b>} projectLink={repository} />;
const footer = <Footer>MIT 2026 Marcus Tan. Built on Preprod. Not audited.</Footer>;

export default async function RootLayout({ children }) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <Head />
      <body>
        <Layout
          navbar={navbar}
          pageMap={await getPageMap()}
          docsRepositoryBase={`${repository}/tree/main/apps/docs`}
          footer={footer}
          sidebar={{ defaultMenuCollapseLevel: 1 }}
        >
          {children}
        </Layout>
      </body>
    </html>
  );
}
