import type { ReactNode } from 'react';

/**
 * The site's standard card: a hairline warm surface that, on hover, lifts its
 * border and lights two ember "frame bracket" corners (see .frame-card in
 * globals.css) — a viewfinder locking focus.
 */
export function SpotlightCard({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  // No overflow-hidden: the corner brackets sit 1px outside the border box.
  return <div className={`frame-card group p-6 ${className}`}>{children}</div>;
}
