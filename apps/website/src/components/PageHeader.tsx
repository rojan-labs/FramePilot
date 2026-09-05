import type { ReactNode } from 'react';
import { InPoint, Ruler } from './timeline/Ruler';

/**
 * The header every route outside the landing page shares.
 *
 * It opens on an in point — the mark an editor sets where a sequence starts —
 * followed by the route's timecode label, so arriving on /docs or /changelog
 * feels like moving the playhead rather than opening a different website.
 */
export function PageHeader({
  tc,
  eyebrow,
  title,
  description,
  meta,
  children,
  size = 'lg',
}: {
  tc: string;
  eyebrow: string;
  title: ReactNode;
  description?: ReactNode;
  /** Right-hand slate: dates, versions, reading time. */
  meta?: ReactNode;
  children?: ReactNode;
  size?: 'lg' | 'md';
}) {
  return (
    <header>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2.5">
          <InPoint />
          <span className="tc text-accent">{tc}</span>
          <span aria-hidden className="tc text-fg-muted">
            ·
          </span>
          <span className="tc">{eyebrow}</span>
        </p>
        {meta}
      </div>

      <h1
        className={
          size === 'lg'
            ? 'mt-6 font-display text-[length:var(--text-h1)] leading-[var(--text-h1--line-height)] tracking-[var(--text-h1--letter-spacing)]'
            : 'mt-6 font-display text-[clamp(2.6rem,5.2vw,4.6rem)] font-semibold leading-[0.94] tracking-[-0.05em]'
        }
      >
        {title}
      </h1>

      {description && (
        <p className="mt-6 max-w-2xl text-[16px] leading-7 text-fg-secondary sm:text-[17px]">
          {description}
        </p>
      )}

      {children}
      <Ruler className="mt-10 sm:mt-12" />
    </header>
  );
}
