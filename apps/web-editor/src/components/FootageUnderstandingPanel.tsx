/**
 * FootageUnderstandingPanel (plan FI5.1 / FI5.1a) — surfaces the AI's understanding of
 * the FOOTAGE: the time-ordered chapters and highlights each asset's footage map
 * produced, plus an HONEST coverage state when there is no map to show.
 *
 * WHY asset-based, not timeline-based: understanding is a property of the footage, not
 * of the current edit. The map is requested in each asset's OWN source seconds
 * (`assetTime`), so it is complete even when the asset is unplaced, trimmed to a sliver,
 * or split — the timeline "may be empty and things" and the understanding still holds.
 * The timeline is consulted only to ACT: click a chapter to seek there when the footage
 * is placed, and watch the chapter under the playhead light up while you edit
 * (source↔timeline projection lives in `editor/footageProjection.ts`, never the engine).
 *
 * The map is served from the engine's content-hash cache (plan FI2.3): reopening a
 * project is a pure cache read, so opening this panel costs nothing and the map
 * survives across sessions. Only the explicit "Rebuild" action re-fetches Pegasus —
 * which is slow, so the first (uncached) build gets a staged long-wait experience.
 *
 * Honest-unavailable is a first-class state, never hidden: an unreachable engine, an
 * unread project (`not_indexed`), a plan without generative understanding
 * (`pegasus_unavailable`), or a missing key each render a plain-language reason and a
 * next step — never a fabricated map (AGENTS.md invariant 6). Desktop-first (CLAUDE.md).
 *
 * Unread footage is the one state with work to do, so it gets a real action rather than
 * advice: "Read this footage" runs the same preparation pass an import runs, streaming
 * its progress here. Without it the panel was a dead end — it pointed at a media-bin
 * action that does not exist, and Rebuild re-fetched a map that could never appear.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { Variants } from 'framer-motion';
import type { Asset, Project } from '@framepilot/timeline-schema';
import type {
  EnsureMediaUnderstandingResult,
  FootageChapter,
  FootageMap,
} from '@framepilot/ai-sdk';
import { createLogger } from '@framepilot/shared-types';
import { Button } from '@framepilot/ui';
import {
  AlertTriangle,
  ICON_SIZE,
  Info,
  Layers,
  Lightbulb,
  Map as MapIcon,
  RotateCcw,
  Sparkles,
  X,
  Zap,
} from './icons.js';
import type { LucideIcon } from './icons.js';
import { Tooltip } from './Tooltip.js';
import type { UseEditor } from '../editor/useEditor.js';
import { useAiConfig } from '../editor/useAiConfig.js';
import { ensureProjectMediaUnderstanding, fetchFootageMap } from '../editor/visualIndex.js';
import { assetDisplayName } from '../editor/selectors.js';
import { sourceToTimeline, timelineToSource } from '../editor/footageProjection.js';
import { useModalFocusTrap } from './ai/useModalFocusTrap.js';

const log = createLogger('web-editor:understanding-panel');

export interface FootageUnderstandingPanelProps {
  readonly editor: UseEditor;
  readonly project: Project;
  readonly open: boolean;
  readonly onClose: () => void;
}

/**
 * Shared reveal choreography for the panel body. Content doesn't just appear — the
 * summary, each chapter, and each highlight rise and fade in one after another
 * (`staggerChildren`) so the eye is led down the structure of the footage. A spring,
 * not a linear tween, gives the motion weight without feeling slow. `useRevealVariants`
 * collapses both container and item to no-op movement under `prefers-reduced-motion`,
 * so the exact same JSX renders instantly for motion-averse users.
 */
function useRevealVariants(): { container: Variants; item: Variants } {
  const reduce = useReducedMotion();
  return useMemo(() => {
    if (reduce) {
      const still: Variants = { hidden: { opacity: 1 }, show: { opacity: 1 } };
      return { container: still, item: still };
    }
    return {
      container: {
        hidden: {},
        show: { transition: { staggerChildren: 0.05, delayChildren: 0.03 } },
      },
      item: {
        hidden: { opacity: 0, y: 10 },
        show: {
          opacity: 1,
          y: 0,
          transition: { type: 'spring', stiffness: 460, damping: 34 },
        },
      },
    };
  }, [reduce]);
}

