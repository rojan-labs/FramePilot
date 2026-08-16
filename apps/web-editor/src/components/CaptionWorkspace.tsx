/**
 * Performance-first caption workspace.
 *
 * The workspace keeps caption generation, review, timing, styling, and direct
 * cue editing synchronized through the editor's validated patch engine. Heavy
 * template browsing state is isolated from the virtualized transcript so hover
 * previews and filtering do not reconcile thousands of caption rows.
 */
import type { CaptionEmphasisAnalysis } from '@framepilot/ai-sdk';
import {
  autoEmphasisKeywords,
  resolveCaptionCue,
  type CaptionSegmentPresetName,
  type Patch,
} from '@framepilot/editor-core';
import type { CaptionStyle, Clip, TranscriptWord } from '@framepilot/timeline-schema';
import {
  CAPTION_FONT_CATALOG,
  DEFAULT_CAPTION_FONT_FAMILY,
  type CaptionFontCategory,
} from '@framepilot/timeline-schema/caption-fonts';
import {
  CAPTION_TEMPLATE_CATALOG,
  DEFAULT_CAPTION_TEMPLATE_ID,
  type CaptionTemplateCategory,
} from '@framepilot/timeline-schema/caption-templates';
import { Button, Input } from '@framepilot/ui';
import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual';
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import {
  GALLERY_LOOP_SECONDS,
  GALLERY_WORDS,
  captionLineCss,
  resolveCaptionStyle,
} from '../editor/captionPreview.js';
import {
  generateCaptionsPatch,
  highlightKeywords,
  keywordAccentStyle,
  parseKeywords,
  resolveGenerationConfig,
} from '../editor/captions.js';
import {
  deleteClipPatch,
  mergeCaptionCuesPatch,
  setCaptionCuePatch,
  setCaptionStylePatch,
  setTrackCaptionStylePatch,
  splitCaptionCuePatch,
  trimClipPatch,
} from '../editor/patch-builders.js';
import type { UseEditor } from '../editor/useEditor.js';
import { CaptionOverlay } from './CaptionOverlay.js';
import { Select } from './Select.js';
import { Slider } from './Slider.js';
import { Tooltip } from './Tooltip.js';
import './caption-workspace.css';
import { Combine, ICON_SIZE, Scissors, Search, Sparkles, Trash2 } from './icons.js';

export interface CaptionEditorProps {
  readonly editor: UseEditor;
  readonly transcript: readonly TranscriptWord[];
  /** Real provider-backed analyzer supplied by the editor host. */
  readonly analyzeEmphasis?: () => Promise<CaptionEmphasisAnalysis>;
}

type CaptionPosition = 'top' | 'center' | 'bottom';
type CaptionTemplateFilter = 'all' | CaptionTemplateCategory;
type StyleScope = 'selection' | 'track';

const CAPTION_COLORS = ['#ffffff', '#ffd84d', '#4dd0e1', '#ff6b6b'] as const;
const INITIAL_TEMPLATE_COUNT = 12;
const TEMPLATE_LOAD_STEP = 8;
const IDLE_GALLERY_TIME = 1.35;
// Review rows are deliberately fixed-height: virtual positioning and hover-only row actions must
// never overlap the next cue in the narrow editor rail when a transcript line wraps.
const CUE_ROW_ESTIMATE_PX = 84;
const CUE_LIST_VIEWPORT_PX = 520;
const CUE_LIST_OVERSCAN = 8;
const MIN_CAPTION_DURATION_SECONDS = 0.6;
const MAX_CAPTION_DURATION_SECONDS = 7;
const MAX_CAPTION_CHARS = 84;
const MAX_READING_CHARS_PER_SECOND = 20;
const NUDGE_SECONDS = 0.1;

const FONT_CATEGORIES: readonly { id: CaptionFontCategory; label: string }[] = [
  { id: 'sans', label: 'Sans serif' },
  { id: 'display', label: 'Display' },
  { id: 'serif', label: 'Serif' },
  { id: 'mono', label: 'Monospace' },
  { id: 'handwritten', label: 'Handwritten' },
];

const TEMPLATE_CATEGORIES: readonly { id: CaptionTemplateFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'one-word', label: 'One word' },
  { id: 'phrase', label: 'Phrase' },
  { id: 'karaoke', label: 'Karaoke' },
  { id: 'build', label: 'Build' },
  { id: 'boxed', label: 'Boxed' },
  { id: 'editorial', label: 'Editorial' },
  { id: 'aesthetic', label: 'Aesthetic' },
  { id: 'cinematic', label: 'Cinematic' },
];

const SEGMENT_CHOICES: readonly { id: 'auto' | CaptionSegmentPresetName; label: string }[] = [
  { id: 'auto', label: 'Match the template' },
  { id: 'short-form', label: 'Short & punchy' },
  { id: 'subtitle', label: 'Full subtitles' },
  { id: 'one-word', label: 'One word at a time' },
];

const observeCueViewport: typeof observeElementRect = (instance, callback) =>
  observeElementRect(instance, (rect) =>
    callback({ width: rect.width, height: rect.height || CUE_LIST_VIEWPORT_PX }),
  );

const toSchemaPosition = (position: CaptionPosition): NonNullable<CaptionStyle['position']> =>
  position === 'center' ? 'middle' : position;

const fromSchemaPosition = (position: CaptionStyle['position']): CaptionPosition =>
  position === 'middle' ? 'center' : (position ?? 'bottom');

function combineCaptionPatches(patches: readonly (Patch | null)[], reason: string): Patch | null {
  const valid = patches.filter((patch): patch is Patch => patch !== null);
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0] ?? null;
  const first = String(valid[0]?.patchId ?? 'first');
  const last = String(valid[valid.length - 1]?.patchId ?? 'last');
  return {
    patchId: `caption_batch_${first}_${last}` as Patch['patchId'],
    createdBy: 'user',
    reason,
    operations: valid.flatMap((patch) => patch.operations),
  };
}

/** Active cue in a non-overlapping, start-sorted caption lane, O(log n). */
export function activeCaptionIdAt(clips: readonly Clip[], time: number): string | null {
  let low = 0;
  let high = clips.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((clips[middle]?.start ?? Infinity) <= time) low = middle + 1;
    else high = middle;
  }
  const candidate = clips[low - 1];
  return candidate && time < candidate.end ? candidate.id : null;
}

function cueClock(seconds: number): string {
  const total = Math.max(0, seconds);
  const minutes = Math.floor(total / 60);
  const secs = total - minutes * 60;
  return `${minutes}:${secs.toFixed(2).padStart(5, '0')}`;
}

function templateBehavior(template: (typeof CAPTION_TEMPLATE_CATALOG)[number]): string {
  const display =
    template.style.display === 'active-word'
      ? 'Word by word'
      : template.style.display === 'cumulative'
        ? 'Builds on screen'
        : `${template.suggestedWordsPerLine} words per cue`;
  const entrance = template.style.animation?.in?.type;
  return entrance ? `${display}, ${entrance.replace('-', ' ')}` : display;
}

