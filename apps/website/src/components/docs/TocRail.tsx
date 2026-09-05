'use client';

import { useEffect, useState } from 'react';
import type { TocEntry } from '@/lib/markdown';

/**
 * On-page table of contents with scroll-spy. A single IntersectionObserver tracks
 * every heading and highlights the one currently in view — the small touch that
 * makes docs feel considered rather than generated.
 */
export function TocRail({ items }: { items: TocEntry[] }) {
  const [activeId, setActiveId] = useState<string | null>(items[0]?.id ?? null);

  useEffect(() => {
    if (items.length === 0) return;
    const headings = items
      .map((i) => document.getElementById(i.id))
      .filter((el): el is HTMLElement => el !== null);

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target.id) setActiveId(visible[0].target.id);
      },
      // Bias the "active" band toward the top third of the viewport.
      { rootMargin: '-80px 0px -66% 0px', threshold: 0 },
    );
    headings.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [items]);

  if (items.length === 0) return null;

  return (
    <nav aria-label="On this page" className="text-[12.5px]">
      <p className="tc mb-3 text-fg-muted">On this page</p>
      <ul className="space-y-1.5 border-l border-line">
        {items.map((item) => (
          <li key={item.id} style={{ paddingLeft: item.depth === 3 ? 20 : 12 }}>
            <a
              href={`#${item.id}`}
              className={`-ml-px block border-l-2 py-0.5 pl-3 transition-colors ${
                activeId === item.id
                  ? 'border-accent text-accent'
                  : 'border-transparent text-fg-tertiary hover:text-fg-secondary'
              }`}
            >
              {item.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
