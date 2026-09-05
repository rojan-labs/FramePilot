import type { ReactNode } from 'react';

/**
 * The site's structural primitives. Every horizontal division on FramePilot's
 * marketing site is a piece of a timeline ruler rather than a plain border:
 * a hairline with tick marks, punctuated by in/out point markers.
 */

export function Ruler({
  tone = 'paper',
  flip = false,
  className = '',
}: {
  tone?: 'paper' | 'ink';
  /** Ticks hang up from a bottom hairline instead of down from a top one. */
  flip?: boolean;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={`ruler ${flip ? 'ruler-flip' : ''} ${tone === 'ink' ? 'ruler-ink' : ''} ${className}`}
    />
  );
}

/** A right-facing wedge: the point an edit starts from. */
export function InPoint({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-0 w-0 border-y-[5px] border-l-[7px] border-y-transparent border-l-accent ${className}`}
    />
  );
}

/** A left-facing wedge: the point an edit runs out at. */
export function OutPoint({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-0 w-0 border-y-[5px] border-r-[7px] border-y-transparent border-r-accent ${className}`}
    />
  );
}

/** A mono, tabular timecode string. */
export function Timecode({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`tc ${className}`}>{children}</span>;
}

/**
 * The section eyebrow: an in-point marker, the section's timecode, and its
 * name — `▸ 00:02 · THE PRODUCT`.
 */
export function Eyebrow({
  tc,
  children,
  tone = 'paper',
  className = '',
}: {
  tc: string;
  children: ReactNode;
  tone?: 'paper' | 'ink';
  className?: string;
}) {
  return (
    <p className={`flex items-center gap-2.5 ${className}`}>
      <InPoint />
      <span className={`tc ${tone === 'ink' ? 'text-white/45' : 'text-accent'}`}>{tc}</span>
      <span aria-hidden className={tone === 'ink' ? 'tc text-white/25' : 'tc text-fg-muted'}>
        ·
      </span>
      <span className={`tc ${tone === 'ink' ? 'text-white/55' : ''}`}>{children}</span>
    </p>
  );
}

/** The playhead: a 1px accent line. Used as a static rule and as a moving one. */
export function PlayheadLine({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`block w-px bg-accent shadow-[0_0_6px_rgba(242,101,34,0.5)] ${className}`}
    />
  );
}