function captionWarnings(
  clip: Clip,
  text: string,
  previous: Clip | undefined,
  next: Clip | undefined,
): readonly string[] {
  const warnings: string[] = [];
  const duration = clip.end - clip.start;
  if (previous && clip.start < previous.end - 0.001) warnings.push('Overlaps the previous caption');
  if (next && clip.end > next.start + 0.001) warnings.push('Overlaps the next caption');
  if (duration < MIN_CAPTION_DURATION_SECONDS) warnings.push('Very short reading time');
  if (duration > MAX_CAPTION_DURATION_SECONDS) warnings.push('Stays on screen for a long time');
  if (text.length > MAX_CAPTION_CHARS) warnings.push('Contains a lot of text');
  if (duration > 0 && text.length / duration > MAX_READING_CHARS_PER_SECOND) {
    warnings.push('May be difficult to read in time');
  }
  return warnings;
}

function CaptionFontPicker({
  id,
  value,
  disabled = false,
  onChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly disabled?: boolean;
  readonly onChange: (family: string) => void;
}): JSX.Element {
  const label =
    id === 'caption-track-font-family' ? 'Font for all captions' : 'Font for selected cue';
  return (
    <Select
      id={id}
      label={label}
      value={value}
      disabled={disabled}
      options={CAPTION_FONT_CATALOG.map((font) => ({
        value: font.family,
        label: font.family,
        hint:
          FONT_CATEGORIES.find((category) => category.id === font.category)?.label ?? font.category,
      }))}
      onChange={onChange}
    />
  );
}

function useGalleryClock(active: boolean): number {
  const [time, setTime] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    let frame = 0;
    let last = -1;
    const origin = performance.now();
    const tick = (now: number): void => {
      const next = ((now - origin) / 1000) % GALLERY_LOOP_SECONDS;
      const quantized = Math.floor(next * 30) / 30;
      if (quantized !== last) {
        last = quantized;
        setTime(quantized);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active]);
  return time;
}

function useOnScreen(ref: RefObject<HTMLElement | null>): boolean {
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      setOnScreen(entries.some((entry) => entry.isIntersecting));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return onScreen;
}

function CaptionTemplatePreview({
  templateId,
  active,
  onScreen,
}: {
  readonly templateId: string;
  readonly active: boolean;
  readonly onScreen: boolean;
}): JSX.Element {
  const time = useGalleryClock(active && onScreen);
  return (
    <CaptionOverlay
      style={{ templateId }}
      lines={[GALLERY_WORDS]}
      time={active ? time : IDLE_GALLERY_TIME}
      fontSize="clamp(10px, 4cqi, 13px)"
    />
  );
}

const CaptionTemplateTile = memo(function CaptionTemplateTile({
  template,
  selected,
  galleryOnScreen,
  onSelect,
}: {
  readonly template: (typeof CAPTION_TEMPLATE_CATALOG)[number];
  readonly selected: boolean;
  readonly galleryOnScreen: boolean;
  readonly onSelect: (id: string) => void;
}): JSX.Element {
  const [active, setActive] = useState(false);
  return (
    <button
      type="button"
      className={`caption-template${selected ? ' is-active' : ''}`}
      aria-pressed={selected}
      aria-label={`${template.label}. ${templateBehavior(template)}.`}
      title={`${template.label}: ${templateBehavior(template)}`}
      onMouseEnter={() => setActive(true)}
      onMouseLeave={() => setActive(false)}
      onFocus={() => setActive(true)}
      onBlur={() => setActive(false)}
      onClick={() => onSelect(template.id)}
    >
      <span className="caption-template-tile" aria-hidden="true">
        <CaptionTemplatePreview
          templateId={template.id}
          active={active}
          onScreen={galleryOnScreen}
        />
      </span>
      <span className="caption-template-copy">
        <span className="caption-template-label">{template.label}</span>
      </span>
    </button>
  );
});

function CaptionTemplateBrowser({
  templateId,
  onSelect,
}: {
  readonly templateId: string;
  readonly onSelect: (id: string) => void;
}): JSX.Element {
  const [category, setCategory] = useState<CaptionTemplateFilter>('all');
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(INITIAL_TEMPLATE_COUNT);
  const deferredQuery = useDeferredValue(query);
  const galleryRef = useRef<HTMLDivElement | null>(null);
  const previousTemplateIdRef = useRef(templateId);
  const galleryOnScreen = useOnScreen(galleryRef);

  useEffect(() => {
    if (previousTemplateIdRef.current === templateId) return;
    previousTemplateIdRef.current = templateId;
    const selectedTemplate = CAPTION_TEMPLATE_CATALOG.find(
      (template) => template.id === templateId,
    );
    if (selectedTemplate) setCategory(selectedTemplate.category);
  }, [templateId]);

  const templates = useMemo(() => {
    const needle = deferredQuery.trim().toLocaleLowerCase();
    return CAPTION_TEMPLATE_CATALOG.filter((template) => {
      if (category !== 'all' && template.category !== category) return false;
      if (needle === '') return true;
      return `${template.label} ${template.category} ${templateBehavior(template)}`
        .toLocaleLowerCase()
        .includes(needle);
    });
  }, [category, deferredQuery]);

  useEffect(() => setVisibleCount(INITIAL_TEMPLATE_COUNT), [category, deferredQuery]);

  return (
    <div className="caption-template-browser">
      <Input
        uiSize="sm"
        type="search"
        name="caption-style-search"
        autoComplete="off"
        aria-label="Search caption styles"
        placeholder="Search caption styles…"
        icon={<Search size={ICON_SIZE.sm} aria-hidden="true" />}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div
        className="caption-template-tabs fx-filters"
        role="group"
        aria-label="caption style categories"
        onWheel={(event) => {
          const strip = event.currentTarget;
          if (strip.scrollWidth <= strip.clientWidth) return;
          if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
          strip.scrollLeft += event.deltaY;
        }}
      >
        {TEMPLATE_CATEGORIES.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`fx-filter${category === tab.id ? ' is-active' : ''}`}
            aria-pressed={category === tab.id}
            onClick={() => setCategory(tab.id)}
          >
            {tab.label}
            <span className="fx-filter-count">
              {tab.id === 'all'
                ? CAPTION_TEMPLATE_CATALOG.length
                : CAPTION_TEMPLATE_CATALOG.filter((template) => template.category === tab.id)
                    .length}
            </span>
          </button>
        ))}
      </div>
      <div ref={galleryRef} className="caption-templates" role="group" aria-label="caption styles">
        {templates.slice(0, visibleCount).map((template) => (
          <CaptionTemplateTile
            key={template.id}
            template={template}
            selected={templateId === template.id}
            galleryOnScreen={galleryOnScreen}
            onSelect={onSelect}
          />
        ))}
        {templates.length === 0 && (
          <div className="caption-template-empty" role="status">
            <p>No caption styles match “{query.trim()}”.</p>
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setCategory('all');
              }}
            >
              Clear filters
            </button>
          </div>
        )}
      </div>
      {visibleCount < templates.length && (
        <button
          type="button"
          className="caption-load-more"
          onClick={() => setVisibleCount((count) => count + TEMPLATE_LOAD_STEP)}
        >
          Load 8 more
        </button>
      )}
    </div>
  );
}

