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
              Pay for the editor. That&rsquo;s the whole model.
            </h1>
            <p className="mt-7 max-w-2xl text-[16px] leading-7 text-fg-secondary sm:text-[17px]">
              One desktop app, one subscription, monthly or annual. Nothing meters your exports.
            </p>
          </header>

          <div className="mt-14 sm:mt-20">
            <PricingCards plans={plans} />
          </div>

          <div className="mt-12 grid gap-6 border-t border-line pt-7 sm:grid-cols-3">
            <div>
              <p className="text-[13px] font-medium">Local-first</p>
              <p className="mt-1 text-[12px] leading-5 text-fg-tertiary">Your projects and footage never leave your computer.</p>
            </div>
            <div>
              <p className="text-[13px] font-medium">Freemius checkout</p>
              <p className="mt-1 text-[12px] leading-5 text-fg-tertiary">Freemius handles the payment and sends your license key.</p>
            </div>
            <div>
              <p className="text-[13px] font-medium">14-day guarantee</p>
              <p className="mt-1 text-[12px] leading-5 text-fg-tertiary">Use it on real work. Want your money back inside 14 days, just ask.</p>
            </div>
          </div>
        </div>
      </section>
      <Faq />
    </>
  );
}
