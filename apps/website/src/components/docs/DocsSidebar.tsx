'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { DocNavGroup } from '@/lib/docs';

export function DocsSidebar({ nav }: { nav: DocNavGroup[] }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Documentation" className="flex flex-col gap-7 text-[12.5px]">
      {nav.map((group) => (
        <div key={group.category}>
          <p className="mb-2 font-mono text-[8.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
            {group.category}
          </p>
          <ul>
            {group.items.map((item) => {
              const href = `/docs/${item.slug}`;
              const active = pathname === href;
              return (
                <li key={item.slug}>
                  <Link
                    href={href}
                    aria-current={active ? 'page' : undefined}
                    className={`block border-l py-1.5 pl-3 transition-colors ${
                      active ? 'border-accent font-medium text-fg' : 'border-transparent text-fg-secondary hover:text-fg'
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
