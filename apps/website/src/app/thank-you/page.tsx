import type { Metadata } from 'next';
import { Download, KeyRound, Mail } from 'lucide-react';
import { pageMetadata } from '@/lib/seo';
import { DownloadButton } from '@/components/DownloadButton';
import { PageHeader } from '@/components/PageHeader';
import { Ruler } from '@/components/timeline/Ruler';

export const metadata: Metadata = {
  ...pageMetadata({
    title: 'Thank you',
    path: '/thank-you',
    description: 'Your FramePilot license is ready.',
  }),
  robots: { index: false, follow: false },
};

const STEPS = [
  {
    icon: Mail,
    slot: '01',
    title: 'Check your inbox',
    desc: 'Your license key is on its way from Freemius. It also appears on the receipt page.',
  },
  {
    icon: Download,
    slot: '02',
    title: 'Download FramePilot',
    desc: 'Grab the app for your platform: macOS, Windows, or Linux.',
  },
  {
    icon: KeyRound,
    slot: '03',
    title: 'Activate on launch',
    desc: 'Open FramePilot, paste your license key when prompted, and start editing.',
  },
];

export default function ThankYouPage() {
  return (
    <section className="container-x max-w-[820px] py-14 sm:py-20">
      <PageHeader
        tc="00:00"
        eyebrow="In point"
        size="md"
        title={
          <>
            You&rsquo;re in.
            <br />
            Welcome to FramePilot.
          </>
        }
        description="Thanks for subscribing. Here's how to get editing in under a minute."
      />

      {/* Three clips on one track: the whole setup, end to end. */}
      <ol className="mt-10">
        {STEPS.map((step) => (
          <li key={step.title}>
            <div className="lane p-1.5">
              <div className="flex items-start gap-4 rounded-[3px] px-4 py-4">
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-[3px] bg-fg text-canvas">
                  <step.icon size={15} aria-hidden />
                </span>
                <div>
                  <h2 className="flex items-center gap-2.5 text-[15px] font-semibold text-fg">
                    <span className="tc tabular text-fg-muted">{step.slot}</span>
                    {step.title}
                  </h2>
                  <p className="mt-1.5 text-[13.5px] leading-6 text-fg-secondary">{step.desc}</p>
                </div>
              </div>
            </div>
            <Ruler />
          </li>
        ))}
      </ol>

      <div className="mt-8">
        <DownloadButton size="lg" />
      </div>
    </section>
  );
}