interface CueRowProps {
  readonly clip: Clip;
  readonly text: string;
  readonly active: boolean;
  readonly selected: boolean;
  readonly keywords: readonly string[];
  readonly style: CSSProperties;
  readonly warningCount: number;
  readonly onSeek: () => void;
  readonly onSelect: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly onToggleSelection: () => void;
  readonly onCommit: (next: string) => void;
  readonly onSplit: () => void;
  readonly onMerge: () => void;
  readonly onDelete: () => void;
  readonly canMerge: boolean;
  readonly position: number;
  readonly total: number;
  readonly measureElement: (node: Element | null) => void;
  readonly virtualStart: number;
}

const CueRow = memo(function CueRow({
  clip,
  text,
  active,
  selected,
  keywords,
  style,
  warningCount,
  onSeek,
  onSelect,
  onToggleSelection,
  onCommit,
  onSplit,
  onMerge,
  onDelete,
  canMerge,
  position,
  total,
  measureElement,
  virtualStart,
}: CueRowProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);

  useEffect(() => {
    if (!editing) setDraft(text);
  }, [editing, text]);

  const commit = (): void => {
    setEditing(false);
    if (draft !== text) onCommit(draft);
  };

  return (
    <li
      ref={measureElement}
      data-index={position - 1}
      className={`cue-row caption-workspace-row${active ? ' is-active' : ''}${selected ? ' is-selected' : ''}`}
      data-testid="caption-cue-row"
      aria-posinset={position}
      aria-setsize={total}
      style={{
        position: 'absolute',
        insetInline: 0,
        top: 0,
        transform: `translateY(${virtualStart}px)`,
      }}
    >
      <label className="caption-row-select">
        <input
          type="checkbox"
          checked={selected}
          aria-label={`Select caption at ${cueClock(clip.start)}`}
          onChange={onToggleSelection}
        />
      </label>
      <button
        type="button"
        className="cue-time tabular"
        aria-label={`Seek to ${cueClock(clip.start)}`}
        onClick={() => {
          onSeek();
        }}
      >
        <span>{cueClock(clip.start)}</span>
        <span className="caption-row-duration">{(clip.end - clip.start).toFixed(2)}s</span>
      </button>

      {editing ? (
        <textarea
          className="cue-input"
          aria-label={`Caption text at ${cueClock(clip.start)}`}
          value={draft}
          rows={Math.max(1, draft.split('\n').length)}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              setDraft(text);
              setEditing(false);
            }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              commit();
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="cue-text"
          style={style}
          aria-label={`Edit caption "${text}"`}
          onClick={(event) => {
            onSelect(event);
            if (!event.shiftKey && !event.metaKey && !event.ctrlKey) setEditing(true);
          }}
        >
          {text === '' ? (
            <span className="cue-blank">Empty caption</span>
          ) : (
            text.split('\n').map((line, lineIndex) => (
              <span key={lineIndex} className="cue-text-line">
                {highlightKeywords(line, keywords).map((segment, segmentIndex) => (
                  <span
                    key={`${segment.text}-${segmentIndex}`}
                    data-highlight={segment.highlight}
                    className={segment.highlight ? 'kw' : undefined}
                  >
                    {segment.text}{' '}
                  </span>
                ))}
              </span>
            ))
          )}
          {warningCount > 0 && (
            <span className="caption-row-warning" aria-label={`${warningCount} review warnings`}>
              {warningCount}
            </span>
          )}
        </button>
      )}

      <div className="cue-actions">
        <Tooltip label="Split at the playhead" placement="left">
          <button
            type="button"
            aria-label={`Split caption at ${cueClock(clip.start)}`}
            onClick={onSplit}
          >
            <Scissors size={ICON_SIZE.sm} aria-hidden="true" />
          </button>
        </Tooltip>
        <Tooltip
          label={canMerge ? 'Merge with the next caption' : 'Nothing to merge with'}
          placement="left"
        >
          <button
            type="button"
            aria-label={`Merge caption at ${cueClock(clip.start)} with the next`}
            disabled={!canMerge}
            onClick={onMerge}
          >
            <Combine size={ICON_SIZE.sm} aria-hidden="true" />
          </button>
        </Tooltip>
        <Tooltip label="Delete" placement="left">
          <button
            type="button"
            aria-label={`Delete caption at ${cueClock(clip.start)}`}
            onClick={onDelete}
          >
            <Trash2 size={ICON_SIZE.sm} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
    </li>
  );
});

function CaptionTimingEditor({
  clip,
  text,
  previous,
  next,
  selectionCount,
  onCommit,
  onNudge,
}: {
  readonly clip: Clip;
  readonly text: string;
  readonly previous: Clip | undefined;
  readonly next: Clip | undefined;
  readonly selectionCount: number;
  readonly onCommit: (start: number, end: number) => void;
  readonly onNudge: (delta: number) => void;
}): JSX.Element {
  const [startDraft, setStartDraft] = useState(String(clip.start.toFixed(3)));
  const [endDraft, setEndDraft] = useState(String(clip.end.toFixed(3)));

  useEffect(() => {
    setStartDraft(String(clip.start.toFixed(3)));
    setEndDraft(String(clip.end.toFixed(3)));
  }, [clip.end, clip.id, clip.start]);

  const commit = (): void => {
    const start = Number(startDraft);
    const end = Number(endDraft);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      setStartDraft(String(clip.start.toFixed(3)));
      setEndDraft(String(clip.end.toFixed(3)));
      return;
    }
    onCommit(start, end);
  };

  const warnings = captionWarnings(clip, text, previous, next);

  return (
    <div className="caption-timing-card" aria-label="selected caption timing">
      <div className="caption-card-head">
        <div>
          <strong>Timing</strong>
          <span>
            {selectionCount > 1
              ? `${selectionCount} captions selected. Fields edit the primary caption.`
              : 'Precise start and end for the selected caption.'}
          </span>
        </div>
        <div className="caption-nudge-actions" aria-label="Move selected captions">
          <button type="button" onClick={() => onNudge(-NUDGE_SECONDS)}>
            −0.1s
          </button>
          <button type="button" onClick={() => onNudge(NUDGE_SECONDS)}>
            +0.1s
          </button>
        </div>
      </div>
      <div className="caption-timing-fields">
        <label>
          <span>Start</span>
          <input
            type="number"
            step="0.001"
            min="0"
            aria-label="Caption start time"
            value={startDraft}
            onChange={(event) => setStartDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') {
                setStartDraft(String(clip.start.toFixed(3)));
                event.currentTarget.blur();
              }
            }}
          />
        </label>
        <label>
          <span>End</span>
          <input
            type="number"
            step="0.001"
            min="0"
            aria-label="Caption end time"
            value={endDraft}
            onChange={(event) => setEndDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') {
                setEndDraft(String(clip.end.toFixed(3)));
                event.currentTarget.blur();
              }
            }}
          />
        </label>
        <output className="caption-duration-readout">{(clip.end - clip.start).toFixed(2)}s</output>
      </div>
      {warnings.length > 0 ? (
        <ul className="caption-review-warnings" aria-label="Caption review warnings">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : (
        <p className="caption-review-clear">Timing and reading pace look comfortable.</p>
      )}
    </div>
  );
}

