'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type MutableRefObject,
} from 'react';
import { usePathname } from 'next/navigation';
import { LayoutGroup } from 'framer-motion';
import { COMPETITOR_TOOLS, type ToolTile } from './ToolTiles';
import { useIntroMachine } from './use-intro-machine';
import { Dustbin } from './Dustbin';
import type { IntroState } from '@/lib/intro-machine';

interface IntroContextValue {
  state: IntroState;
  /** True on `/`, the only route the intro and the bin belong to. */
  isLanding: boolean;
  /** False until the client has hydrated, so SSR renders the settled markup. */
  mounted: boolean;
  /** End the intro immediately, from any state. */
  skip: () => void;
  /** The bin element, so the track knows where to throw a cut tile. */
  binRef: MutableRefObject<HTMLButtonElement | null>;
  lidOpen: boolean;
  setLidOpen: (open: boolean) => void;
  /** Everything that has landed in the bin so far. */
  discarded: ToolTile[];
  reportDiscarded: (id: string) => void;
}

const IntroContext = createContext<IntroContextValue | null>(null);

export function useIntro(): IntroContextValue {
  const value = useContext(IntroContext);
  if (!value) throw new Error('useIntro must be used inside <IntroProvider>');
  return value;
}

/**
 * Owns the intro's state for the whole document: the navbar, the hero track,
 * and the bin all read the same machine, so there is never zero or two logos.
 */
export function IntroProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isLanding = pathname === '/';

  const { state, skip, mounted } = useIntroMachine(isLanding);

  const binRef = useRef<HTMLButtonElement | null>(null);
  const [lidOpen, setLidOpen] = useState(false);
  const [discardedIds, setDiscardedIds] = useState<string[]>([]);

  const reportDiscarded = useCallback((id: string) => {
    setDiscardedIds((current) => (current.includes(id) ? current : [...current, id]));
  }, []);

  // The lid shuts once the last tool is in.
  useEffect(() => {
    if (discardedIds.length >= COMPETITOR_TOOLS.length) setLidOpen(false);
  }, [discardedIds.length]);

  /*
   * Once the intro is over every competitor is in the bin, whether the visitor
   * watched the sequence, skipped it halfway, or arrived with reduced motion
   * on. The bin is a statement, not a progress bar.
   */
  const discarded = useMemo(
    () =>
      state === 'settled'
        ? COMPETITOR_TOOLS
        : COMPETITOR_TOOLS.filter((tool) => discardedIds.includes(tool.id)),
    [state, discardedIds],
  );

  const value = useMemo<IntroContextValue>(
    () => ({
      state,
      isLanding,
      mounted,
      skip,
      binRef,
      lidOpen,
      setLidOpen,
      discarded,
      reportDiscarded,
    }),
    [state, isLanding, mounted, skip, lidOpen, discarded, reportDiscarded],
  );

  return (
    <IntroContext.Provider value={value}>
      {/* The track's FramePilot tile and the navbar mark are one shared element. */}
      <LayoutGroup>
        {children}
        {isLanding && mounted && <Dustbin />}
      </LayoutGroup>
    </IntroContext.Provider>
  );
}
