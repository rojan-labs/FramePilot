import type { Metadata } from 'next';
import { site, SITE_URL } from './site';

interface PageSeo {
  title: string;
  description?: string;
  path?: string;
  /** Absolute or root-relative OG image; defaults to the site OG. */
  image?: string;
  keywords?: string[];
  type?: 'website' | 'article';
  publishedTime?: string;
  authors?: string[];
}

/** Build a full Next `Metadata` object for a page with sensible brand defaults. */
export function pageMetadata({
  title,
  description = site.description,
  path = '/',
  image,
  keywords,
  type = 'website',
  publishedTime,
  authors,
}: PageSeo): Metadata {
  const url = `${SITE_URL}${path === '/' ? '' : path}`;
  const ogImage = image ? (image.startsWith('http') ? image : `${SITE_URL}${image}`) : site.ogImage;
  const fullTitle = path === '/' ? `${site.name} — ${site.tagline}` : `${title} · ${site.name}`;

  return {
    /*
     * Absolute, so the root layout's `%s · FramePilot` template does not apply
     * on top of a title that already ends in the brand name — which is how
     * every route came to be served as "Pricing · FramePilot · FramePilot".
     */
    title: { absolute: fullTitle },
    description,
    keywords,
    alternates: { canonical: url },
    authors: authors?.map((name) => ({ name })),
    openGraph: {
      type,
      url,
      title: fullTitle,
      description,
      siteName: site.name,
      locale: site.locale,
      images: [{ url: ogImage, width: 1200, height: 630, alt: fullTitle }],
      ...(publishedTime ? { publishedTime } : {}),
    },
    twitter: {
      card: 'summary_large_image',
      title: fullTitle,
      description,
      images: [ogImage],
      creator: site.twitter,
    },
  };
}

/**
 * JSON-LD for the software product (rendered once, in the root layout). The
 * offer prices are passed in from the real plan data so the structured data
 * never drifts from what the pricing page shows.
 */
export function softwareApplicationJsonLd(prices?: { monthly: number; annual: number }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: site.name,
    applicationCategory: 'MultimediaApplication',
    operatingSystem: 'macOS, Windows, Linux',
    description: site.description,
    url: SITE_URL,
    offers: prices
      ? {
          '@type': 'AggregateOffer',
          priceCurrency: 'USD',
          lowPrice: prices.annual,
          highPrice: prices.monthly * 12,
          offerCount: 2,
          offers: [
            {
              '@type': 'Offer',
              name: 'Monthly',
              price: prices.monthly,
              priceCurrency: 'USD',
              category: 'subscription',
            },
            {
              '@type': 'Offer',
              name: 'Annual',
              price: prices.annual,
              priceCurrency: 'USD',
              category: 'subscription',
            },
          ],
        }
      : { '@type': 'Offer', category: 'paid', priceCurrency: 'USD' },
    author: { '@type': 'Person', name: site.author },
  };
}

/** JSON-LD for an FAQ block (rich results). */
export function faqJsonLd(items: { q: string; a: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map(({ q, a }) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  };
}

/** JSON-LD for a blog article. */
export function articleJsonLd(opts: {
  title: string;
  description: string;
  path: string;
  date: string;
  author: string;
  image?: string;
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: opts.title,
    description: opts.description,
    datePublished: opts.date,
    dateModified: opts.date,
    author: { '@type': 'Person', name: opts.author },
    publisher: {
      '@type': 'Organization',
      name: site.name,
      logo: { '@type': 'ImageObject', url: `${SITE_URL}/icon-512.png` },
    },
    mainEntityOfPage: `${SITE_URL}${opts.path}`,
    image: opts.image ? `${SITE_URL}${opts.image}` : site.ogImage,
  };
}
