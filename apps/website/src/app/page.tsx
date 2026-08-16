import type { Metadata } from 'next';
import { pageMetadata, faqJsonLd } from '@/lib/seo';
import { JsonLd } from '@/components/JsonLd';
import { FAQ } from '@/content/faq';
import { Hero } from '@/components/sections/Hero';
import { Features } from '@/components/sections/Features';
import { BeforeAfter } from '@/components/sections/BeforeAfter';
import { PricingPreview } from '@/components/sections/PricingPreview';
import { Faq } from '@/components/sections/Faq';
import { FinalCta } from '@/components/sections/FinalCta';
import { getPlans } from '@/lib/pricing';

export const metadata: Metadata = pageMetadata({
  title: 'Home',
  path: '/',
  keywords: [
    'AI video editor',
    'AI video editing app',
    'turn recording into reel',
    'auto captions for video',
    'remove silence from video',
    'AI video editor for creators',
    'edit video with AI',
  ],
});

export default function HomePage() {
  const pro = getPlans().find((p) => p.id === 'pro') ?? null;
  return (
    <>
      <JsonLd data={faqJsonLd(FAQ)} />
      <Hero />
      <Features />
      <BeforeAfter />
      <PricingPreview plan={pro} />
      <Faq />
      <FinalCta />
    </>
  );
}
