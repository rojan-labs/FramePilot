/**
 * AI review player (plan/PLAN.md H1.5/J3 — "before/after review player").
 *
 * Renders a proposed edit's `before` and `after` timelines through the SAME
 * real `PreviewPlayer` used everywhere else in the app (render-vs-preview rule:
 * this is HTML video, never MoviePy), so what the reviewer sees before Accepting
 * an AI edit is the same rendering path as the live editor, not a bespoke mock.
 *
 * Two compare LAYOUTS, chosen by a toggle in the toolbar:
 *  - "Hold to compare" (default, original): a spring-loaded A/B control lets
 *    the reviewer hold a key/button to see "before" at the SAME playhead
 *    position, and release to return to "after". ONE `PreviewPlayer` is
 *    mounted; its `editor` prop swaps timelines.
 *  - "Side by side" (H1.5/J3 follow-up): TWO `PreviewPlayer`s mount live,
 *    one per timeline, sharing the SAME `PlayheadClock` so they always show
 *    the same instant. Wipe compare (a single frame split at a draggable
 *    line) is a natural next increment on top of this but is deliberately
 *    NOT built here — see plan/PLAN.md H1.5.
 *
 * Side-by-side mount correctness (see `useShadowEditor` below):
 *  - Clock master: with two live `PreviewPlayer`s, both would otherwise call
 *    `clock.set` every animation frame during playback and fight/jitter. The
 *    AFTER panel is always the write-through master; the BEFORE panel's
 *    editor is read-follow-only in split layout (no clock writes), so it
 *    only ever displays what AFTER drives.
 *  - Shared transport: `playing` is lifted to this component (not owned per
 *    editor instance) so either panel's own play/pause button drives BOTH.
 *  - Audio: the BEFORE panel is muted (`PreviewPlayer`'s `muted` prop) so
 *    only AFTER's audio plays.
 *  - Ready-gating: each `PreviewPlayer` has its own internal "prepare on
 *    play" gate (its media pool warms independently). We do NOT cross-wire
 *    the two gates — BEFORE not writing the clock means its readiness can
 *    only affect its OWN paint timing, never AFTER's, so a brief BEFORE-side
 *    desync while its pool warms is an accepted, documented trade-off rather
 *    than added cross-instance coordination.
 *  - Perf: doubling the mounted `PreviewPlayer`s doubles the decode/pool
 *    cost (`PREVIEW_POOL_SIZE` per side). Shrinking the pool specifically for
 *    this dual-mount context would require threading a pool-size param
 *    through `nextPool`/`selectors.ts`'s pool machinery — not a small,
 *    contained change, so it is left as-is (documented, not built here).
 *
 * Tick marks on the scrubber (from `structuredDiffTimeline`'s `ChangedRegion`s)
 * show WHERE the edit touched the timeline; small honesty badges flag when a
 * region isn't cleanly 1:1 previewable so the review UI never implies more
 * fidelity than it has.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { emptyHistory, type ChangedRegion, type ValidationIssue } from '@framepilot/editor-core';
import type { Asset, Timeline } from '@framepilot/timeline-schema';
import { type UseEditor } from '../editor/useEditor.js';
import { createPlayheadClock, type PlayheadClock } from '../editor/playhead-clock.js';
import { timelineDuration } from '../editor/selectors.js';
import { PreviewPlayer } from './PreviewPlayer.js';
import { Tooltip } from './Tooltip.js';
import { ICON_SIZE, Pause, Play, SkipBack, SkipForward } from './icons.js';

/** Compact `m:ss` timecode for the shared scrubber readout. */
function fmtClock(seconds: number): string {
  const safe = Math.max(0, seconds);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * A read-only `UseEditor` over a caller-supplied `timeline` (a proposed edit's
 * `before` or `after` snapshot) for the review player to mount a real
 * `PreviewPlayer` against.
 *
 * Every mutator is an explicit no-op: this view must NEVER touch the real
 * project — Accept/Reject (wired in `EventNode`'s `DiffCard`) stay the ONLY
 * path that calls the real editor's `applyPatch`, per AGENTS.md's "every
 * operation is validated + applied through the one patch pipeline" invariant.
 * A shadow editor that quietly accepted a patch would violate that silently.
 *
 * The playhead is the one piece of state that must survive an A/B swap — the
 * reviewer scrubs to a moment, then holds "before" to compare the same moment —
 * so callers pass in a shared `PlayheadClock` (see `createPlayheadClock`)
 * instead of each shadow editor owning its own; `AiReviewPlayer` creates ONE
 * clock and reuses it across the before/after swap.
 *
 * `playing` is now a prop, not local state: side-by-side mode mounts two
 * `PreviewPlayer`s that must share ONE transport (see file header), so
 * `AiReviewPlayer` owns the single `playing` boolean and both shadow editors
 * read/write the same one.
 *
 * `followOnly` makes this editor a read-follow-only clock subscriber: its
 * `seek`/`seekTransient` never write `clock` (they stay no-ops), so it can be
 * mounted alongside a write-through "master" editor over the same clock
 * without the two fighting over `clock.set` every animation frame (see file
 * header's "clock master" note). `AiReviewPlayer` only sets this for the
 * BEFORE panel, and only while side-by-side layout is active.
 */
function useShadowEditor(
  timeline: Timeline,
  clock: PlayheadClock,
  playing: boolean,
  setPlaying: (next: boolean) => void,
  options: { readonly followOnly?: boolean } = {},
): UseEditor {
  const { followOnly = false } = options;
  const [playhead, setLocalPlayhead] = useState(clock.get());
  useEffect(() => clock.subscribe(() => setLocalPlayhead(clock.get())), [clock]);

  return useMemo<UseEditor>(
    () => ({
      state: {
        timeline,
        history: emptyHistory(),
        assets: [],
        folders: [],
        assetIds: [],
        issues: [],
        selection: null,
        selectedIds: [],
        playhead,
        pxPerSecond: 40,
        markers: [],
        transcript: [],
        playing,
      },
      // No-op: reviewing a proposed edit must never mutate the real project.
      applyPatch: () => {},
      // No-op (see `applyPatch`): nothing here validates against the real store.
      applyPatchChecked: (): readonly ValidationIssue[] => [],
      // No-op: undo/redo/jump only make sense against the real editor's history.
      undo: () => {},
      redo: () => {},
      goto: () => {},
      history: emptyHistory(),
      // No-op: selection belongs to the real timeline/canvas, not this preview.
      select: () => {},
      selectMany: () => {},
      clearSelection: () => {},
      // A follower never writes `clock` — see this function's doc comment.
      seek: (time: number) => {
        if (!followOnly) clock.set(Math.max(0, time));
      },
      seekTransient: (time: number) => {
        if (!followOnly) clock.set(Math.max(0, time));
      },
      getPlayhead: () => clock.get(),
      subscribePlayhead: (listener: () => void) => clock.subscribe(listener),
      // No-op: zoom/markers are timeline-editing chrome this read-only view skips.
      setZoom: () => {},
      toggleMarker: () => {},
      // Shared even for a follower: play/pause is ONE transport across both
      // panels (see file header) — only playhead WRITES are asymmetric.
      setPlaying: (next: boolean) => setPlaying(next),
      // No-op: nothing here ever registers new bin assets.
      registerAssets: () => {},
      replaceAuthoritativeProject: () => {},
      canUndo: false,
      canRedo: false,
    }),
    [timeline, playhead, playing, clock, followOnly, setPlaying],
  );
}

/** A/B compare mode: which timeline the mounted `PreviewPlayer` currently shows. */
type CompareMode = 'before' | 'after';

/**
 * Compare layout (see file header): `hold` is the original spring-loaded A/B
 * toggle over one mounted `PreviewPlayer`; `split` mounts both timelines'
 * `PreviewPlayer`s side by side over the same clock.
 */
type CompareLayout = 'hold' | 'split';

/** Key that spring-loads the "before" view while held (mirrors a common NLE convention). */
const BEFORE_KEY = 'b';

/**
 * Explicit allowlist of `ChangedRegion.kind`s this player can honestly preview
 * (all of them, today). Structured as an allowlist — not `true` — so a future
 * region kind that this A/B player can't represent 1:1 can flip the check
 * without touching every call site.
 */
const PREVIEWABLE_KINDS: ReadonlySet<ChangedRegion['kind']> = new Set([
  'added',
  'removed',
  'modified',
]);

function isPreviewableRegion(region: ChangedRegion): boolean {
  return PREVIEWABLE_KINDS.has(region.kind);
}

/** The region's timeline position to render as a scrubber tick: its `afterRange`, or
 *  `beforeRange` when the region was removed (no `afterRange` to anchor on). */
function regionTickStart(region: ChangedRegion): number {
  return (region.afterRange ?? region.beforeRange)!.start;
}

/** The changed region whose range contains `time`, if any (for the "Approximate" badge). */
function regionAtTime(regions: readonly ChangedRegion[], time: number): ChangedRegion | undefined {
  return regions.find((region) => {
    const range = region.afterRange ?? region.beforeRange;
    return range !== null && time >= range.start && time <= range.end;
  });
}

export interface AiReviewPlayerProps {
  readonly before: Timeline;
  readonly after: Timeline;
  readonly changedRegions: readonly ChangedRegion[];
  readonly assets: readonly Asset[];
  readonly fps: number;
  /**
   * Where the playhead should START — the moment the edit actually changes the
   * timeline, so preview begins ON the change rather than replaying the untouched
   * head of the video (product ask: "preview should start where the diff is").
   * Defaults to the first changed region. Updating it live (e.g. the reviewer
   * selects a different change in the popup) re-seeks the shared clock without a
   * costly player remount.
   */
  readonly startAt?: number;
}

/** Before/after review player for a proposed AI edit (see file header). */
export function AiReviewPlayer({
  before,
  after,
  changedRegions,
  assets,
  fps,
  startAt,
}: AiReviewPlayerProps): JSX.Element {
  const [mode, setMode] = useState<CompareMode>('after');
  const [layout, setLayout] = useState<CompareLayout>('hold');
  // ONE clock shared across the before/after swap (and, in split layout,
  // across both live-mounted panels) so the playhead survives it — see
  // `useShadowEditor`'s doc comment. It opens ON the first change (or the
  // caller-chosen `startAt`) so review begins where the edit lands.
  const [clock] = useState<PlayheadClock>(() =>
    createPlayheadClock(startAt ?? firstRegionStart(changedRegions)),
  );
  // Re-seek live when the caller points at a different change (popup op select).
  // A no-op on first render (clock already opened there); only a genuine change
  // moves the playhead, so it never fights the reviewer's own scrubbing.
  useEffect(() => {
    if (startAt !== undefined) clock.set(Math.max(0, startAt));
  }, [startAt, clock]);
  // Lifted so ONE transport drives both panels in split layout (see file
  // header + `useShadowEditor`'s doc comment) instead of each editor owning
  // its own play/pause flag.
  const [playing, setPlaying] = useState(false);
  // AFTER is always the write-through clock master. BEFORE is read-follow-only
  // ONLY while split layout has it mounted live alongside AFTER; in hold
  // layout it's the sole mounted panel while shown, so it stays writable.
  const afterEditor = useShadowEditor(after, clock, playing, setPlaying);
  const beforeEditor = useShadowEditor(before, clock, playing, setPlaying, {
    followOnly: layout === 'split',
  });
  const holdEditor = mode === 'before' ? beforeEditor : afterEditor;
  const duration = timelineDuration(after);
  const [playhead, setPlayhead] = useState(clock.get());
  useEffect(() => clock.subscribe(() => setPlayhead(clock.get())), [clock]);

  const showBefore = (): void => setMode('before');
  const showAfter = (): void => setMode('after');

  // Sorted change positions for the prev/next-change jump buttons + the scrubber
  // tick marks (the shared playhead's "where the edits are" cues).
  const regionStarts = useMemo(
    () => [...changedRegions].map(regionTickStart).sort((a, b) => a - b),
    [changedRegions],
  );
  const seekTo = (time: number): void => clock.set(Math.min(duration, Math.max(0, time)));
  const jumpNextChange = (): void => {
    const next = regionStarts.find((s) => s > playhead + 0.01);
    if (next !== undefined) seekTo(next);
  };
  const jumpPrevChange = (): void => {
    const prev = [...regionStarts].reverse().find((s) => s < playhead - 0.01);
    if (prev !== undefined) seekTo(prev);
  };

  // The shared, prominent playhead scrubber: ONE draggable position that drives
  // both the before and the after panel (they compare the SAME instant). Click or
  // drag anywhere on the track to seek; the change ticks sit on the same track.
  const scrubRef = useRef<HTMLDivElement>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const seekFromClientX = (clientX: number): void => {
    const el = scrubRef.current;
    if (!el || duration <= 0) return;
    const rect = el.getBoundingClientRect();
    seekTo(clamp01((clientX - rect.left) / rect.width) * duration);
  };
  const headPct = duration > 0 ? clamp01(playhead / duration) * 100 : 0;

  const allPreviewable = changedRegions.every(isPreviewableRegion);
  const currentRegion = regionAtTime(changedRegions, playhead);
  const isApproximate =
    currentRegion !== undefined &&
    currentRegion.beforeRange !== null &&
    currentRegion.afterRange !== null &&
    currentRegion.beforeRange.end - currentRegion.beforeRange.start !==
      currentRegion.afterRange.end - currentRegion.afterRange.start;

  return (
    <div className="ai-review-player">
      <div className="ai-review-toolbar">
        <div className="ai-review-layout-toggle" role="group" aria-label="Compare layout">
          <Tooltip label="One player — press and hold “Peek original” to flip to the original">
            <button
              type="button"
              className="ai-review-layout-btn"
              aria-pressed={layout === 'hold'}
              onClick={() => setLayout('hold')}
            >
              Overlay
            </button>
          </Tooltip>
          <Tooltip label="Show the original and the edited version at the same time">
            <button
              type="button"
              className="ai-review-layout-btn"
              aria-pressed={layout === 'split'}
              onClick={() => setLayout('split')}
            >
              Side by side
            </button>
          </Tooltip>
        </div>
        {layout === 'hold' && (
          <>
            <Tooltip label="Press and hold to see the original (before the edit)">
              <button
                type="button"
                className="ai-review-ab"
                aria-label="Peek original"
                onPointerDown={showBefore}
                onPointerUp={showAfter}
                onPointerLeave={showAfter}
                onKeyDown={(e) => {
                  if (e.key === BEFORE_KEY) showBefore();
                }}
                onKeyUp={(e) => {
                  if (e.key === BEFORE_KEY) showAfter();
                }}
              >
                Peek original
              </button>
            </Tooltip>
            <span className="ai-review-badge" aria-live="polite" data-mode={mode}>
              {mode === 'before' ? 'Before' : 'After'}
            </span>
          </>
        )}
        {!allPreviewable && (
          <span className="ai-review-badge ai-review-badge--warning">
            Some changes can&rsquo;t preview here
          </span>
        )}
        {isApproximate && (
          <span className="ai-review-badge ai-review-badge--approx">Approximate</span>
        )}
      </div>
      {layout === 'hold' ? (
        <PreviewPlayer editor={holdEditor} assets={assets} fps={fps} />
      ) : (
        <div className="ai-review-split">
          <div className="ai-review-side" data-side="before">
            <span className="ai-review-side-label" data-mode="before">
              Before
            </span>
            {/* Muted (audio) + read-follow-only clock (see `useShadowEditor`):
                AFTER is the sole write-through master + audible side. */}
            <PreviewPlayer editor={beforeEditor} assets={assets} fps={fps} muted />
          </div>
          <div className="ai-review-side" data-side="after">
            <span className="ai-review-side-label" data-mode="after">
              After
            </span>
            <PreviewPlayer editor={afterEditor} assets={assets} fps={fps} />
          </div>
        </div>
      )}
      {/* Shared control bar + prominent playhead scrubber (one transport drives
          BOTH panels; the per-panel PreviewPlayer transports are hidden in this
          context via CSS so there is exactly one, unambiguous playhead). */}
      <div className="ai-review-controls">
        <Tooltip label={playing ? 'Pause' : 'Play'}>
          <button
            type="button"
            className="ai-review-ctl ai-review-ctl--play"
            aria-label={playing ? 'Pause preview' : 'Play preview'}
            aria-pressed={playing}
            onClick={() => setPlaying(!playing)}
          >
            {playing ? (
              <Pause size={ICON_SIZE.md} aria-hidden="true" />
            ) : (
              <Play size={ICON_SIZE.md} aria-hidden="true" />
            )}
          </button>
        </Tooltip>
        <Tooltip label="Previous change">
          <button
            type="button"
            className="ai-review-ctl"
            aria-label="Jump to previous change"
            disabled={regionStarts.length === 0}
            onClick={jumpPrevChange}
          >
            <SkipBack size={ICON_SIZE.sm} aria-hidden="true" />
          </button>
        </Tooltip>
        <Tooltip label="Next change">
          <button
            type="button"
            className="ai-review-ctl"
            aria-label="Jump to next change"
            disabled={regionStarts.length === 0}
            onClick={jumpNextChange}
          >
            <SkipForward size={ICON_SIZE.sm} aria-hidden="true" />
          </button>
        </Tooltip>
        <div
          ref={scrubRef}
          className="ai-review-scrubber"
          role="slider"
          aria-label="Preview playhead"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(playhead)}
          tabIndex={0}
          data-scrubbing={scrubbing}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture?.(e.pointerId);
            setScrubbing(true);
            seekFromClientX(e.clientX);
          }}
          onPointerMove={(e) => {
            if (scrubbing) seekFromClientX(e.clientX);
          }}
          onPointerUp={() => setScrubbing(false)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') seekTo(playhead + 1 / fps);
            else if (e.key === 'ArrowLeft') seekTo(playhead - 1 / fps);
          }}
        >
          <div className="ai-review-scrubber-fill" style={{ width: `${headPct}%` }} />
          {changedRegions.map((region) => {
            const start = regionTickStart(region);
            const pct = duration > 0 ? (start / duration) * 100 : 0;
            return (
              <button
                key={`${region.trackId}:${region.clipId}`}
                type="button"
                className="ai-review-tick"
                data-kind={region.kind}
                style={{ left: `${pct}%` }}
                title={`${region.kind} — ${region.trackId}`}
                onClick={() => seekTo(start)}
              />
            );
          })}
          <div
            className="ai-review-scrubber-head"
            style={{ left: `${headPct}%` }}
            aria-hidden="true"
          />
        </div>
        <span className="ai-review-time">
          {fmtClock(playhead)} / {fmtClock(duration)}
        </span>
      </div>
    </div>
  );
}

/** The first changed region's start (prefer `afterRange`, else `beforeRange`), or 0. */
function firstRegionStart(regions: readonly ChangedRegion[]): number {
  const first = regions[0];
  if (!first) return 0;
  return (first.afterRange ?? first.beforeRange)?.start ?? 0;
}
