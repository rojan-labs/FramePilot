import type { Metadata } from 'next';
import { Check, Download, KeyRound, Mail } from 'lucide-react';
import { pageMetadata } from '@/lib/seo';
import { DownloadButton } from '@/components/DownloadButton';

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
    title: 'Check your inbox',
    desc: 'Your license key is on its way from Freemius. It also appears on the receipt page.',
  },
  {
    icon: Download,
    title: 'Download FramePilot',
    desc: 'Grab the app for your platform below: macOS, Windows, or Linux.',
  },
  {
    icon: KeyRound,
    title: 'Activate on launch',
    desc: 'Open FramePilot, paste your license key when prompted, and start editing.',
  },
];

export default function ThankYouPage() {
  return (
    <section className="relative overflow-hidden py-24 sm:py-32">
      <div className="container-x max-w-2xl text-center">
        <span className="mx-auto grid size-14 place-items-center rounded-full bg-success/15 text-success ring-1 ring-inset ring-success/25">
          <Check size={28} />
        </span>
        <h1 className="mt-6 text-[length:var(--text-h1)] font-semibold leading-tight tracking-tight max-sm:text-[2.25rem]">
          You&rsquo;re in. Welcome to FramePilot.
        </h1>
        <p className="mx-auto mt-4 max-w-md text-[17px] leading-relaxed text-fg-secondary">
          Thanks for subscribing. Here&rsquo;s how to get editing in under a minute.
        </p>

        <ol className="mx-auto mt-12 max-w-md space-y-3 text-left">
          {STEPS.map((s, i) => (
            <li
              key={s.title}
              className="flex items-start gap-4 rounded-xl border border-line bg-surface/50 p-5"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent ring-1 ring-inset ring-accent/20">
                <s.icon size={18} />
              </span>
              <div>
                <h2 className="text-[15px] font-semibold">
                  {i + 1}. {s.title}
                </h2>
                <p className="mt-1 text-[13.5px] leading-relaxed text-fg-secondary">{s.desc}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-10 flex justify-center">
          <DownloadButton size="lg" />
        </div>
      </div>
    </section>
  );
}
