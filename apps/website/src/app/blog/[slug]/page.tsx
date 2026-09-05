import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { getPost, getPostSlugs, formatDate } from '@/lib/blog';
import { renderMarkdown } from '@/lib/markdown';
import { pageMetadata, articleJsonLd } from '@/lib/seo';
import { JsonLd } from '@/components/JsonLd';
import { DownloadButton } from '@/components/DownloadButton';
import { PageHeader } from '@/components/PageHeader';
import { OutPoint, Ruler } from '@/components/timeline/Ruler';

export function generateStaticParams() {
  return getPostSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) return {};
  return pageMetadata({
    title: post.title,
    description: post.description,
    path: `/blog/${post.slug}`,
    type: 'article',
    keywords: post.keywords,
    image: post.cover,
    publishedTime: post.date,
    authors: [post.author],
  });
}

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) notFound();
  const html = await renderMarkdown(post.content);

  return (
    <article className="bg-canvas pb-24 pt-10 sm:pb-28 sm:pt-14">
      <JsonLd
        data={articleJsonLd({
          title: post.title,
          description: post.description,
          path: `/blog/${post.slug}`,
          date: post.date,
          author: post.author,
          image: post.cover,
        })}
      />

      <div className="container-x">
        <Link
          href="/blog"
          className="inline-flex items-center gap-1.5 text-[12.5px] text-fg-tertiary transition-colors hover:text-fg"
        >
          <ArrowLeft size={13} aria-hidden /> All notes
        </Link>

        <div className="mt-8">
          <PageHeader
            tc={formatDate(post.date)}
            eyebrow="Note"
            size="md"
            title={post.title}
            description={post.description}
            meta={
              /* Reading time as a duration, because that is what it is. */
              <span className="tc tabular text-fg-muted">
                {String(post.readingMinutes).padStart(2, '0')}:00 read
              </span>
            }
          />
        </div>

        <div className="mt-10 grid gap-12 lg:grid-cols-[170px_minmax(0,700px)] lg:gap-14">
          <aside className="lg:sticky lg:top-24 lg:self-start">
            <p className="tc text-fg-muted">Written by</p>
            <p className="mt-2 text-[13px] font-medium text-fg-secondary">{post.author}</p>
          </aside>
          <div className="prose-fp min-w-0" dangerouslySetInnerHTML={{ __html: html }} />
        </div>

        <div className="mt-20 max-w-[880px] lg:ml-[224px]">
          <Ruler />
          <p className="mt-4 flex items-center gap-2.5">
            <OutPoint />
            <span className="tc text-accent">Out</span>
          </p>
          <p className="mt-4 font-display text-[27px] font-semibold tracking-[-0.035em]">
            Try it on a real timeline.
          </p>
          <p className="mt-2.5 max-w-xl text-[13.5px] leading-6 text-fg-secondary">
            Download FramePilot and use the workflow described in this article inside the desktop
            editor.
          </p>
          <div className="mt-5">
            <DownloadButton size="md" />
          </div>
        </div>
      </div>
    </article>
  );
}
