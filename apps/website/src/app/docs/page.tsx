import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { pageMetadata } from '@/lib/seo';
import { getDocNav } from '@/lib/docs';
import { site } from '@/lib/site';
import { PageHeader } from '@/components/PageHeader';
import { Ruler } from '@/components/timeline/Ruler';

export const metadata: Metadata = pageMetadata({
  title: 'Docs',
  path: '/docs',
  description:
    'FramePilot documentation for installation, licensing, the editing workflow, AI agent tools, MCP, and deterministic rendering.',
});

export default function DocsHome() {
  const nav = getDocNav();
  const first = nav[0]?.items[0];

  return (
    <div className="pb-10">
      <PageHeader
        tc="DOC 00:00"
        eyebrow="Documentation"
        size="md"
        title="Learn FramePilot."
        description="Installation, timeline concepts, agent workflows, MCP, licensing, and the validated render path."
      >
        {first && (
          <Link
            href={`/docs/${first.slug}`}
            className="mt-6 inline-flex items-center gap-2 text-[12.5px] font-semibold text-fg underline decoration-accent underline-offset-4"
          >
            Start with {first.title}
            <ArrowRight size={13} aria-hidden />
          </Link>
        )}
      </PageHeader>

      <div className="mt-10 space-y-10">
        {nav.map((group, groupIndex) => (
          <section key={group.category}>
            <p className="tc flex items-center gap-2.5 text-fg-muted">
              <span className="tabular">{`V${groupIndex + 1}`}</span>
              {group.category}
            </p>
            <div className="mt-3">
              {group.items.map((item) => (
                <div key={item.slug}>
                  <Ruler />
                  <Link
                    href={`/docs/${item.slug}`}
                    className="group grid gap-1.5 py-4 sm:grid-cols-[200px_minmax(0,1fr)_auto] sm:items-center sm:gap-6"
                  >
                    <h2 className="text-[13.5px] font-medium text-fg transition-colors group-hover:text-accent">
                      {item.title}
                    </h2>
                    <p className="text-[12.5px] leading-5 text-fg-tertiary">{item.description}</p>
                    <ArrowRight
                      size={13}
                      className="text-fg-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent"
                      aria-hidden
                    />
                  </Link>
                </div>
              ))}
              <Ruler />
            </div>
          </section>
        ))}
      </div>

      <Ruler className="mt-12" />
      <p className="pt-4 text-[12.5px] text-fg-tertiary">
        Can&rsquo;t find something?{' '}
        <a
          href={`mailto:${site.email}`}
          className="font-medium text-fg underline decoration-accent underline-offset-4"
        >
          {site.email}
        </a>
      </p>
    </div>
  );
}
