import Link from 'next/link';
import { getDocNav } from '@/lib/docs';
import { DocsSidebar } from '@/components/docs/DocsSidebar';

/**
 * Shared docs chrome: a sticky left sidebar (all routes under /docs) plus the
 * content column. The right-hand table of contents is rendered per-page by the
 * article route, since only content pages have headings.
 */
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const nav = getDocNav();

  return (
    <div className="container-x py-10 sm:py-14">
      <div className="grid gap-10 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="max-lg:border-b max-lg:border-line max-lg:pb-6 lg:sticky lg:top-[calc(var(--nav-h)_+_var(--announce-h)_+_24px)] lg:h-[calc(100vh_-_var(--nav-h)_-_var(--announce-h)_-_48px)] lg:overflow-y-auto">
          <Link
            href="/docs"
            className="mb-6 hidden text-[13px] font-medium text-fg-secondary transition-colors hover:text-fg lg:block"
          >
            Documentation
          </Link>
          <DocsSidebar nav={nav} />
        </aside>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
