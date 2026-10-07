import { Footer, Layout, Navbar } from 'nextra-theme-docs';
import { Head } from 'nextra/components';
import { getPageMap } from 'nextra/page-map';
import Mark from '../components/Mark';
import 'nextra-theme-docs/style.css';
import './theme.css';

const repository = 'https://github.com/Marcussy34/zx402';

export const metadata = {
  title: { default: 'zx402', template: '%s | zx402' },
  description: 'How zx402 works: private x402 payments for AI agents on Cardano.',
  icons: { icon: `${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/images/zx402-mark.svg` },
};

const navbar = <Navbar logo={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Mark /><b>zx402</b></span>} projectLink={repository} />;
const footer = <Footer>MIT 2026 Marcus Tan. Built on Preprod. Not audited.</Footer>;

export default async function RootLayout({ children }) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      {/* A neutral primary color: the site is black and white, with gray for links and the active items. */}
      <Head color={{ hue: 0, saturation: 0, lightness: { light: 35, dark: 80 } }} />
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