function CaptionCueWorkspace({
  editor,
  captionClips,
  transcript,
  trackStyle,
  keywords,
  searchRef,
  apply,
}: {
  readonly editor: UseEditor;
  readonly captionClips: readonly Clip[];
  readonly transcript: readonly TranscriptWord[];
  readonly trackStyle: CaptionStyle | undefined;
  readonly keywords: readonly string[];
  readonly searchRef: RefObject<HTMLInputElement | null>;
  readonly apply: (patch: Patch | null) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [followPlayback, setFollowPlayback] = useState(true);
  const deferredQuery = useDeferredValue(query);
  const selectionAnchorRef = useRef<string | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const filteredClips = useMemo(() => {
    const needle = deferredQuery.trim().toLocaleLowerCase();
    if (needle === '') return captionClips;
    return captionClips.filter((clip) =>
      resolveCaptionCue(clip, transcript).text.toLocaleLowerCase().includes(needle),
    );
  }, [captionClips, deferredQuery, transcript]);

  const captionIdSet = useMemo(() => new Set(captionClips.map((clip) => clip.id)), [captionClips]);
  const selectedIds = useMemo(
    () => editor.state.selectedIds.filter((id) => captionIdSet.has(id)),
    [captionIdSet, editor.state.selectedIds],
  );
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const primaryClip = captionClips.find((clip) => clip.id === editor.state.selection) ?? null;
  const primaryIndex = primaryClip
    ? captionClips.findIndex((clip) => clip.id === primaryClip.id)
    : -1;
  const primaryText = primaryClip ? resolveCaptionCue(primaryClip, transcript).text : '';

  const getActiveCaptionId = useCallback(
    () => activeCaptionIdAt(captionClips, editor.getPlayhead()),
    [captionClips, editor.getPlayhead],
  );
  const activeCaptionId = useSyncExternalStore(
    editor.subscribePlayhead,
    getActiveCaptionId,
    getActiveCaptionId,
  );

  const virtualizer = useVirtualizer({
    count: filteredClips.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => CUE_ROW_ESTIMATE_PX,
    getItemKey: (index) => filteredClips[index]?.id ?? index,
    overscan: CUE_LIST_OVERSCAN,
    observeElementRect: observeCueViewport,
    initialRect: { width: 320, height: CUE_LIST_VIEWPORT_PX },
  });
  const measureCueElement = useCallback(
    (node: Element | null): void => {
      if (node && node.getBoundingClientRect().height > 0) virtualizer.measureElement(node);
    },
    [virtualizer],
  );
  const activeIndexById = useMemo(
    () => new Map(filteredClips.map((clip, index) => [clip.id, index] as const)),
    [filteredClips],
  );
  const fullIndexById = useMemo(
    () => new Map(captionClips.map((clip, index) => [clip.id, index] as const)),
    [captionClips],
  );

  useEffect(() => {
    if (!followPlayback || activeCaptionId === null) return;
    const index = activeIndexById.get(activeCaptionId);
    if (index !== undefined) virtualizer.scrollToIndex(index, { align: 'auto' });
  }, [activeCaptionId, activeIndexById, followPlayback, virtualizer]);

  const selectCue = (clip: Clip, event: ReactMouseEvent<HTMLButtonElement>): void => {
    if (event.shiftKey && selectionAnchorRef.current) {
      const anchorIndex = captionClips.findIndex(
        (candidate) => candidate.id === selectionAnchorRef.current,
      );
      const targetIndex = captionClips.findIndex((candidate) => candidate.id === clip.id);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const start = Math.min(anchorIndex, targetIndex);
        const end = Math.max(anchorIndex, targetIndex);
        editor.selectMany(captionClips.slice(start, end + 1).map((candidate) => candidate.id));
      }
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      editor.select(clip.id, 'toggle');
      selectionAnchorRef.current = clip.id;
      return;
    }
    editor.select(clip.id);
    selectionAnchorRef.current = clip.id;
    editor.seek(clip.start);
  };

  const toggleCue = (clip: Clip): void => {
    editor.select(clip.id, 'toggle');
    selectionAnchorRef.current = clip.id;
  };

  const selectAllFiltered = (): void => {
    editor.selectMany(filteredClips.map((clip) => clip.id));
    selectionAnchorRef.current = filteredClips[0]?.id ?? null;
  };

  const deleteSelected = (): void => {
    const clips = captionClips
      .filter((clip) => selectedSet.has(clip.id))
      .sort((a, b) => b.start - a.start);
    apply(
      combineCaptionPatches(
        clips.map((clip) => deleteClipPatch(editor.state.timeline, clip.id)),
        `Delete ${clips.length} selected captions`,
      ),
    );
  };

  const nudgeSelected = (delta: number): void => {
    const targets = captionClips
      .filter((clip) => selectedSet.has(clip.id))
      .sort((a, b) => (delta > 0 ? b.start - a.start : a.start - b.start));
    apply(
      combineCaptionPatches(
        targets.map((clip) =>
          trimClipPatch(
            editor.state.timeline,
            clip.id,
            Math.max(0, clip.start + delta),
            Math.max(0, clip.end + delta),
          ),
        ),
        `Move ${targets.length} captions by ${delta}s`,
      ),
    );
  };

  const returnToCurrent = (): void => {
    setFollowPlayback(true);
    if (activeCaptionId === null) return;
    const index = activeIndexById.get(activeCaptionId);
    if (index !== undefined) virtualizer.scrollToIndex(index, { align: 'center' });
  };

  return (
    <div className="caption-review-workspace">
      <div className="caption-search-row">
        <Input
          ref={searchRef}
          uiSize="sm"
          type="search"
          name="caption-search"
          autoComplete="off"
          aria-label="Search captions"
          placeholder="Search transcript…"
          icon={<Search size={ICON_SIZE.sm} aria-hidden="true" />}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="caption-result-count" aria-live="polite">
          {filteredClips.length} of {captionClips.length}
        </span>
      </div>

      <div className="caption-selection-bar" aria-label="Caption selection actions">
        <div>
          <strong>
            {selectedIds.length > 0
              ? `${selectedIds.length} selected`
              : activeCaptionId
                ? 'Following playback'
                : 'No caption selected'}
          </strong>
          <span>Shift selects a range. Ctrl or ⌘ toggles a cue.</span>
        </div>
        <div className="caption-selection-actions">
          <button type="button" disabled={filteredClips.length === 0} onClick={selectAllFiltered}>
            Select all
          </button>
          <button
            type="button"
            disabled={selectedIds.length === 0}
            onClick={() => editor.clearSelection()}
          >
            Clear
          </button>
          <button
            type="button"
            className="caption-danger-action"
            disabled={selectedIds.length === 0}
            onClick={deleteSelected}
          >
            Delete selected
          </button>
        </div>
      </div>

      {primaryClip && (
        <CaptionTimingEditor
          clip={primaryClip}
          text={primaryText}
          previous={captionClips[primaryIndex - 1]}
          next={captionClips[primaryIndex + 1]}
          selectionCount={selectedIds.length}
          onCommit={(start, end) =>
            apply(trimClipPatch(editor.state.timeline, primaryClip.id, start, end))
          }
          onNudge={nudgeSelected}
        />
      )}

      {!followPlayback && activeCaptionId && (
        <button type="button" className="caption-return-current" onClick={returnToCurrent}>
          Return to current caption
        </button>
      )}

      {filteredClips.length > 0 ? (
        <div
          ref={viewportRef}
          className="cue-list-viewport caption-cue-viewport"
          onWheelCapture={() => setFollowPlayback(false)}
          onPointerDownCapture={() => setFollowPlayback(false)}
          onTouchStartCapture={() => setFollowPlayback(false)}
        >
          <ol
            className="cue-list cue-list--virtual"
            aria-label="caption clips"
            style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const index = virtualRow.index;
              const clip = filteredClips[index];
              if (!clip) return null;
              const fullIndex = fullIndexById.get(clip.id) ?? -1;
              const previous = captionClips[fullIndex - 1];
              const next = captionClips[fullIndex + 1];
              const cue = resolveCaptionCue(clip, transcript);
              const resolved = resolveCaptionStyle(clip.captionStyle, trackStyle);
              const rowStyle: CSSProperties = {
                ...captionLineCss(resolved),
                fontSize: `${(1.05 * (resolved.fontScale ?? 1)).toFixed(2)}rem`,
              };
              const warnings = captionWarnings(clip, cue.text, previous, next);
              return (
                <CueRow
                  key={clip.id}
                  clip={clip}
                  text={cue.text}
                  active={clip.id === activeCaptionId}
                  selected={selectedSet.has(clip.id)}
                  keywords={keywords}
                  style={rowStyle}
                  warningCount={warnings.length}
                  canMerge={next !== undefined}
                  onSeek={() => {
                    editor.seek(clip.start);
                    editor.select(clip.id);
                    selectionAnchorRef.current = clip.id;
                  }}
                  onSelect={(event) => selectCue(clip, event)}
                  onToggleSelection={() => toggleCue(clip)}
                  onCommit={(text) =>
                    apply(setCaptionCuePatch(editor.state.timeline, clip.id, text, transcript))
                  }
                  onSplit={() =>
                    apply(
                      splitCaptionCuePatch(
                        editor.state.timeline,
                        clip.id,
                        editor.getPlayhead(),
                        transcript,
                      ),
                    )
                  }
                  onMerge={() =>
                    next &&
                    apply(
                      mergeCaptionCuesPatch(editor.state.timeline, clip.id, next.id, transcript),
                    )
                  }
                  onDelete={() => apply(deleteClipPatch(editor.state.timeline, clip.id))}
                  position={index + 1}
                  total={filteredClips.length}
                  measureElement={measureCueElement}
                  virtualStart={virtualRow.start}
                />
              );
            })}
          </ol>
        </div>
      ) : query.trim() !== '' ? (
        <div className="caption-empty-search" role="status">
          <strong>No captions match “{query.trim()}”.</strong>
          <button type="button" onClick={() => setQuery('')}>
            Clear search
          </button>
        </div>
      ) : (
        <p className="panel-empty">No captions have been generated yet.</p>
      )}
    </div>
  );
}