/**
 * The teaching cards. Footage understanding is a new idea — chapters aren't the timeline,
 * highlights aren't a search, the map is read from the footage and cached, not recomputed
 * from the edit. Rather than hide that in a tooltip, we surface it as a small dismissible
 * deck so an editor can learn WHAT they're looking at and HOW to act on it. Copy is written
 * for editors (PRD audience), not engineers — no "Pegasus", no "content hash".
 */
interface LearnCard {
  readonly id: string;
  readonly icon: LucideIcon;
  readonly title: string;
  readonly body: string;
}

const LEARN_CARDS: readonly LearnCard[] = [
  {
    id: 'chapters',
    icon: Layers,
    title: 'Chapters',
    body: 'Your footage split into time-ordered scenes. Click one to jump the playhead there — whenever that clip is on your timeline.',
  },
  {
    id: 'highlights',
    icon: Sparkles,
    title: 'Highlights',
    body: 'The moments worth keeping — reveals, punchlines, peak action — ranked by how much they stand out from the rest.',
  },
  {
    id: 'how',
    icon: Zap,
    title: 'How it’s read',
    body: 'The AI maps what’s IN the footage, not your current cut — so editing never changes it. It’s read once and cached, so reopening is instant. Rebuild re-reads from scratch.',
  },
];

const LEARN_DISMISSED_KEY = 'fp:understanding:learn-dismissed';

