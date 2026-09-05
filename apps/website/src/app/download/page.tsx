import type { Metadata } from 'next';
import Link from 'next/link';
import { pageMetadata } from '@/lib/seo';
import { DownloadOptions } from '@/components/DownloadOptions';

export const metadata: Metadata = pageMetadata({
  title: 'Download',
  path: '/download',
  description:
    'Download the latest FramePilot desktop build for macOS, Windows, or Linux. Install the local-first AI-native video editor and activate it with your license key.',
  keywords: ['download FramePilot', 'AI video editor download', 'video editor mac windows linux'],
});

export default function DownloadPage() {
  return (
    <section className="bg-canvas pb-24 pt-20 sm:pb-32 sm:pt-28">
      <div className="container-x">
        <header className="max-w-4xl">
          <p className="eyebrow-tc mb-6">Download</p>
          <h1 className="font-display text-[length:var(--text-h1)] leading-[var(--text-h1--line-height)] tracking-[var(--text-h1--letter-spacing)]">
            FramePilot on your desktop.
          </h1>
          <p className="mt-7 max-w-2xl text-[16px] leading-7 text-fg-secondary sm:text-[17px]">
            Grab the latest pre-release build for your platform. It runs locally, and your footage stays where it already is.
          </p>
        </header>

        <div className="mt-14 sm:mt-20">
          <DownloadOptions />
        </div>

        <div className="mt-10 flex flex-col gap-4 border-t border-line pt-6 text-[12px] text-fg-tertiary sm:flex-row sm:items-center sm:justify-between">
          <p>You&rsquo;ll need your license key to activate.</p>
          <div className="flex gap-5">
            <Link href="/pricing" className="font-medium text-fg hover:text-accent">Pricing</Link>
            <Link href="/changelog" className="font-medium text-fg hover:text-accent">Changelog</Link>
          </div>
        </div>
      </div>
    </section>
  );
}
