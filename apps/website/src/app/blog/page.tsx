import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { pageMetadata } from '@/lib/seo';
import { getAllPosts, formatDate } from '@/lib/blog';
import { PageHeader } from '@/components/PageHeader';
import { Ruler } from '@/components/timeline/Ruler';

export const metadata: Metadata = pageMetadata({
  title: 'Blog',
  path: '/blog',
  description:
    'Guides and deep dives on AI-assisted video editing, timeline automation, captions, and agent workflows from the FramePilot team.',
  keywords: ['AI video editing blog', 'video editing guides', 'FramePilot blog'],
});

export default function BlogIndexPage() {
  const posts = getAllPosts();

  return (
    <section className="bg-canvas pb-24 pt-12 sm:pb-28 sm:pt-16">
      <div className="container-x">
        <PageHeader
          tc="B 00:00"
          eyebrow="Notes"
          title="Building an editor an agent can operate."
          description="Notes on editing workflows, agent design, and the engineering underneath."
          meta={
            <span className="tc tabular text-fg-muted">
              {String(posts.length).padStart(2, '0')} entries
            </span>
          }
        />

        {posts.length === 0 ? (
          <p className="mt-10 text-[13px] text-fg-tertiary">No posts yet.</p>
        ) : (
          <ol className="mt-2">
            {posts.map((post, index) => (
              <li key={post.slug}>
                <Link
                  href={`/blog/${post.slug}`}
                  className="group grid gap-3 py-7 sm:grid-cols-[52px_minmax(0,1fr)_150px_auto] sm:items-start sm:gap-6 sm:py-8"
                >
                  <span className="tc tabular text-fg-muted">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div className="max-w-3xl">
                    <h2 className="font-display text-[25px] font-semibold leading-[1.05] tracking-[-0.035em] transition-colors group-hover:text-accent sm:text-[30px]">
                      {post.title}
                    </h2>
                    <p className="mt-2.5 max-w-2xl text-[13.5px] leading-6 text-fg-secondary">
                      {post.description}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <time dateTime={post.date} className="tc block text-fg-tertiary">
                      {formatDate(post.date)}
                    </time>
                    <p className="tc tabular text-fg-muted">
                      {String(post.readingMinutes).padStart(2, '0')}:00 read
                    </p>
                  </div>
                  <ArrowRight
                    size={15}
                    className="mt-1 text-fg-muted transition-transform group-hover:translate-x-1 group-hover:text-accent"
                    aria-hidden
                  />
                </Link>
                <Ruler />
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
