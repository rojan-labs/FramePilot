import type { Metadata } from 'next';
import Link from 'next/link';
import { pageMetadata } from '@/lib/seo';
import { DownloadOptions } from '@/components/DownloadOptions';
import { PageHeader } from '@/components/PageHeader';
import { OutPoint, Ruler } from '@/components/timeline/Ruler';

export const metadata: Metadata = pageMetadata({
  title: 'Download',
  path: '/download',
  description:
    'Download the latest FramePilot desktop build for macOS, Windows, or Linux. Install the local-first AI-native video editor and activate it with your license key.',
  keywords: ['download FramePilot', 'AI video editor download', 'video editor mac windows linux'],
});

export default function DownloadPage() {
  return (
    <section className="bg-canvas pb-24 pt-12 sm:pb-28 sm:pt-16">
      <div className="container-x">
        <PageHeader
          tc="D 00:00"
          eyebrow="Download"
          title="FramePilot on your desktop."
          description="Grab the latest pre-release build for your platform. It runs locally, and your footage stays where it already is."
        />

        <div className="mt-10 sm:mt-12">
          <DownloadOptions />
        </div>

        <Ruler className="mt-10" />
        <div className="flex flex-col gap-4 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-center gap-2.5">
            <OutPoint />
            <span className="tc text-fg-tertiary">
              You&rsquo;ll need your license key to activate
            </span>
          </p>
          <div className="flex gap-6">
            <Link href="/pricing" className="text-[12.5px] font-medium text-fg hover:text-accent">
              Pricing
            </Link>
            <Link href="/changelog" className="text-[12.5px] font-medium text-fg hover:text-accent">
              Changelog
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
