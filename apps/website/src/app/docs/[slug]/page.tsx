import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { getDoc, getDocSlugs, getDocNeighbors } from '@/lib/docs';
import { renderMarkdown, extractToc } from '@/lib/markdown';
import { pageMetadata } from '@/lib/seo';
import { TocRail } from '@/components/docs/TocRail';

export function generateStaticParams() {
  return getDocSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const doc = getDoc(slug);
  if (!doc) return {};
  return pageMetadata({ title: doc.title, description: doc.description, path: `/docs/${doc.slug}` });
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = getDoc(slug);
  if (!doc) notFound();

  const html = await renderMarkdown(doc.content);
  const toc = extractToc(doc.content);
  const { prev, next } = getDocNeighbors(slug);

  return (
    <div className="grid gap-10 xl:grid-cols-[minmax(0,700px)_180px] xl:justify-between">
      <article className="min-w-0">
        <p className="eyebrow-tc">{doc.category}</p>
        <h1 className="mt-5 font-display text-[clamp(2.8rem,5vw,4.7rem)] font-semibold leading-[0.95] tracking-[-0.05em]">{doc.title}</h1>
        <p className="mt-5 text-[16px] leading-7 text-fg-secondary">{doc.description}</p>

        <div className="prose-fp mt-10 border-t border-line pt-9" dangerouslySetInnerHTML={{ __html: html }} />

        <nav className="mt-16 grid gap-4 border-t border-line pt-6 sm:grid-cols-2">
          {prev ? (
            <Link href={`/docs/${prev.slug}`} className="group text-left">
              <span className="inline-flex items-center gap-1 text-[10px] text-fg-muted"><ArrowLeft size={11} /> Previous</span>
              <p className="mt-1 text-[13px] font-medium text-fg group-hover:text-accent">{prev.title}</p>
            </Link>
          ) : <span />}
          {next && (
            <Link href={`/docs/${next.slug}`} className="group text-left sm:text-right">
              <span className="inline-flex items-center gap-1 text-[10px] text-fg-muted">Next <ArrowRight size={11} /></span>
              <p className="mt-1 text-[13px] font-medium text-fg group-hover:text-accent">{next.title}</p>
            </Link>
          )}
        </nav>
      </article>

      <aside className="hidden xl:block">
        <div className="sticky top-24"><TocRail items={toc} /></div>
      </aside>
    </div>
  );
}
