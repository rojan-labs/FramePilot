import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { pageMetadata } from '@/lib/seo';
import { getDocNav } from '@/lib/docs';
import { site } from '@/lib/site';

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
      <header className="max-w-3xl border-b border-line pb-10 sm:pb-12">
        <p className="eyebrow-tc mb-5">Documentation</p>
        <h1 className="font-display text-[clamp(3rem,6vw,5.6rem)] font-semibold leading-[0.92] tracking-[-0.055em]">
          Learn FramePilot.
        </h1>
        <p className="mt-5 max-w-2xl text-[15px] leading-7 text-fg-secondary">
          Installation, timeline concepts, agent workflows, MCP, licensing, and the validated render path.
        </p>
        {first && (
          <Link href={`/docs/${first.slug}`} className="mt-5 inline-flex items-center gap-2 text-[12.5px] font-medium text-fg">
            Start with {first.title}
            <ArrowRight size={13} aria-hidden />
          </Link>
        )}
      </header>

      <div className="mt-10 space-y-10">
        {nav.map((group) => (
          <section key={group.category}>
            <h2 className="font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-fg-muted">{group.category}</h2>
            <div className="mt-3 border-t border-line">
              {group.items.map((item) => (
                <Link
                  key={item.slug}
                  href={`/docs/${item.slug}`}
                  className="group grid gap-2 border-b border-line py-4 sm:grid-cols-[190px_minmax(0,1fr)_auto] sm:items-center sm:gap-6"
                >
                  <h3 className="text-[13.5px] font-medium text-fg">{item.title}</h3>
                  <p className="text-[12.5px] leading-5 text-fg-tertiary">{item.description}</p>
                  <ArrowRight size={13} className="text-fg-muted transition-transform group-hover:translate-x-0.5 group-hover:text-fg" aria-hidden />
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>

      <p className="mt-12 border-t border-line pt-5 text-[12px] text-fg-tertiary">
        Can&rsquo;t find something? <a href={`mailto:${site.email}`} className="font-medium text-fg hover:text-accent">{site.email}</a>
      </p>
    </div>
  );
}
