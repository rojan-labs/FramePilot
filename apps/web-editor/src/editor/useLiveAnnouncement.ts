/**
 * A polite live region's text, set so that every message is spoken — the same one twice included.
 *
 * A screen reader speaks a live region when its text changes. Setting the same string twice does
 * not re-render, so "Added Fire at 0:12" after a second Fire at the same moment would be silent;
 * and a region that mounts already holding its text is often skipped (Chrome with VoiceOver). So
 * each message empties the region first and fills it a moment later, in a separate commit.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** How long the region stays empty before the message lands: long enough to be two commits. */
export const LIVE_ANNOUNCEMENT_GAP_MS = 50;

/**
 * @returns The region's current text, and `announce`, which says a message.
 */
export function useLiveAnnouncement(): readonly [string, (message: string) => void] {
  const [text, setText] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const announce = useCallback((message: string): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    setText('');
    timer.current = setTimeout(() => {
      timer.current = null;
      setText(message);
    }, LIVE_ANNOUNCEMENT_GAP_MS);
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  return [text, announce] as const;
}
