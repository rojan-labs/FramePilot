import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { getDoc, getDocSlugs, getDocNeighbors } from '@/lib/docs';
import { renderMarkdown, extractToc } from '@/lib/markdown';
import { pageMetadata } from '@/lib/seo';
import { TocRail } from '@/components/docs/TocRail';
import { PageHeader } from '@/components/PageHeader';
import { Ruler } from '@/components/timeline/Ruler';

export function generateStaticParams() {
  return getDocSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
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
        <PageHeader
          tc="DOC"
          eyebrow={doc.category}
          size="md"
          title={doc.title}
          description={doc.description}
        />

        <div className="prose-fp mt-9" dangerouslySetInnerHTML={{ __html: html }} />

        <Ruler className="mt-16" />
        <nav className="grid gap-4 pt-5 sm:grid-cols-2">
          {prev ? (
            <Link href={`/docs/${prev.slug}`} className="group text-left">
              <span className="tc inline-flex items-center gap-1.5 text-fg-muted">
                <ArrowLeft size={11} aria-hidden /> Previous
              </span>
              <p className="mt-1.5 text-[13px] font-medium text-fg group-hover:text-accent">
                {prev.title}
              </p>
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link href={`/docs/${next.slug}`} className="group text-left sm:text-right">
              <span className="tc inline-flex items-center gap-1.5 text-fg-muted sm:justify-end">
                Next <ArrowRight size={11} aria-hidden />
              </span>
              <p className="mt-1.5 text-[13px] font-medium text-fg group-hover:text-accent">
                {next.title}
              </p>
            </Link>
          )}
        </nav>
      </article>

      <aside className="hidden xl:block">
        <div className="sticky top-24">
          <TocRail items={toc} />
        </div>
      </aside>
    </div>
  );
}
