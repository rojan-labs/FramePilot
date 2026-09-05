import type { ReactNode } from 'react';
import { Eyebrow, Ruler } from './timeline/Ruler';

const TONES = {
  paper: 'bg-canvas',
  shade: 'bg-app',
  ink: 'bg-[#131110] text-white',
} as const;

export type SectionTone = keyof typeof TONES;

/**
 * A section of the timeline. Sections are separated by a ruler with tick marks
 * rather than a plain rule, so scrolling the page reads as scrubbing a
 * sequence.
 */
export function Section({
  id,
  children,
  tone = 'paper',
  rule = true,
  className = '',
}: {
  id?: string;
  children: ReactNode;
  tone?: SectionTone;
  /** Draw the ruler that separates this section from the one above it. */
  rule?: boolean;
  className?: string;
}) {
  return (
    <section id={id} className={`scroll-mt-24 ${TONES[tone]} ${className}`}>
      {rule && (
        <div className="container-x">
          <Ruler tone={tone === 'ink' ? 'ink' : 'paper'} />
        </div>
      )}
      <div className="container-x py-18 sm:py-24 lg:py-28">{children}</div>
    </section>
  );
}

/**
 * Section heading. The eyebrow is a timecode so the page reads as a sequence:
 * `▸ 00:02 · THE PRODUCT`.
 */
export function SectionHeading({
  tc,
  eyebrow,
  title,
  description,
  tone = 'paper',
  align = 'left',
  className = '',
}: {
  tc: string;
  eyebrow: string;
  title: ReactNode;
  description?: ReactNode;
  tone?: 'paper' | 'ink';
  align?: 'center' | 'left';
  className?: string;
}) {
  const centered = align === 'center';

  return (
    <div className={`${centered ? 'mx-auto max-w-3xl text-center' : 'max-w-3xl'} ${className}`}>
      <Eyebrow tc={tc} tone={tone} className={centered ? 'justify-center' : ''}>
        {eyebrow}
      </Eyebrow>
      <h2 className="mt-5 text-[length:var(--text-h2)] leading-[var(--text-h2--line-height)] tracking-[var(--text-h2--letter-spacing)]">
        {title}
      </h2>
      {description && (
        <p
          className={`mt-5 max-w-2xl text-[15px] leading-7 sm:text-[16px] ${
            tone === 'ink' ? 'text-white/55' : 'text-fg-secondary'
          } ${centered ? 'mx-auto' : ''}`}
        >
          {description}
        </p>
      )}
    </div>
  );
}
