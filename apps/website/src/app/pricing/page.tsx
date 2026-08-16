import type { Metadata } from 'next';
import { pageMetadata, faqJsonLd } from '@/lib/seo';
import { JsonLd } from '@/components/JsonLd';
import { getPlans } from '@/lib/pricing';
import { PricingCards } from '@/components/PricingCards';
import { Faq } from '@/components/sections/Faq';
import { FAQ } from '@/content/faq';

export const metadata: Metadata = pageMetadata({
  title: 'Pricing',
  path: '/pricing',
  description:
    'Simple pricing for FramePilot, the local-first AI-native desktop video editor. Choose monthly or annual billing and activate the desktop app with your license key.',
  keywords: ['FramePilot pricing', 'AI video editor pricing', 'desktop video editor subscription'],
});

export default function PricingPage() {
  const plans = getPlans();

  return (
    <>
      <JsonLd data={faqJsonLd(FAQ)} />
      <section className="bg-white pb-20 pt-20 sm:pb-28 sm:pt-28">
        <div className="container-x">
          <header className="max-w-4xl">
            <p className="eyebrow-tc mb-6">Pricing</p>
            <h1 className="font-display text-[length:var(--text-h1)] leading-[var(--text-h1--line-height)] tracking-[var(--text-h1--letter-spacing)]">
              Pay for the editor. Keep the workflow simple.
            </h1>
            <p className="mt-7 max-w-2xl text-[16px] leading-7 text-fg-secondary sm:text-[17px]">
              FramePilot is one desktop editing product. Choose monthly or annual billing. There is no per-export meter.
            </p>
          </header>

          <div className="mt-14 sm:mt-20">
            <PricingCards plans={plans} />
          </div>

          <div className="mt-12 grid gap-6 border-t border-line pt-7 sm:grid-cols-3">
            <div>
              <p className="text-[13px] font-medium">Local-first</p>
              <p className="mt-1 text-[12px] leading-5 text-fg-tertiary">Projects and source media remain on your machine.</p>
            </div>
            <div>
              <p className="text-[13px] font-medium">Freemius checkout</p>
              <p className="mt-1 text-[12px] leading-5 text-fg-tertiary">Secure payment and license activation through the existing licensing flow.</p>
            </div>
            <div>
              <p className="text-[13px] font-medium">14-day guarantee</p>
              <p className="mt-1 text-[12px] leading-5 text-fg-tertiary">Try the product with your workflow and request a refund within the guarantee window.</p>
            </div>
          </div>
        </div>
      </section>
      <Faq />
    </>
  );
}
