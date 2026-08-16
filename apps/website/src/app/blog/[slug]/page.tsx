import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { getPost, getPostSlugs, formatDate } from '@/lib/blog';
import { renderMarkdown } from '@/lib/markdown';
import { pageMetadata, articleJsonLd } from '@/lib/seo';
import { JsonLd } from '@/components/JsonLd';
import { DownloadButton } from '@/components/DownloadButton';

export function generateStaticParams() {
  return getPostSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
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
    <article className="bg-white pb-24 pt-16 sm:pb-32 sm:pt-24">
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
        <Link href="/blog" className="inline-flex items-center gap-1.5 text-[12px] text-fg-tertiary hover:text-fg">
          <ArrowLeft size={13} /> All notes
        </Link>

        <header className="mt-10 max-w-4xl">
          <p className="font-mono text-[9px] uppercase tracking-[0.13em] text-fg-muted">
            {formatDate(post.date)} · {post.readingMinutes} min read
          </p>
          <h1 className="mt-5 font-display text-[clamp(3rem,7vw,6.6rem)] font-semibold leading-[0.92] tracking-[-0.055em]">
            {post.title}
          </h1>
          <p className="mt-6 max-w-2xl text-[17px] leading-8 text-fg-secondary">{post.description}</p>
        </header>

        <div className="mt-14 grid gap-12 border-t border-line pt-10 lg:grid-cols-[170px_minmax(0,700px)] lg:gap-14">
          <aside className="text-[11px] leading-5 text-fg-muted lg:sticky lg:top-24 lg:self-start">
            <p>Written by</p>
            <p className="mt-1 font-medium text-fg-secondary">{post.author}</p>
          </aside>
          <div className="prose-fp" dangerouslySetInnerHTML={{ __html: html }} />
        </div>

        <div className="mt-20 max-w-[880px] border-t border-line pt-8 lg:ml-[224px]">
          <p className="font-display text-[28px] font-semibold tracking-[-0.035em]">Try it on a real timeline.</p>
          <p className="mt-2 max-w-xl text-[13.5px] leading-6 text-fg-secondary">
            Download FramePilot and use the workflow described in this article inside the desktop editor.
          </p>
          <div className="mt-5"><DownloadButton size="md" /></div>
        </div>
      </div>
    </article>
  );
}
