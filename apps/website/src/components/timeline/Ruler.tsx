import type { ReactNode } from 'react';

/**
 * The site's structural primitives: rules, in/out point markers, timecode, and
 * the section eyebrow that ties them together.
 */

export type RulerVariant = 'plain' | 'mark' | 'axis';

/**
 * A horizontal division.
 *
 * Tick marks are a *measurement axis*, not a border. They are legible only when
 * something below them is positioned along that axis, and a page that draws
 * thirty of them has spent the signature on work a hairline does. So the plain
 * hairline is the default and ticks have to be asked for:
 *
 * 1. **Ticks measure.** `variant="axis"` only directly above a `.lane` whose
 *    children are placed by `--start`/`--span`/a `%` width, or immediately
 *    beside an `<InPoint>`/`<OutPoint>`.
 * 2. **One axis per viewport.** Never two combs within ~100vh. The only
 *    exception is the side-by-side panels of a single comparison.
 * 3. **Never inside a repeat.** No ticks inside `.map()`, `<li>`, `<details>`,
 *    `<dd>`, or a card: repetition turns a signature into a texture.
 * 4. **One divider per boundary.** If a tone change, a `.lane` surface, or an
 *    inverted title bar already carries the boundary, it gets no rule as well.
 * 5. **Chrome is plain.** Nav, footer, sidebar, fine print, and prose rules are
 *    hairlines; the comb belongs to content, never to the frame.
 * 6. **Authors cannot spend the budget.** Markdown `---` never renders ticks.
 */
export function Ruler({
  variant = 'plain',
  tone = 'paper',
  flip = false,
  className = '',
}: {
  /** `plain` hairline, `mark` major ticks only, `axis` the full comb. */
  variant?: RulerVariant;
  tone?: 'paper' | 'ink';
  /** Ticks hang up from a bottom hairline instead of down from a top one. */
  flip?: boolean;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={`ruler ${variant === 'plain' ? '' : `ruler-${variant}`} ${flip ? 'ruler-flip' : ''} ${tone === 'ink' ? 'ruler-ink' : ''} ${className}`}
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
export function Timecode({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
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