/** Read the persisted "I've seen the guide" flag, defaulting to showing it (SSR/test safe). */
function readLearnDismissed(): boolean {
  try {
    return window.localStorage.getItem(LEARN_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The animated info-card deck. Cards spring in on a stagger and each lifts on hover; the
 * whole deck collapses (height + fade) when dismissed or reopened via the header's guide
 * toggle. Dismissal is remembered so a returning editor isn't taught twice.
 */
function LearnCards({ onDismiss }: { readonly onDismiss: () => void }): JSX.Element {
  const reduce = useReducedMotion();
  const deckVariants: Variants = reduce ? {} : { show: { transition: { staggerChildren: 0.07 } } };
  const cardVariants: Variants = reduce
    ? { hidden: { opacity: 1 }, show: { opacity: 1 } }
    : {
        hidden: { opacity: 0, y: 14, scale: 0.96 },
        show: {
          opacity: 1,
          y: 0,
          scale: 1,
          transition: { type: 'spring', stiffness: 500, damping: 30 },
        },
      };
  return (
    <motion.section
      className="understanding-learn"
      aria-label="What is footage understanding?"
      initial={reduce ? false : { opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
      transition={{ type: 'spring', stiffness: 380, damping: 40 }}
    >
      <div className="understanding-learn-head">
        <span className="understanding-learn-eyebrow">
          <Lightbulb size={13} aria-hidden="true" /> How to read this
        </span>
        <button
          type="button"
          className="understanding-learn-dismiss"
          onClick={onDismiss}
          aria-label="Dismiss the guide"
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>
      <motion.div
        className="understanding-learn-deck"
        initial="hidden"
        animate="show"
        variants={deckVariants}
      >
        {LEARN_CARDS.map((card) => {
          const Icon = card.icon;
          return (
            <motion.article
              key={card.id}
              className="understanding-learn-card"
              variants={cardVariants}
              whileHover={reduce ? {} : { y: -3 }}
            >
              <span className="understanding-learn-icon" aria-hidden="true">
                <Icon size={15} />
              </span>
              <h4 className="understanding-learn-title">{card.title}</h4>
              <p className="understanding-learn-body">{card.body}</p>
            </motion.article>
          );
        })}
      </motion.div>
    </motion.section>
  );
}

/** The panel's fetch state — a discriminated union so every branch renders explicitly. */
type ViewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unreachable' }
  /** Reading the footage for the first time (the paced index job), with live progress. */
  | { readonly kind: 'preparing'; readonly message: string }
  /** Reading the footage was attempted and honestly failed — the reason is shown. */
  | { readonly kind: 'blocked'; readonly message: string }
  | { readonly kind: 'map'; readonly map: FootageMap };

/** True when the ONE next step is "read this footage" — the action the panel offers. */
function isUnindexed(map: FootageMap | undefined): boolean {
  return map !== undefined && map.available !== false && map.reason === 'not_indexed';
}

/**
 * Plain-language reason a read attempt failed, in editor language. Keyed off the
 * runtime's typed reason so each failure names its own next step — a wrong key is not
 * a network problem, and a still-running index is not a failure.
 */
function unreadableMessage(result: EnsureMediaUnderstandingResult): string {
  if (result.status === 'ready') return '';
  switch (result.reason) {
    case 'unconfigured':
      return 'No understanding key is configured. Add a TwelveLabs or embeddings key in Settings, then read the footage.';
    case 'invalid_api_key':
      return 'The configured understanding key was rejected. Check the key in Settings and try again.';
    case 'quota_exceeded':
      return 'The understanding provider reports no remaining credit for this account.';
    case 'rate_limited':
      return 'The understanding provider is rate-limiting this account. Wait a moment and try again.';
    case 'offline':
      return 'Can’t reach the understanding provider. Check the connection and try again.';
    case 'indexing':
      return 'Still reading this footage. Leave it running and reopen this panel in a moment.';
    case 'source_missing':
      return 'The media file for this footage can’t be found on disk any more.';
    case 'cancelled':
      return 'Reading the footage was cancelled.';
    case 'timeout':
      return 'Reading the footage timed out before it finished. Try again.';
    default:
      return `Reading the footage didn’t finish: ${result.message}`;
  }
}

/** `m:ss` for a source/timeline second, so spans read like a video scrubber. */
function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** Compact duration label (`12s`, `1:05`) for a chapter span. */
function span(t0: number, t1: number): string {
  const secs = Math.max(0, Math.round(t1 - t0));
  return secs < 60 ? `${secs}s` : clock(secs);
}

/**
 * Staged loading copy + anti-flash for a wait whose length we can't predict: a cached
 * map returns in a blink, a first-time Pegasus build takes many seconds. We hold the
 * loader back ~250ms (a cached open shows nothing), then tell the truth about the phase
 * as time passes (labor illusion + honest expectation-setting), never a fake percentage.
 */
const LOADING_STAGES: readonly { readonly after: number; readonly text: string }[] = [
  { after: 0, text: 'Reading the footage…' },
  { after: 3, text: 'Mapping chapters and highlights…' },
  { after: 8, text: 'Longer clip — building the full map…' },
  { after: 20, text: 'Still analyzing the footage — this can take a minute…' },
];

function useLoadingStage(active: boolean): { readonly show: boolean; readonly text: string } {
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!active) {
      setElapsedMs(0);
      return;
    }
    const startedAt = Date.now();
    const id = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 500);
    return () => window.clearInterval(id);
  }, [active]);
  // Anti-flash: only reveal the loader once the wait crosses ~250ms.
  const show = active && elapsedMs >= 250;
  const seconds = elapsedMs / 1000;
  const stage = [...LOADING_STAGES].reverse().find((s) => seconds >= s.after);
  return { show, text: stage?.text ?? 'Reading the footage…' };
}

/**
 * Plain-language coverage line for a map with no chapters — the honest state. Keyed off
 * the engine's typed `reason` so each gate (no key / not indexed / no Pegasus / built-in
 * empty) tells the editor exactly what to do next, never pretending a map exists.
 */
function coverageMessage(map: FootageMap): string {
  if (map.available === false) {
    return `The footage map is unavailable${map.reason ? `: ${map.reason}` : ''}.`;
  }
  switch (map.reason) {
    case 'not_indexed':
      // No "go do it elsewhere" — the button next to this line reads the footage.
      return 'The AI hasn’t watched this footage yet, so there’s no map to show. Read it once and it’s cached from then on.';
    case 'pegasus_unavailable':
      return 'Generative understanding is not available on this TwelveLabs plan. Once the footage is indexed, the built-in structure is shown instead.';
    case 'no_api_key':
      return 'No understanding key is configured. Add a TwelveLabs or embeddings key in Settings to map the footage.';
    case 'invalid_api_key':
      return 'The configured understanding key was rejected. Check the key in Settings.';
    default:
      return 'No structure was found for this footage yet.';
  }
}

/** Skeleton spine while the map loads — mirrors the chapter rows, so nothing jumps. */
function LoadingChapters(): JSX.Element {
  return (
    <div className="understanding-skeleton" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="understanding-skeleton-row">
          <span className="understanding-skeleton-node" />
          <span className="understanding-skeleton-lines">
            <span className="understanding-skeleton-title" />
            <span className="understanding-skeleton-sub" />
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The active chapter (the one the playhead sits inside), or `-1`. The playhead is
 * TIMELINE time; chapters are SOURCE time — so we project the playhead back through the
 * clip under it (`timelineToSource`) and match on the same asset. Subscribed through
 * `useSyncExternalStore` so the list re-renders ONLY when the active index changes, not
 * every frame of playback (the snapshot is a primitive index → React bails via Object.is).
 */
function useActiveChapterIndex(editor: UseEditor, chapters: readonly FootageChapter[]): number {
  const timeline = editor.state.timeline;
  const indexFor = useCallback((): number => {
    const src = timelineToSource(editor.getPlayhead(), timeline);
    if (!src) return -1;
    return chapters.findIndex(
      (c) => c.assetId === src.assetId && src.sourceSeconds >= c.t0 && src.sourceSeconds < c.t1,
    );
  }, [editor, timeline, chapters]);
  return useSyncExternalStore(editor.subscribePlayhead, indexFor, indexFor);
}

/** Group chapters into contiguous runs by owning asset, preserving order. */
function groupByAsset(chapters: readonly FootageChapter[]): {
  readonly assetId: string | null;
  readonly items: { readonly chapter: FootageChapter; readonly index: number }[];
}[] {
  const groups: { assetId: string | null; items: { chapter: FootageChapter; index: number }[] }[] =
    [];
  chapters.forEach((chapter, index) => {
    const assetId = chapter.assetId ?? null;
    const last = groups[groups.length - 1];
    if (last && last.assetId === assetId) last.items.push({ chapter, index });
    else groups.push({ assetId, items: [{ chapter, index }] });
  });
  return groups;
}

/**
 * The chapter spine. Dedicated component so its playhead subscription re-renders only
 * this list. Chapters read in source time; a click seeks the timeline only when the
 * footage is placed there (else the row is a non-seeking, dimmed marker).
 */
function ChapterSpine({
  editor,
  chapters,
  assetLabel,
  showAssetHeaders,
}: {
  readonly editor: UseEditor;
  readonly chapters: readonly FootageChapter[];
  readonly assetLabel: (assetId: string | null) => string;
  readonly showAssetHeaders: boolean;
}): JSX.Element {
  const activeIndex = useActiveChapterIndex(editor, chapters);
  const activeRef = useRef<HTMLLIElement | null>(null);
  const reveal = useRevealVariants();

  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex]);

  const seek = useCallback(
    (chapter: FootageChapter): void => {
      if (!chapter.assetId) return;
      const t = sourceToTimeline(
        { assetId: chapter.assetId, sourceSeconds: chapter.t0 },
        editor.state.timeline,
      );
      if (t !== undefined) editor.seek(t);
    },
    [editor],
  );

  const isPlaced = useCallback(
    (chapter: FootageChapter): boolean =>
      chapter.assetId !== null &&
      chapter.assetId !== undefined &&
      sourceToTimeline(
        { assetId: chapter.assetId, sourceSeconds: chapter.t0 },
        editor.state.timeline,
      ) !== undefined,
    [editor],
  );

  return (
    <motion.div
      className="understanding-groups"
      initial="hidden"
      animate="show"
      variants={reveal.container}
    >
      {groupByAsset(chapters).map((group) => (
        <section key={group.assetId ?? '—'} className="understanding-group">
          {showAssetHeaders && (
            <motion.h3
              className="understanding-group-head"
              title={assetLabel(group.assetId)}
              variants={reveal.item}
            >
              {assetLabel(group.assetId)}
            </motion.h3>
          )}
          <ol className="understanding-chapters">
            {group.items.map(({ chapter, index }) => {
              const active = index === activeIndex;
              const placed = isPlaced(chapter);
              return (
                <motion.li
                  key={`${chapter.assetId}-${chapter.t0}-${index}`}
                  ref={active ? activeRef : null}
                  variants={reveal.item}
                >
                  <button
                    type="button"
                    className="understanding-chapter"
                    data-active={active ? 'true' : undefined}
                    data-unplaced={placed ? undefined : 'true'}
                    onClick={() => seek(chapter)}
                    disabled={!placed}
                    title={placed ? `Seek to ${clock(chapter.t0)}` : 'Not on the timeline yet'}
                    aria-current={active ? 'true' : undefined}
                  >
                    <span className="understanding-rail" aria-hidden="true">
                      <span className="understanding-node" />
                    </span>
                    <span className="understanding-chapter-body">
                      <span className="understanding-chapter-head">
                        <span className="understanding-chapter-title">{chapter.title}</span>
                        <span className="understanding-chapter-span">
                          {span(chapter.t0, chapter.t1)}
                        </span>
                      </span>
                      <span className="understanding-time">
                        {clock(chapter.t0)}–{clock(chapter.t1)}
                      </span>
                      {chapter.summary.trim() !== '' && (
                        <span className="understanding-chapter-summary">{chapter.summary}</span>
                      )}
                    </span>
                  </button>
                </motion.li>
              );
            })}
          </ol>
        </section>
      ))}
    </motion.div>
  );
}

export function FootageUnderstandingPanel({
  editor,
  project,
  open,
  onClose,
}: FootageUnderstandingPanelProps): JSX.Element | null {
  const { config } = useAiConfig();
  const [view, setView] = useState<ViewState>({ kind: 'loading' });
  const reveal = useRevealVariants();
  // The teaching deck shows for a first-time editor and stays hidden once dismissed;
  // the header's guide toggle brings it back on demand.
  const [showLearn, setShowLearn] = useState(() => !readLearnDismissed());
  const dismissLearn = useCallback(() => {
    setShowLearn(false);
    try {
      window.localStorage.setItem(LEARN_DISMISSED_KEY, '1');
    } catch {
      /* private mode / no storage — dismissal is best-effort, not load-bearing */
    }
  }, []);

  // Asset-native: the map does NOT depend on the timeline (no `editor.state.timeline`
  // here), so editing never invalidates it and an empty timeline still maps.
  const assetProject = useMemo<Project>(
    () => ({ ...project, assets: editor.state.assets as Project['assets'] }),
    [project, editor.state.assets],
  );

  const load = useCallback(
    async (refresh: boolean): Promise<void> => {
      setView({ kind: 'loading' });
      const map = await fetchFootageMap({
        project: assetProject,
        config,
        refresh,
        assetTime: true,
      });
      if (map === undefined) {
        log.warn('understanding → engine unreachable');
        setView({ kind: 'unreachable' });
        return;
      }
      setView({ kind: 'map', map });
    },
    // Intentionally not keyed on the timeline — understanding is asset-based.
    [assetProject, config],
  );

  /**
   * Read the footage, then show its map. WHY this lives here: the map can only be built
   * from footage the AI has actually watched, and until now an unread clip was a dead
   * end — the panel said "index it in the media bin", where no such action exists, and
   * Rebuild only re-asked for a map that could never appear. This is the one action that
   * makes the empty state true: it runs the same preparation pass the app runs after an
   * import (paced, joinable, honest when it fails) and reports its live progress instead
   * of a spinner. Explicit, never automatic — on a hosted backend it spends credits.
   */
  const prepare = useCallback(async (): Promise<void> => {
    setView({ kind: 'preparing', message: 'Reading the footage…' });
    log.action('understanding → read footage', { projectId: project.id });
    const result = await ensureProjectMediaUnderstanding({
      project: assetProject,
      config,
      onEvent: (event) => {
        if (event.type === 'progress' || event.type === 'cache' || event.type === 'coverage') {
          setView({ kind: 'preparing', message: event.message });
        }
      },
    });
    if (result.status !== 'ready') {
      log.warn('understanding → read failed', { reason: result.reason });
      setView({ kind: 'blocked', message: unreadableMessage(result) });
      return;
    }
    await load(false);
  }, [assetProject, config, load, project.id]);

  // Fetch when the panel opens. The engine serves this from its content-hash cache,
  // so a normal open never re-hits the API (refresh is reserved for "Rebuild").
  useEffect(() => {
    if (open) void load(false);
  }, [open, load]);

  // The panel dims and blocks the app behind it, so it is modal in fact — it just
  // never said so. Without the trap, Tab walks out under the backdrop onto controls
  // the user cannot see; without `aria-modal`, a screen reader never learns the rest
  // of the page is out of play.
  const panelRef = useModalFocusTrap<HTMLElement>(open);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const loading = useLoadingStage(view.kind === 'loading');
  // The header action does the useful thing for the state we are in: read the footage
  // when there is nothing to map, otherwise re-read an existing map.
  const needsRead = view.kind === 'map' && isUnindexed(view.map);
  const busy = view.kind === 'loading' || view.kind === 'preparing';

  const assetLabel = useCallback(
    (assetId: string | null): string => {
      if (!assetId) return 'Footage';
      const asset = (editor.state.assets as readonly Asset[]).find((a) => a.id === assetId);
      return assetDisplayName(asset, assetId);
    },
    [editor.state.assets],
  );

  const map = view.kind === 'map' ? view.map : undefined;
  const hasChapters = map !== undefined && map.chapters.length > 0;
  const distinctAssets = useMemo(
    () => (map ? new Set(map.chapters.map((c) => c.assetId ?? '—')).size : 0),
    [map],
  );

  if (!open) return null;

  return (
    <>
      <div className="understanding-backdrop" onClick={onClose} aria-hidden="true" />
      <aside
        ref={panelRef}
        className="understanding-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Footage understanding"
        tabIndex={-1}
      >
        <header className="understanding-head">
          <div className="understanding-title-group">
            <h2 className="understanding-title">
              <MapIcon size={ICON_SIZE.sm} aria-hidden="true" /> Footage understanding
            </h2>
            {hasChapters && map && (
              <p className="understanding-subtitle">
                {map.chapters.length} chapter{map.chapters.length === 1 ? '' : 's'}
                {distinctAssets > 1 && ` · ${distinctAssets} clips`}
                {map.backend && ` · ${map.backend}`}
              </p>
            )}
          </div>
          <div className="understanding-head-actions">
            {hasChapters && (
              <Tooltip label={showLearn ? 'Hide the guide' : 'What is this?'} placement="bottom">
                <Button
                  variant="ghost"
                  className="icon-btn"
                  type="button"
                  aria-label={showLearn ? 'Hide the guide' : 'Show the guide'}
                  aria-pressed={showLearn}
                  data-active={showLearn ? 'true' : undefined}
                  onClick={() => (showLearn ? dismissLearn() : setShowLearn(true))}
                >
                  <Info size={ICON_SIZE.sm} aria-hidden="true" />
                </Button>
              </Tooltip>
            )}
            <Tooltip
              label={
                needsRead
                  ? 'Read this footage and build the map'
                  : 'Rebuild map (re-reads the footage)'
              }
              placement="bottom"
            >
              <Button
                variant="ghost"
                className="icon-btn"
                type="button"
                aria-label="Rebuild the footage map"
                disabled={busy}
                onClick={() => void (needsRead ? prepare() : load(true))}
              >
                <RotateCcw size={ICON_SIZE.sm} aria-hidden="true" />
              </Button>
            </Tooltip>
            <Tooltip label="Close" shortcut="Esc" placement="bottom">
              <Button
                variant="ghost"
                className="icon-btn"
                type="button"
                aria-label="Close footage understanding"
                onClick={onClose}
              >
                <X size={ICON_SIZE.sm} aria-hidden="true" />
              </Button>
            </Tooltip>
          </div>
        </header>

        <div className="understanding-body">
          {view.kind === 'loading' && loading.show && (
            <>
              <p className="understanding-status" role="status" aria-live="polite">
                {loading.text}
              </p>
              <LoadingChapters />
            </>
          )}
          {view.kind === 'preparing' && (
            <>
              <p className="understanding-status" role="status" aria-live="polite">
                {view.message}
              </p>
              <LoadingChapters />
            </>
          )}
          {view.kind === 'blocked' && (
            <div className="understanding-empty" role="status">
              <AlertTriangle size={20} aria-hidden="true" className="understanding-empty-icon" />
              <p className="understanding-empty-text">{view.message}</p>
              <Button variant="secondary" type="button" onClick={() => void prepare()}>
                Try again
              </Button>
            </div>
          )}
          {view.kind === 'unreachable' && (
            <div className="understanding-empty" role="status">
              <AlertTriangle size={20} aria-hidden="true" className="understanding-empty-icon" />
              <p className="understanding-empty-text">
                Can’t reach the engine — start the sidecar and try again.
              </p>
              <Button variant="secondary" type="button" onClick={() => void load(false)}>
                Try again
              </Button>
            </div>
          )}
          {map !== undefined && !hasChapters && (
            <div className="understanding-empty" role="status">
              <MapIcon size={20} aria-hidden="true" className="understanding-empty-icon" />
              <p className="understanding-empty-text">{coverageMessage(map)}</p>
              {needsRead && (
                <Button variant="secondary" type="button" onClick={() => void prepare()}>
                  Read this footage
                </Button>
              )}
            </div>
          )}
          {map !== undefined && hasChapters && (
            <>
              <AnimatePresence initial={false}>
                {showLearn && <LearnCards key="learn" onDismiss={dismissLearn} />}
              </AnimatePresence>
              {map.summary.trim() !== '' && (
                <motion.p
                  className="understanding-summary"
                  initial="hidden"
                  animate="show"
                  variants={reveal.item}
                >
                  {map.summary}
                </motion.p>
              )}
              <ChapterSpine
                editor={editor}
                chapters={map.chapters}
                assetLabel={assetLabel}
                showAssetHeaders={distinctAssets > 1}
              />
              {map.highlights.length > 0 && (
                <>
                  <h3 className="understanding-subhead">
                    <Sparkles size={ICON_SIZE.sm} aria-hidden="true" /> Highlights
                  </h3>
                  <motion.ul
                    className="understanding-highlights"
                    initial="hidden"
                    animate="show"
                    variants={reveal.container}
                  >
                    {map.highlights.map((h, i) => {
                      const t =
                        h.assetId != null
                          ? sourceToTimeline(
                              { assetId: h.assetId, sourceSeconds: h.t0 },
                              editor.state.timeline,
                            )
                          : undefined;
                      return (
                        <motion.li key={`${h.assetId}-${h.t0}-${i}`} variants={reveal.item}>
                          <button
                            type="button"
                            className="understanding-highlight"
                            disabled={t === undefined}
                            onClick={() => t !== undefined && editor.seek(t)}
                            title={
                              t !== undefined ? `Seek to ${clock(h.t0)}` : 'Not on the timeline yet'
                            }
                          >
                            <span className="understanding-time">{clock(h.t0)}</span>
                            <span className="understanding-highlight-label">{h.label}</span>
                          </button>
                        </motion.li>
                      );
                    })}
                  </motion.ul>
                </>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