export function CaptionWorkspace({
  editor,
  transcript,
  analyzeEmphasis,
}: CaptionEditorProps): JSX.Element {
  const [templateId, setTemplateId] = useState(DEFAULT_CAPTION_TEMPLATE_ID);
  const [segmentChoice, setSegmentChoice] = useState<'auto' | CaptionSegmentPresetName>('auto');
  const [keywordInput, setKeywordInput] = useState('');
  const [autoEmphasis, setAutoEmphasis] = useState(true);
  const [autoKeywords, setAutoKeywords] = useState<readonly string[] | null>(null);
  const [emphasisStatus, setEmphasisStatus] = useState<'idle' | 'analyzing' | 'ai' | 'fallback'>(
    'idle',
  );
  const [overrides, setOverrides] = useState<Partial<CaptionStyle>>({});
  const [styleScope, setStyleScope] = useState<StyleScope>('selection');
  const [operationError, setOperationError] = useState<string | null>(null);

  const captionSearchRef = useRef<HTMLInputElement | null>(null);
  const reviewSectionRef = useRef<HTMLDivElement | null>(null);
  const styleSectionRef = useRef<HTMLDivElement | null>(null);
  const generateSectionRef = useRef<HTMLDivElement | null>(null);

  const { selection, selectedIds, timeline } = editor.state;
  const captionTrack = timeline.tracks.find((track) => track.type === 'caption');
  const captionClips = useMemo(
    () => [...(captionTrack?.clips ?? [])].sort((a, b) => a.start - b.start),
    [captionTrack],
  );
  const captionCount = captionClips.length;
  const trackStyle = captionTrack?.captionStyle;
  const selectedCaptionIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedCaptionClips = useMemo(
    () => captionClips.filter((clip) => selectedCaptionIdSet.has(clip.id)),
    [captionClips, selectedCaptionIdSet],
  );
  const selectedCaptionClip = captionClips.find((clip) => clip.id === selection) ?? null;
  const styleTargets =
    selectedCaptionClips.length > 0
      ? selectedCaptionClips
      : selectedCaptionClip
        ? [selectedCaptionClip]
        : [];

  const suggestedKeywords = useMemo(() => autoEmphasisKeywords(transcript), [transcript]);
  const localEmphasis = useMemo<CaptionEmphasisAnalysis>(
    () => ({ keywords: suggestedKeywords, source: 'fallback' }),
    [suggestedKeywords],
  );
  const manualKeywords = useMemo(() => parseKeywords(keywordInput), [keywordInput]);
  const keywords = autoEmphasis ? (autoKeywords ?? suggestedKeywords) : manualKeywords;

  useEffect(() => {
    setAutoKeywords(null);
    setEmphasisStatus('idle');
  }, [transcript]);

  useEffect(() => {
    if (!selectedCaptionClip) return;
    const { templateId: clipTemplateId, ...clipOverrides } = selectedCaptionClip.captionStyle ?? {};
    setOverrides(clipOverrides);
    if (clipTemplateId !== undefined) setTemplateId(clipTemplateId);
  }, [selectedCaptionClip?.id]);

  useEffect(() => {
    // Undoing the first track-level style removes `captionStyle` entirely. Reset local preview
    // state too; otherwise the gallery keeps showing the undone template as active.
    setTemplateId(trackStyle?.templateId ?? DEFAULT_CAPTION_TEMPLATE_ID);
  }, [trackStyle?.templateId]);

  const persistedKeywordInput =
    trackStyle?.accent?.mode === 'keywords' ? (trackStyle.accent.keywords ?? []).join(', ') : '';
  useEffect(() => {
    setKeywordInput(persistedKeywordInput);
    if (persistedKeywordInput === '') return;
    const persisted = parseKeywords(persistedKeywordInput);
    const matchesAuto =
      autoKeywords !== null &&
      persisted.length === autoKeywords.length &&
      persisted.every((word, index) => word === autoKeywords[index]);
    setAutoEmphasis(matchesAuto);
  }, [autoKeywords, persistedKeywordInput]);

  const generationOptions = useMemo(
    () => ({
      templateId,
      ...(segmentChoice === 'auto' ? {} : { preset: segmentChoice }),
      keywords,
    }),
    [keywords, segmentChoice, templateId],
  );
  const config = useMemo(() => resolveGenerationConfig(generationOptions), [generationOptions]);

  const apply = useCallback(
    (patch: Patch | null): void => {
      if (!patch) return;
      const issues = editor.applyPatchChecked(patch);
      setOperationError(issues[0]?.message ?? null);
    },
    [editor.applyPatchChecked],
  );

  const previewCues = useMemo(() => {
    if (captionCount > 0 || transcript.length === 0) return [];
    const patch = generateCaptionsPatch(timeline, transcript, '__preview__', generationOptions);
    return (patch?.operations ?? [])
      .filter(
        (operation): operation is Extract<typeof operation, { type: 'set_caption_cue' }> =>
          operation.type === 'set_caption_cue',
      )
      .map((operation) => operation.captionCue?.text ?? '');
  }, [captionCount, generationOptions, timeline, transcript]);

  const generateWithKeywords = (nextKeywords: readonly string[]): void => {
    if (!captionTrack) return;
    apply(
      generateCaptionsPatch(timeline, transcript, captionTrack.id, {
        ...generationOptions,
        keywords: nextKeywords,
      }),
    );
  };

  const generate = (): void => {
    if (!autoEmphasis || !analyzeEmphasis || autoKeywords !== null) {
      generateWithKeywords(keywords);
      return;
    }
    setEmphasisStatus('analyzing');
    void analyzeEmphasis()
      .catch(() => localEmphasis)
      .then((result) => {
        setAutoKeywords(result.keywords);
        setKeywordInput(result.keywords.join(', '));
        setEmphasisStatus(result.source);
        generateWithKeywords(result.keywords);
      });
  };

  const selectTemplate = useCallback(
    (id: string): void => {
      setTemplateId(id);
      setOverrides({});
      if (!captionTrack) return;
      const accent = keywordAccentStyle(id, keywords);
      const { accent: _currentAccent, ...styleWithoutAccent } = trackStyle ?? {};
      apply(
        setTrackCaptionStylePatch(timeline, captionTrack.id, {
          ...styleWithoutAccent,
          templateId: id,
          ...(accent ? { accent } : {}),
        }),
      );
    },
    [apply, captionTrack, keywords, timeline, trackStyle],
  );

  const commitKeywords = (): void => {
    const nextKeywords = parseKeywords(keywordInput);
    setAutoEmphasis(false);
    setKeywordInput(nextKeywords.join(', '));
    if (!captionTrack) return;
    const accent = keywordAccentStyle(templateId, nextKeywords);
    const { accent: _currentAccent, ...styleWithoutAccent } = trackStyle ?? {};
    apply(
      setTrackCaptionStylePatch(timeline, captionTrack.id, {
        ...styleWithoutAccent,
        templateId,
        ...(accent ? { accent } : {}),
      }),
    );
  };

  const commitAutoEmphasis = (result: CaptionEmphasisAnalysis): void => {
    setAutoEmphasis(true);
    setAutoKeywords(result.keywords);
    setKeywordInput(result.keywords.join(', '));
    setEmphasisStatus(result.source);
    if (!captionTrack || result.keywords.length === 0) return;
    const accent = keywordAccentStyle(templateId, result.keywords);
    const { accent: _currentAccent, ...styleWithoutAccent } = trackStyle ?? {};
    apply(
      setTrackCaptionStylePatch(timeline, captionTrack.id, {
        ...styleWithoutAccent,
        templateId,
        ...(accent ? { accent } : {}),
      }),
    );
  };

  const applyAutoEmphasis = (): void => {
    if (!analyzeEmphasis) {
      commitAutoEmphasis(localEmphasis);
      return;
    }
    setEmphasisStatus('analyzing');
    void analyzeEmphasis()
      .catch(() => localEmphasis)
      .then(commitAutoEmphasis);
  };

  const resolvedCurrent = useMemo(
    () => resolveCaptionStyle({ templateId, ...overrides }, trackStyle),
    [overrides, templateId, trackStyle],
  );
  const fontScale = overrides.fontScale ?? resolvedCurrent.fontScale ?? 1;
  const color = (overrides.textColor ??
    resolvedCurrent.textColor ??
    CAPTION_COLORS[0]) as (typeof CAPTION_COLORS)[number];
  const position = fromSchemaPosition(overrides.position ?? resolvedCurrent.position);
  const trackFont =
    resolveCaptionStyle(undefined, trackStyle).fontFamily ?? DEFAULT_CAPTION_FONT_FAMILY;
  const hasCaptionSelection = styleTargets.length > 0;
  const hasMixedStyles =
    selectedCaptionClips.length > 1 &&
    new Set(selectedCaptionClips.map((clip) => JSON.stringify(clip.captionStyle ?? {}))).size > 1;

  const previewOverride = (patch: Partial<CaptionStyle>): void => {
    setOverrides((current) => ({ ...current, ...patch }));
  };

  const commitStyleChange = (patch: Partial<CaptionStyle>): void => {
    setOverrides((current) => ({ ...current, ...patch }));
    if (!captionTrack) return;
    if (styleScope === 'track') {
      apply(
        setTrackCaptionStylePatch(timeline, captionTrack.id, {
          ...(trackStyle ?? {}),
          templateId,
          ...patch,
        }),
      );
      return;
    }
    apply(
      combineCaptionPatches(
        styleTargets.map((clip) =>
          setCaptionStylePatch(timeline, clip.id, {
            ...(clip.captionStyle ?? {}),
            ...patch,
          }),
        ),
        `Style ${styleTargets.length} selected captions`,
      ),
    );
  };

  const applyTrackFont = (fontFamily: string): void => {
    if (!captionTrack) return;
    apply(
      setTrackCaptionStylePatch(timeline, captionTrack.id, {
        ...(trackStyle ?? {}),
        templateId,
        fontFamily,
      }),
    );
  };

  const scrollTo = (ref: RefObject<HTMLDivElement | null>): void => {
    ref.current?.scrollIntoView({ block: 'start' });
  };

  return (
    <section
      className="captions caption-workspace"
      aria-label="caption editor"
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        const editingText = target.matches('input, textarea, [contenteditable="true"]');
        if (event.key === '/' && !editingText) {
          event.preventDefault();
          captionSearchRef.current?.focus();
        }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !editingText) {
          event.preventDefault();
          generate();
        }
      }}
    >
      <header className="caption-workspace-header">
        <div>
          <span className="caption-workspace-eyebrow">Caption workspace</span>
          <h2>Captions</h2>
          <p>Review, time, style, and generate captions without leaving the playback context.</p>
        </div>
        <div className="caption-workspace-summary" aria-label="Caption status">
          <strong>{captionCount}</strong>
          <span>{captionCount === 1 ? 'caption' : 'captions'}</span>
        </div>
      </header>

      <nav className="caption-workspace-nav" aria-label="Caption workflow">
        <button type="button" onClick={() => scrollTo(reviewSectionRef)}>
          Review
        </button>
        <button type="button" onClick={() => scrollTo(styleSectionRef)}>
          Style
        </button>
        <button type="button" onClick={() => scrollTo(generateSectionRef)}>
          Generate
        </button>
      </nav>

      {!captionTrack && <p className="panel-empty">No caption track in this project.</p>}
      {operationError && (
        <div className="caption-operation-error" role="alert">
          <strong>Caption change was not applied.</strong>
          <span>{operationError}</span>
          <button type="button" onClick={() => setOperationError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div ref={reviewSectionRef} className="caption-workspace-section">
        <div className="caption-section-heading">
          <div>
            <span>1</span>
            <div>
              <h3>Review and edit</h3>
              <p>Find problems, correct text, adjust timing, and work across many cues.</p>
            </div>
          </div>
        </div>
        {captionCount > 0 ? (
          <CaptionCueWorkspace
            editor={editor}
            captionClips={captionClips}
            transcript={transcript}
            trackStyle={trackStyle}
            keywords={keywords}
            searchRef={captionSearchRef}
            apply={apply}
          />
        ) : (
          <div className="caption-zero-state">
            <strong>No captions to review</strong>
            <p>
              {transcript.length > 0
                ? 'Your transcript is ready. Generate captions below to begin editing.'
                : 'Transcribe spoken media first, then generate captions.'}
            </p>
            {transcript.length > 0 && (
              <button type="button" onClick={() => scrollTo(generateSectionRef)}>
                Go to generation
              </button>
            )}
          </div>
        )}
      </div>

      <div ref={styleSectionRef} className="caption-workspace-section">
        <div className="caption-section-heading">
          <div>
            <span>2</span>
            <div>
              <h3>Style and emphasis</h3>
              <p>Choose a look, then make precise changes with an explicit scope.</p>
            </div>
          </div>
        </div>

        <div className="caption-scope-bar" aria-label="Caption style scope">
          <div>
            <strong>Apply changes to</strong>
            <span>
              {styleScope === 'track'
                ? 'Every caption on this track'
                : hasCaptionSelection
                  ? `${styleTargets.length} selected caption${styleTargets.length === 1 ? '' : 's'}`
                  : 'Select one or more captions'}
            </span>
          </div>
          <div className="caption-scope-toggle" role="group" aria-label="Style scope">
            <button
              type="button"
              className={styleScope === 'selection' ? 'is-active' : ''}
              aria-pressed={styleScope === 'selection'}
              onClick={() => setStyleScope('selection')}
            >
              Selected captions
            </button>
            <button
              type="button"
              className={styleScope === 'track' ? 'is-active' : ''}
              aria-pressed={styleScope === 'track'}
              onClick={() => setStyleScope('track')}
            >
              All captions
            </button>
          </div>
          {hasMixedStyles && styleScope === 'selection' && (
            <span className="caption-mixed-values">Mixed values</span>
          )}
        </div>

        <CaptionTemplateBrowser templateId={templateId} onSelect={selectTemplate} />

        <details className="caption-options">
          <summary>Timing and emphasis</summary>
          <div className="caption-options-body">
            <label className="caption-field-label" htmlFor="caption-segmentation">
              Cue length
            </label>
            <Select
              id="caption-segmentation"
              label="Cue length"
              value={segmentChoice}
              options={SEGMENT_CHOICES.map((choice) => ({
                value: choice.id,
                label: choice.label,
              }))}
              onChange={(value) => setSegmentChoice(value as 'auto' | CaptionSegmentPresetName)}
            />
            <p className="caption-hint">
              Up to {config.maxWordsPerCue} word{config.maxWordsPerCue === 1 ? '' : 's'} and{' '}
              {config.maxCharsPerLine} characters a line.
            </p>

            <label className="caption-field-label" htmlFor="caption-keywords">
              Emphasise words
            </label>
            <button
              type="button"
              className={`caption-auto-emphasis${autoEmphasis ? ' is-active' : ''}`}
              aria-pressed={autoEmphasis}
              onClick={applyAutoEmphasis}
              disabled={transcript.length === 0 || emphasisStatus === 'analyzing'}
              title="Analyze meaning and delivery without replacing your caption edits"
            >
              <Sparkles size={ICON_SIZE.sm} aria-hidden="true" />
              {emphasisStatus === 'analyzing' ? 'Analyzing…' : 'Auto emphasis'}
            </button>
            <input
              id="caption-keywords"
              type="text"
              placeholder="e.g. framepilot, viral"
              value={keywordInput}
              aria-label="keywords"
              onChange={(event) => {
                setAutoEmphasis(false);
                setKeywordInput(event.target.value);
              }}
              onBlur={commitKeywords}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
            />
            <p className="caption-hint">
              AI weighs meaning, emotion, pauses, and delivery. Manual choices always win.
            </p>
            {(emphasisStatus === 'ai' || emphasisStatus === 'fallback') && (
              <p className="caption-emphasis-status" role="status" aria-live="polite">
                {emphasisStatus === 'ai'
                  ? 'AI emphasis applied.'
                  : 'AI unavailable. Local delivery analysis was applied.'}
              </p>
            )}
          </div>
        </details>

        <details className="caption-options">
          <summary>Typography</summary>
          <div className="caption-options-body">
            <label className="caption-font-field" htmlFor="caption-track-font-family">
              <span>Font for all captions</span>
              <CaptionFontPicker
                id="caption-track-font-family"
                value={trackFont}
                disabled={!captionTrack}
                onChange={applyTrackFont}
              />
            </label>
            <p className="caption-hint">
              Bundled families render consistently in preview and export.
            </p>
          </div>
        </details>

        <details className={`caption-options caption-style caption-style--${position}`}>
          <summary>
            Selected cue style
            {!hasCaptionSelection && captionCount > 0 ? ' (select a cue)' : ''}
          </summary>
          <fieldset
            className="caption-style-controls"
            disabled={styleScope === 'selection' && !hasCaptionSelection}
            aria-label="caption style"
          >
            <label className="caption-font-field" htmlFor="caption-font-family">
              <span>Font for selected cue</span>
              <CaptionFontPicker
                id="caption-font-family"
                value={
                  overrides.fontFamily ?? resolvedCurrent.fontFamily ?? DEFAULT_CAPTION_FONT_FAMILY
                }
                onChange={(fontFamily) => commitStyleChange({ fontFamily })}
              />
            </label>
            <label>
              <span>Size</span>
              <Slider
                ariaLabel="caption size"
                min={0.6}
                max={1.8}
                step={0.1}
                value={fontScale}
                onChange={(scale) => previewOverride({ fontScale: scale })}
                onCommit={(scale) => commitStyleChange({ fontScale: scale })}
              />
            </label>
            <div className="caption-colors" role="group" aria-label="caption color">
              {CAPTION_COLORS.map((nextColor) => (
                <button
                  key={nextColor}
                  type="button"
                  className={`caption-color${color === nextColor ? ' is-active' : ''}`}
                  style={{ background: nextColor }}
                  aria-label={`color ${nextColor}`}
                  aria-pressed={color === nextColor}
                  disabled={styleScope === 'selection' && !hasCaptionSelection}
                  onClick={() => commitStyleChange({ textColor: nextColor })}
                />
              ))}
            </div>
            <div className="caption-positions" role="group" aria-label="caption position">
              {(['top', 'center', 'bottom'] as const).map((nextPosition) => (
                <button
                  key={nextPosition}
                  type="button"
                  className={`caption-pos${position === nextPosition ? ' is-active' : ''}`}
                  aria-label={nextPosition}
                  aria-pressed={position === nextPosition}
                  disabled={styleScope === 'selection' && !hasCaptionSelection}
                  onClick={() => commitStyleChange({ position: toSchemaPosition(nextPosition) })}
                >
                  {nextPosition}
                </button>
              ))}
            </div>
            <label>
              <span>Width</span>
              <Slider
                ariaLabel="caption width"
                min={20}
                max={100}
                step={1}
                value={overrides.maxWidthPercent ?? resolvedCurrent.maxWidthPercent ?? 90}
                onChange={(maxWidthPercent) => previewOverride({ maxWidthPercent })}
                onCommit={(maxWidthPercent) => commitStyleChange({ maxWidthPercent })}
              />
            </label>
            <label>
              <span>Line height</span>
              <Slider
                ariaLabel="caption line height"
                min={0.7}
                max={2}
                step={0.05}
                value={overrides.lineHeight ?? resolvedCurrent.lineHeight ?? 1.25}
                onChange={(lineHeight) => previewOverride({ lineHeight })}
                onCommit={(lineHeight) => commitStyleChange({ lineHeight })}
              />
            </label>
            <label>
              <span>Rotation</span>
              <input
                type="number"
                min={-180}
                max={180}
                step={1}
                value={Math.round(overrides.rotation ?? resolvedCurrent.rotation ?? 0)}
                onChange={(event) => previewOverride({ rotation: Number(event.target.value) })}
                onBlur={(event) =>
                  commitStyleChange({ rotation: Number(event.currentTarget.value) })
                }
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
                aria-label="caption rotation"
              />
            </label>
            <div className="caption-positions" role="group" aria-label="caption alignment">
              {(['left', 'center', 'right'] as const).map((alignment) => (
                <button
                  key={alignment}
                  type="button"
                  className={`caption-pos${
                    (overrides.textAlign ?? resolvedCurrent.textAlign ?? 'center') === alignment
                      ? ' is-active'
                      : ''
                  }`}
                  aria-pressed={
                    (overrides.textAlign ?? resolvedCurrent.textAlign ?? 'center') === alignment
                  }
                  disabled={styleScope === 'selection' && !hasCaptionSelection}
                  onClick={() => commitStyleChange({ textAlign: alignment })}
                >
                  {alignment}
                </button>
              ))}
            </div>
            <label className="caption-check">
              <input
                type="checkbox"
                checked={overrides.safeArea ?? resolvedCurrent.safeArea ?? true}
                onChange={(event) => commitStyleChange({ safeArea: event.target.checked })}
              />
              <span>Keep inside safe area</span>
            </label>
            <p className="caption-hint">
              Drag a selected caption in the preview to place it. Preview changes remain
              synchronized with the timeline.
            </p>
          </fieldset>
        </details>
      </div>

      <div ref={generateSectionRef} className="caption-workspace-section">
        <div className="caption-section-heading">
          <div>
            <span>3</span>
            <div>
              <h3>Generate or regenerate</h3>
              <p>Create readable cues from the current edited timeline and transcript.</p>
            </div>
          </div>
        </div>
        <div className="caption-generation-card">
          <div className="caption-generation-copy">
            <strong>
              {captionCount > 0 ? `Replace ${captionCount} existing cues` : 'Create captions'}
            </strong>
            <p>
              Uses the selected template, cue length, and emphasis anchors. Text and timing stay
              editable after generation.
            </p>
          </div>
          <Button
            variant="primary"
            type="button"
            onClick={generate}
            disabled={!captionTrack || transcript.length === 0 || emphasisStatus === 'analyzing'}
            aria-keyshortcuts="Meta+Enter Control+Enter"
            title="Generate captions (⌘ Enter)"
          >
            {captionCount > 0 ? 'Regenerate captions' : 'Generate captions'}
          </Button>
          {captionCount > 0 && (
            <p className="caption-hint">
              Regenerating replaces all {captionCount} cues, including authored edits. Undo restores
              them.
            </p>
          )}
        </div>

        {captionCount === 0 && previewCues.length > 0 ? (
          <>
            <p className="caption-field-label">
              Preview · {previewCues.length} cue{previewCues.length === 1 ? '' : 's'}
            </p>
            <ol className="cue-list cue-list--preview" aria-label="caption preview">
              {previewCues.slice(0, 12).map((text, index) => (
                <li key={`${text}-${index}`} className="cue-row is-preview">
                  <span className="cue-text" style={captionLineCss(resolvedCurrent)}>
                    {text.split('\n').map((line, lineIndex) => (
                      <span key={lineIndex} className="cue-text-line">
                        {line}
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ol>
            {previewCues.length > 12 && (
              <p className="caption-hint">…and {previewCues.length - 12} more.</p>
            )}
          </>
        ) : captionCount === 0 && transcript.length === 0 ? (
          <p className="panel-empty">
            No transcript yet. Add footage with speech and transcribe it before generating captions.
          </p>
        ) : null}
      </div>
    </section>
  );
}
