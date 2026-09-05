'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { DocNavGroup } from '@/lib/docs';

/**
 * The docs sidebar reads as a track list: each group is a track, each page a
 * clip on it, and the page you are on carries the playhead's colour.
 */
export function DocsSidebar({ nav }: { nav: DocNavGroup[] }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Documentation" className="flex flex-col gap-6 text-[12.5px]">
      {nav.map((group, groupIndex) => (
        <div key={group.category}>
          <p className="tc mb-2.5 flex items-center gap-2 text-fg-muted">
            <span className="tabular">{`V${groupIndex + 1}`}</span>
            {group.category}
          </p>
          <ul className="border-l border-line">
            {group.items.map((item) => {
              const href = `/docs/${item.slug}`;
              const active = pathname === href;
              return (
                <li key={item.slug}>
                  <Link
                    href={href}
                    aria-current={active ? 'page' : undefined}
                    className={`-ml-px block border-l-2 py-1.5 pl-3 transition-colors ${
                      active
                        ? 'border-accent font-medium text-fg'
                        : 'border-transparent text-fg-secondary hover:border-line-strong hover:text-fg'
                    }`}
                  >
                    {item.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
