import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';
import { site, SITE_URL } from '@/lib/site';
import { softwareApplicationJsonLd } from '@/lib/seo';
import { getPlans } from '@/lib/pricing';
import { JsonLd } from '@/components/JsonLd';
import { Nav } from '@/components/Nav';
import { Footer } from '@/components/Footer';
import { IntroProvider } from '@/components/intro/IntroProvider';
import { INTRO_BOOT_SCRIPT } from '@/lib/intro-machine';

const bricolage = localFont({
  src: '../fonts/BricolageGrotesque-Variable.woff2',
  variable: '--font-bricolage',
  weight: '200 800',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${site.name} · ${site.tagline}`,
    template: `%s · ${site.name}`,
  },
  description: site.description,
  applicationName: site.name,
  manifest: '/site.webmanifest',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/icon.svg', type: 'image/svg+xml' },
    ],
    apple: '/apple-touch-icon.png',
  },
  openGraph: {
    type: 'website',
    siteName: site.name,
    url: SITE_URL,
    locale: site.locale,
    images: [{ url: site.ogImage, width: 1200, height: 630, alt: site.name }],
  },
  twitter: { card: 'summary_large_image', site: site.twitter, creator: site.twitter },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: '#fbfaf7',
  colorScheme: 'light',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const pro = getPlans().find((plan) => plan.id === 'pro');

  return (
    <html
      lang="en"
      /* The boot script stamps `data-intro` before React hydrates. */
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable} ${bricolage.variable}`}
    >
      <head>
        {/*
          Runs before first paint. It marks the document only when the intro is
          really about to play, so CSS can hide the navbar's logo mark for
          exactly that case and nothing flashes into position.
        */}
        <script dangerouslySetInnerHTML={{ __html: INTRO_BOOT_SCRIPT }} />
        {/*
          Without JavaScript, framer-motion's server-rendered `initial` styles
          would leave section content hidden forever. Force every reveal open.
        */}
        <noscript>
          <style>{
            '[data-clip-reveal]{opacity:1!important;transform:none!important;clip-path:none!important}'
          }</style>
        </noscript>
      </head>
      <body className="min-h-screen bg-canvas text-fg antialiased">
        <JsonLd data={softwareApplicationJsonLd(pro?.price ?? undefined)} />
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-accent focus:px-4 focus:py-2 focus:text-[13px] focus:font-medium focus:text-accent-ink"
        >
          Skip to content
        </a>
        <IntroProvider>
          <Nav />
          <main id="main">{children}</main>
          <Footer />
        </IntroProvider>
      </body>
    </html>
  );
}
