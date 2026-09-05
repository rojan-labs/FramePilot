import type { Metadata } from 'next';
import { pageMetadata, faqJsonLd } from '@/lib/seo';
import { JsonLd } from '@/components/JsonLd';
import { getPlans } from '@/lib/pricing';
import { PricingCards } from '@/components/PricingCards';
import { PageHeader } from '@/components/PageHeader';
import { Ruler } from '@/components/timeline/Ruler';
import { Faq } from '@/components/sections/Faq';
import { FAQ } from '@/content/faq';

export const metadata: Metadata = pageMetadata({
  title: 'Pricing',
  path: '/pricing',
  description:
    'Simple pricing for FramePilot, the local-first AI-native desktop video editor. Choose monthly or annual billing and activate the desktop app with your license key.',
  keywords: ['FramePilot pricing', 'AI video editor pricing', 'desktop video editor subscription'],
});

const TERMS = [
  ['Local-first', 'Editing and rendering happen on your machine. Hosted AI runs only if you set it up.'],
  ['Freemius checkout', 'Freemius handles the payment and sends your license key.'],
  ['14-day guarantee', 'Use it on real work. Want your money back inside 14 days, just ask.'],
] as const;

export default function PricingPage() {
  const plans = getPlans();

  return (
    <>
      <JsonLd data={faqJsonLd(FAQ)} />
      <section className="bg-canvas pb-20 pt-12 sm:pb-24 sm:pt-16">
        <div className="container-x">
          <PageHeader
            tc="P 00:00"
            eyebrow="Pricing"
            title={
              <>
                Pay for the editor.
                <br />
                That&rsquo;s the whole model.
              </>
            }
            description="One desktop app, one subscription, monthly or annual. Nothing meters your exports. FramePilot is pre-release software and still changing quickly, which is worth knowing before you subscribe."
          />

          <div className="mt-10 sm:mt-12">
            <PricingCards plans={plans} />
          </div>

          <dl className="mt-12 grid gap-x-10 sm:grid-cols-3">
            {TERMS.map(([term, value]) => (
              <div key={term}>
                <Ruler />
                <div className="pt-3">
                  <dt className="tc text-fg-muted">{term}</dt>
                  <dd className="mt-2 text-[12.5px] leading-5 text-fg-secondary">{value}</dd>
                </div>
              </div>
            ))}
          </dl>
        </div>
      </section>
      <Faq />
    </>
  );
}
