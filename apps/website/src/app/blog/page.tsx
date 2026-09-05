import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { pageMetadata } from '@/lib/seo';
import { getAllPosts, formatDate } from '@/lib/blog';

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
    <section className="bg-canvas pb-24 pt-20 sm:pb-32 sm:pt-28">
      <div className="container-x">
        <header className="max-w-4xl">
          <p className="eyebrow-tc mb-6">Notes</p>
          <h1 className="font-display text-[length:var(--text-h1)] leading-[var(--text-h1--line-height)] tracking-[var(--text-h1--letter-spacing)]">
            Building an editor an agent can operate.
          </h1>
          <p className="mt-7 max-w-2xl text-[16px] leading-7 text-fg-secondary sm:text-[17px]">
            Notes on editing workflows, agent design, and the engineering underneath.
          </p>
        </header>

        {posts.length === 0 ? (
          <p className="mt-16 border-t border-line pt-8 text-[13px] text-fg-tertiary">No posts yet.</p>
        ) : (
          <div className="mt-16 border-t border-line">
            {posts.map((post, index) => (
              <Link
                key={post.slug}
                href={`/blog/${post.slug}`}
                className="group grid gap-4 border-b border-line py-7 sm:grid-cols-[56px_minmax(0,1fr)_140px_auto] sm:items-start sm:gap-6 sm:py-8"
              >
                <span className="font-mono text-[9px] text-fg-muted">{String(index + 1).padStart(2, '0')}</span>
                <div className="max-w-3xl">
                  <h2 className="font-display text-[26px] font-semibold leading-[1.05] tracking-[-0.035em] sm:text-[32px]">{post.title}</h2>
                  <p className="mt-2 max-w-2xl text-[13.5px] leading-6 text-fg-secondary">{post.description}</p>
                </div>
                <div className="text-[11px] leading-5 text-fg-muted">
                  <time dateTime={post.date}>{formatDate(post.date)}</time>
                  <p>{post.readingMinutes} min read</p>
                </div>
                <ArrowRight size={15} className="mt-1 text-fg-muted transition-transform group-hover:translate-x-1 group-hover:text-fg" aria-hidden />
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
