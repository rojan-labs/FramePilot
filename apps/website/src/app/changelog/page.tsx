import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo';
import { renderMarkdown } from '@/lib/markdown';
import { getChangelogEntries, formatChangelogDate } from '@/lib/changelog';
import { PageHeader } from '@/components/PageHeader';
import { Ruler } from '@/components/timeline/Ruler';

export const metadata: Metadata = pageMetadata({
  title: 'Changelog',
  path: '/changelog',
  description: 'Every FramePilot release, with what changed and why it matters.',
  keywords: [
    'FramePilot changelog',
    "what's new FramePilot",
    'FramePilot updates',
    'FramePilot releases',
  ],
});

/**
 * Releases as clips on a date track: the slate on the left carries the date,
 * the version, and the tags; the clip beside it carries what shipped.
 */
export default async function ChangelogPage() {
  const entries = getChangelogEntries();
  const rendered = await Promise.all(
    entries.map(async (entry) => ({ entry, html: await renderMarkdown(entry.content) })),
  );

  return (
    <section className="bg-canvas pb-24 pt-12 sm:pb-28 sm:pt-16">
      <div className="container-x">
        <PageHeader
          tc="REL 00:00"
          eyebrow="Changelog"
          title="What changed in FramePilot."
          description="What shipped, when it shipped, and what it changes for you."
          meta={
            <span className="tc tabular text-fg-muted">
              {String(rendered.length).padStart(2, '0')} releases
            </span>
          }
        />

        {rendered.length === 0 ? (
          <p className="mt-10 text-[13px] text-fg-tertiary">No updates yet.</p>
        ) : (
          <ol className="mt-2">
            {rendered.map(({ entry, html }) => (
              <li
                key={entry.slug}
                id={entry.version ?? entry.slug}
                className="grid scroll-mt-24 gap-6 py-10 md:grid-cols-[180px_minmax(0,700px)] md:gap-12"
              >
                <div className="md:sticky md:top-24 md:self-start">
                  <time dateTime={entry.date} className="tc block text-accent">
                    {formatChangelogDate(entry.date)}
                  </time>
                  {entry.version && (
                    <p className="tc tabular mt-1.5 text-fg-tertiary">v{entry.version}</p>
                  )}
                  {(entry.tags ?? []).length > 0 && (
                    <p className="tc mt-4 leading-4 text-fg-muted">{entry.tags?.join(' · ')}</p>
                  )}
                </div>
                <article className="min-w-0">
                  <div className="lane p-1.5">
                    <h2 className="rounded-[3px] bg-fg px-4 py-3 font-display text-[clamp(1.5rem,3vw,2.1rem)] font-semibold leading-[1.1] tracking-[-0.035em] text-canvas">
                      {entry.title}
                    </h2>
                  </div>
                  <p className="mt-4 max-w-2xl text-[14px] leading-6 text-fg-secondary">
                    {entry.summary}
                  </p>
                  <div className="prose-fp mt-6" dangerouslySetInnerHTML={{ __html: html }} />
                </article>
                <Ruler className="md:col-span-2" />
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
