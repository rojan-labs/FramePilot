import Link from 'next/link';
import { getDocNav } from '@/lib/docs';
import { DocsSidebar } from '@/components/docs/DocsSidebar';
import { Ruler } from '@/components/timeline/Ruler';

/**
 * Shared docs chrome: a sticky left sidebar (all routes under /docs) plus the
 * content column. The right-hand table of contents is rendered per-page by the
 * article route, since only content pages have headings.
 */
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const nav = getDocNav();

  return (
    <div className="container-x py-10 sm:py-12">
      <div className="grid gap-10 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-14">
        <aside className="max-lg:pb-2 lg:sticky lg:top-[calc(var(--nav-h)_+_var(--announce-h)_+_24px)] lg:h-[calc(100vh_-_var(--nav-h)_-_var(--announce-h)_-_48px)] lg:overflow-y-auto">
          <Link
            href="/docs"
            className="tc hidden text-fg-tertiary transition-colors hover:text-fg lg:block"
          >
            Documentation
          </Link>
          <Ruler className="mb-5 mt-3 max-lg:hidden" />
          <DocsSidebar nav={nav} />
          <Ruler className="mt-6 lg:hidden" />
        </aside>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
