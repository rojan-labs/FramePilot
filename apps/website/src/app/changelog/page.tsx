import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo';
import { renderMarkdown } from '@/lib/markdown';
import { getChangelogEntries, formatChangelogDate } from '@/lib/changelog';

export const metadata: Metadata = pageMetadata({
  title: 'Changelog',
  path: '/changelog',
  description: 'Every FramePilot release, with what changed and why it matters.',
  keywords: ['FramePilot changelog', "what's new FramePilot", 'FramePilot updates', 'FramePilot releases'],
});

export default async function ChangelogPage() {
  const entries = getChangelogEntries();
  const rendered = await Promise.all(entries.map(async (entry) => ({ entry, html: await renderMarkdown(entry.content) })));

  return (
    <section className="bg-white pb-24 pt-20 sm:pb-32 sm:pt-28">
      <div className="container-x">
        <header className="max-w-4xl">
          <p className="eyebrow-tc mb-6">Changelog</p>
          <h1 className="font-display text-[length:var(--text-h1)] leading-[var(--text-h1--line-height)] tracking-[var(--text-h1--letter-spacing)]">
            What changed in FramePilot.
          </h1>
          <p className="mt-7 max-w-xl text-[16px] leading-7 text-fg-secondary">What shipped, when it shipped, and what it changes for you.</p>
        </header>

        {rendered.length === 0 ? (
          <p className="mt-16 border-t border-line pt-8 text-[13px] text-fg-tertiary">No updates yet.</p>
        ) : (
          <ol className="mt-16 border-t border-line">
            {rendered.map(({ entry, html }) => (
              <li key={entry.slug} id={entry.version ?? entry.slug} className="grid scroll-mt-24 gap-8 border-b border-line py-10 md:grid-cols-[180px_minmax(0,700px)] md:gap-12 sm:py-12">
                <div className="text-[11px] leading-5 text-fg-muted md:sticky md:top-24 md:self-start">
                  <time dateTime={entry.date}>{formatChangelogDate(entry.date)}</time>
                  {entry.version && <p className="font-mono">v{entry.version}</p>}
                  {(entry.tags ?? []).length > 0 && <p className="mt-3 text-[9px] uppercase tracking-[0.11em] text-fg-tertiary">{entry.tags?.join(' · ')}</p>}
                </div>
                <article>
                  <h2 className="font-display text-[clamp(2rem,4vw,3.2rem)] font-semibold leading-[1] tracking-[-0.04em]">{entry.title}</h2>
                  <p className="mt-3 max-w-2xl text-[14px] leading-6 text-fg-secondary">{entry.summary}</p>
                  <div className="prose-fp mt-7" dangerouslySetInnerHTML={{ __html: html }} />
                </article>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
