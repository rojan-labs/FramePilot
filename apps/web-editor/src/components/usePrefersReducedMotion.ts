/**
 * Whether the viewer has asked for reduced motion.
 *
 * Lives in its own module because two unrelated surfaces need the same answer —
 * the transitions panel (which otherwise loops 77 animated previews) and anything
 * else that decides to animate later — and because a component that reads
 * `matchMedia` inline is a component that cannot be rendered in a test
 * environment without one.
 *
 * Absence of `matchMedia` (jsdom, an old embedded webview) reports `false`: the
 * motion is the product here, and defaulting to "off" would silently give every
 * test environment a different UI from the real one.
 */
import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    const query = globalThis.matchMedia?.(QUERY);
    return query?.matches === true;
  });

  useEffect(() => {
    const query = globalThis.matchMedia?.(QUERY);
    if (query === undefined) return;
    const onChange = (event: MediaQueryListEvent): void => setReduced(event.matches);
    // `addEventListener` rather than the deprecated `addListener`: Safari has
    // supported it since 14, which is below this app's floor.
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
