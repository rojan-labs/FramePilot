/**
 * Media bin with folders (plan Phase 8 — asset handling + foldering, schema v3).
 *
 * The left-panel asset browser: import raw footage, organize it into a nested
 * folder tree (Finder/Explorer-style), and place assets on the timeline. Every
 * mutation — import, foldering, placement, removal — is a validated, **undoable**
 * patch routed through the editor store's `validate→apply→record` pipeline
 * (project-scoped for asset/folder ops; see ADR 0026). Foldering is purely
 * organizational: moving an asset between folders never touches its clips.
 *
 * Folder names are edited with an **inline text field** (not `window.prompt`,
 * which Electron's renderer does not support — it silently returns null, so the
 * old prompt-based create/rename never fired in the desktop app). Files can be
 * imported either via the picker or by **dragging them from the OS** onto the bin
 * (or onto a specific folder, which imports them straight into it).
 *
 * OS-like motion (expand/collapse, drop-in, drag-over lift, empty-folder fade)
 * lives in `styles.css` and degrades to no animation under
 * `prefers-reduced-motion`.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual';
import { Button } from '@framepilot/ui';
import type { Asset, Folder, Project } from '@framepilot/timeline-schema';
import type { UseEditor } from '../editor/useEditor.js';
import type { EditMode } from '../editor/useEditMode.js';
import {
  buildAsset,
  assetIdFor,
  deriveEngineMedia,
  materializeImportedMedia,
  probeMediaFile,
} from '../editor/import.js';
import {
  addAssetPatch,
  createFolderPatch,
  deleteFolderPatch,
  moveAssetToFolderPatch,
  moveFolderPatch,
  insertClipPatch,
  placeAssetPatch,
  removeAssetClipsPatch,
  removeAssetPatch,
  renameFolderPatch,
} from '../editor/patch-builders.js';
import { assetDisplayName, assetKind, layerKind } from '../editor/selectors.js';
import { useAssetThumbnail } from '../editor/useAssetThumbnail.js';
import { mediaSrc } from '../editor/media.js';
import { formatClock } from '../editor/captions.js';
import { searchTranscript, type TranscriptSearchResult } from '../editor/transcriptSearch.js';
import { useAiConfig } from '../editor/useAiConfig.js';
import { useSettings } from '../editor/useSettings.js';
import { autoTranscribeImportedAssets } from '../editor/transcribeImport.js';
import { autoIndexImportedAssets } from '../editor/visualIndex.js';
import {
  type BinDensity,
  type BinFilter,
  type BinSort,
  useMediaBinView,
} from '../editor/useMediaBinView.js';
import { useViewPreference } from '../editor/useViewPreference.js';

/** Stable empty default, so an un-collapsed bin never mints a new array per render. */
const EMPTY_IDS: readonly string[] = [];

/** Accept only an array of strings — anything else falls back to "nothing collapsed". */
function coerceIdList(raw: unknown): readonly string[] | undefined {
  return Array.isArray(raw) && raw.every((id) => typeof id === 'string')
    ? (raw as readonly string[])
    : undefined;
}
import { FolderGlyph } from './FolderGlyph.js';
import { Tooltip } from './Tooltip.js';
import { Select, type SelectOption } from './Select.js';
import {
  AudioLines,
  ChevronRight,
  CloudUpload,
  Film,
  FolderPlus,
  ICON_SIZE,
  Image,
  type LucideIcon,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
  X,
} from './icons.js';

/** Drag-and-drop MIME used to carry an asset id from the bin onto a track. */
export const ASSET_DND_TYPE = 'application/x-framepilot-asset';
/** Drag-and-drop MIME used to carry a folder id between folders. */
export const FOLDER_DND_TYPE = 'application/x-framepilot-folder';
/** Sentinel drop target for the bin root (un-foldered). */
const ROOT = '__root__';

export interface MediaBinProps {
  readonly editor: UseEditor;
  readonly project: Project;
  readonly onProjectChange?: (project: Project) => void;
  /**
   * Placement mode (view state). In `insert` the "Add" path inserts at the
   * playhead on a same-kind lane, pushing downstream clips right; `overwrite`
   * (default) appends at the end via auto-layering. See {@link useEditMode}.
   */
  readonly editMode?: EditMode;
  /**
   * Load an asset into the read-only Source monitor and switch to it (H1.7, J3
   * source-vs-program split). Optional: without it, clicking a card is a no-op
   * (matches the panel's behavior before this feature existed).
   */
  readonly onOpenInSource?: (asset: Asset) => void;
  /**
   * Save the project and return its on-disk path (desktop only), used to auto-transcribe
   * imported media when "Automatically on import" is enabled. Same wiring the Transcript
   * panel uses; absent ⇒ auto-transcribe is skipped (browser has no trusted-host ASR).
   */
  readonly ensureSavedForTranscription?: () => Promise<string | null>;
}

/** Lucide glyph per asset kind (Part D iconography mapping — no emoji). */
const KIND_ICON: Record<Asset['kind'], LucideIcon> = {
  video: Film,
  audio: AudioLines,
  image: Image,
};

/**
 * A footage duration for the card's badge, or `null` when the asset has no known
 * duration. Null renders **no badge at all** rather than a dash placeholder: a
 * chip reading "-" tells the user nothing and still costs a badge's worth of
 * attention on top of the frame.
 */
const formatDuration = (seconds?: number): string | null => {
  if (seconds === undefined) return null;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

/**
 * One file whose import is still in flight. Identified by a session-unique id
 * rather than by name, so importing two files that share a name (or re-importing
 * the same file while the first is still copying) still tracks as two cards.
 */
interface PendingImport {
  readonly id: string;
  readonly name: string;
}

/** A monotonic id source for in-flight import placeholders. */
let importCounter = 0;
const nextImportId = (): string => `import_${(importCounter += 1)}`;

/** A monotonic id source for user-created folders (unique within a session). */
let folderCounter = 0;
const nextFolderId = (): string => `folder_${Date.now().toString(36)}_${(folderCounter += 1)}`;

/**
 * An in-progress folder-name edit. `create` adds a new folder under `parentId`
 * (`null` = bin root); `rename` retitles an existing folder. Rendered as an
 * inline input so the bin never depends on `window.prompt` (unsupported in
 * Electron's renderer).
 */
type FolderDraft =
  | { readonly kind: 'create'; readonly parentId: string | null }
  | { readonly kind: 'rename'; readonly folderId: string };

interface FolderNameFieldProps {
  readonly initial: string;
  readonly label: string;
  readonly placeholder?: string;
  /** Called once with the entered name, or `null` when the edit is cancelled. */
  readonly onDone: (name: string | null) => void;
}

/**
 * A focused, self-contained inline text field for naming a folder. Commits on
 * Enter or blur and cancels on Escape, firing `onDone` exactly once (a guard
 * stops the blur that follows an Enter/Escape from committing a second time).
 */
function FolderNameField({
  initial,
  label,
  placeholder,
  onDone,
}: FolderNameFieldProps): JSX.Element {
  const [value, setValue] = useState(initial);
  const settled = useRef(false);
  const finish = (name: string | null): void => {
    if (settled.current) return;
    settled.current = true;
    onDone(name);
  };
  return (
    <input
      className="bin-folder-input"
      type="text"
      aria-label={label}
      placeholder={placeholder}
      autoFocus
      // Pre-select so the default name is replaced as the user types (spec §3.2).
      onFocus={(event) => event.target.select()}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(value);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(null);
        }
      }}
      onBlur={() => finish(value)}
    />
  );
}

/**
 * The asset tile's preview: a real thumbnail when one can be produced, a loading
 * shimmer while a video frame is being captured, or the type glyph as a fallback
 * (master-prompt §3.2). The `<img>` self-heals to the glyph if its source breaks
 * (e.g. a stale object URL after reload).
 *
 * For a video with a resolvable source, hovering scrubs: a muted `<video>`
 * mounts over the static frame and its `currentTime` tracks the cursor's x
 * position across the tile (redesign brief's hover-scrub). No filmstrip
 * precompute — this is the same source `useAssetThumbnail` already resolves,
 * just seeked live instead of captured once. `lastPct` carries the cursor
 * position into the video's `loadedmetadata` handler so the very first frame
 * shown already matches where the cursor entered, instead of flashing frame 0.
 */
const AssetThumb = memo(function AssetThumb({ asset }: { readonly asset: Asset }): JSX.Element {
  const thumb = useAssetThumbnail(asset);
  const [broken, setBroken] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastPct = useRef(0);
  const KindIcon = KIND_ICON[asset.kind];
  const scrubSrc = asset.kind === 'video' && asset.path ? mediaSrc(asset.path) : undefined;

  /** Record the cursor's fraction across the tile and seek the (possibly not-yet-
   * mounted) scrub video to match; `lastPct` also feeds the video's own
   * `loadedmetadata` handler so the frame it mounts with already matches. */
  const recordPct = (event: React.MouseEvent<HTMLElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    lastPct.current =
      rect.width > 0 ? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) : 0;
    const video = videoRef.current;
    if (video && Number.isFinite(video.duration) && video.duration > 0) {
      video.currentTime = lastPct.current * video.duration;
    }
  };

  if (thumb.status === 'ready' && !broken) {
    return (
      <span
        className="bin-thumb"
        aria-hidden="true"
        onMouseEnter={
          scrubSrc
            ? (event) => {
                recordPct(event);
                setScrubbing(true);
              }
            : undefined
        }
        onMouseMove={scrubSrc && scrubbing ? recordPct : undefined}
        onMouseLeave={scrubSrc ? () => setScrubbing(false) : undefined}
      >
        <img className="bin-thumb-img" src={thumb.url} alt="" onError={() => setBroken(true)} />
        {scrubbing && scrubSrc && (
          <video
            ref={videoRef}
            className="bin-thumb-scrub-video"
            src={scrubSrc}
            muted
            playsInline
            preload="metadata"
            onLoadedMetadata={() => {
              const video = videoRef.current;
              if (video) video.currentTime = lastPct.current * video.duration;
            }}
          />
        )}
      </span>
    );
  }
  if (thumb.status === 'loading') {
    return (
      <span className="bin-thumb is-loading" aria-hidden="true">
        <span className="skeleton bin-thumb-shimmer" />
      </span>
    );
  }
  return (
    <span className="bin-thumb" aria-hidden="true">
      <KindIcon size={ICON_SIZE.md} />
    </span>
  );
});

/**
 * What the keyboard can do to the focused footage card. Mirrors the mouse
 * affordances exactly (click = open in Source, double-click = place, hover
 * "remove" = remove) so neither input method is a second-class path.
 */
interface AssetCardActions {
  /** Load into the Source monitor — Enter, or a single click. */
  readonly onOpen: (asset: Asset) => void;
  /** Place on the timeline — Cmd/Ctrl+Enter, or a double-click. */
  readonly onAdd: (asset: Asset) => void;
  /** Remove from the project — Delete/Backspace, or the hover control. */
  readonly onRemove: (asset: Asset) => void;
  /** Move the grid's single tab stop by a signed number of cards. */
  readonly onMove: (fromId: string, delta: number) => void;
  /** Jump the tab stop to the first or last card. */
  readonly onMoveEdge: (edge: 'first' | 'last') => void;
  /** Record that this card now owns the tab stop (a real focus event). */
  readonly onFocused: (id: string) => void;
}

interface AssetCardProps {
  readonly asset: Asset;
  /** Has at least one clip on the timeline (informational dot + AT wording). */
  readonly used: boolean;
  /** Owns the grid's single tab stop (roving tabindex). */
  readonly tabbable: boolean;
  /**
   * Bumped every time focus should move *programmatically* to this card, and
   * `null` when it should not. A counter rather than a boolean so a repeat
   * keypress in the same direction still re-focuses after the row scrolls in,
   * and so a card that merely became tabbable never steals focus.
   */
  readonly focusSeq: number | null;
  /** Columns in the grid — the vertical arrow-key stride. */
  readonly columns: number;
  readonly actions: AssetCardActions;
}

/**
 * A footage card: a 16:9 thumbnail-dominant tile with a hover-revealed play
 * badge, a duration chip, its name captioned underneath, and hover controls to
 * place or remove it.
 *
 * **Keyboard.** The grid is one tab stop (roving tabindex); arrows move between
 * cards, Enter opens in Source, Cmd/Ctrl+Enter places on the timeline, and
 * Delete removes. Before this, every one of those actions was mouse-only: the
 * card was a plain `<div>` with click handlers, so a keyboard user could reach
 * the bin and then do nothing in it. The focusable element is a real `<button>`
 * covering the thumbnail, not a `tabindex` on the card, so assistive tech is
 * told the tile is activatable instead of being handed a focusable list item.
 *
 * Memoized because the bin re-renders on every search keystroke, filter change,
 * and timeline edit; without it each of those re-rendered every mounted card
 * (and re-ran each `useAssetThumbnail`).
 */
const AssetCard = memo(function AssetCard({
  asset,
  used,
  tabbable,
  focusSeq,
  columns,
  actions,
}: AssetCardProps): JSX.Element {
  const openRef = useRef<HTMLButtonElement>(null);
  const name = assetDisplayName(asset, asset.id);
  // A still image is not playable and has no intrinsic duration — its
  // `durationSeconds` is just the default timeline length. So it shows neither
  // the play overlay nor a duration badge (both are video/audio affordances).
  const isStill = asset.kind === 'image';
  const duration = isStill ? null : formatDuration(asset.durationSeconds);

  // Programmatic focus follows the arrow keys. Keyed on the counter so it fires
  // for a fresh move even when the card was already the tabbable one, and never
  // on mount for the card that merely happens to hold the initial tab stop.
  useEffect(() => {
    if (focusSeq !== null) openRef.current?.focus();
  }, [focusSeq]);

  const onKeyDown = (event: React.KeyboardEvent): void => {
    switch (event.key) {
      case 'ArrowRight':
        actions.onMove(asset.id, 1);
        break;
      case 'ArrowLeft':
        actions.onMove(asset.id, -1);
        break;
      case 'ArrowDown':
        actions.onMove(asset.id, columns);
        break;
      case 'ArrowUp':
        actions.onMove(asset.id, -columns);
        break;
      case 'Home':
        actions.onMoveEdge('first');
        break;
      case 'End':
        actions.onMoveEdge('last');
        break;
      case 'Enter':
        // Enter alone previews (matching a single click); with the platform
        // modifier it commits the edit (matching a double-click), the same
        // "modifier commits" pairing the rest of the editor uses.
        if (event.metaKey || event.ctrlKey) actions.onAdd(asset);
        else return; // let the button's own click handling run
        break;
      case 'Delete':
      case 'Backspace':
        actions.onRemove(asset);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      className="bin-card"
      role="listitem"
      draggable
      aria-label={`asset ${asset.id}`}
      data-asset-id={asset.id}
      onDragStart={(event) => {
        event.dataTransfer.setData(ASSET_DND_TYPE, asset.id);
        event.dataTransfer.setData('text/plain', asset.id);
        event.dataTransfer.effectAllowed = 'copyMove';
      }}
      // Single click loads the asset into the read-only Source monitor
      // (Premiere/Resolve convention: click selects/previews, double-click
      // inserts). Kept on the card so a click anywhere on the tile — including
      // its caption — previews, exactly as it did before the open button existed.
      onClick={() => actions.onOpen(asset)}
      onDoubleClick={() => actions.onAdd(asset)}
    >
      <span className="bin-card-thumb">
        <AssetThumb asset={asset} />
        {used && (
          <span className="bin-card-used" aria-hidden="true" title="Already on the timeline" />
        )}
        {!isStill && (
          <span className="bin-card-play" aria-hidden="true">
            <Play size={ICON_SIZE.md} />
          </span>
        )}
        {duration !== null && <span className="bin-card-dur tabular">{duration}</span>}
        {/* The keyboard/AT entry point for the tile, sized to the thumbnail.
            Its click bubbles to the card's own handler, so there is exactly one
            "open in Source" code path for both input methods. */}
        <button
          ref={openRef}
          type="button"
          className="bin-card-open"
          tabIndex={tabbable ? 0 : -1}
          aria-label={used ? `Open ${name} (on the timeline)` : `Open ${name}`}
          aria-keyshortcuts="Enter Meta+Enter Delete"
          title={`${name}\nEnter: open · ${'⌘'}Enter: add to timeline · Delete: remove`}
          onFocus={() => actions.onFocused(asset.id)}
          onKeyDown={onKeyDown}
        />
        <span className="bin-card-actions">
          <button
            type="button"
            className="bin-card-icon-btn bin-card-add"
            // Out of the tab ring on purpose: the grid is one tab stop and this
            // action has a keyboard shortcut on the focused card. Still in the
            // accessibility tree, still reachable by an AT virtual cursor.
            tabIndex={-1}
            aria-label={`add ${asset.id} to timeline`}
            title="Add to timeline"
            onClick={(event) => {
              event.stopPropagation();
              actions.onAdd(asset);
            }}
          >
            <Plus size={ICON_SIZE.sm} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="bin-card-icon-btn bin-remove"
            tabIndex={-1}
            aria-label={`remove ${asset.id}`}
            title="Remove from project"
            onClick={(event) => {
              event.stopPropagation();
              actions.onRemove(asset);
            }}
          >
            <X size={ICON_SIZE.sm} aria-hidden="true" />
          </button>
        </span>
      </span>
      <span className="bin-card-name" title={name}>
        {name}
      </span>
    </div>
  );
});

/**
 * The MOST columns the footage grid will use at each density (redesign brief:
 * S=4/M=3/L=2 — the density lever the brief calls "the single most important for
 * many assets, no clutter"). It is a ceiling, not a fixed count:
 * {@link gridColumns} drops columns when the rail is too narrow to give each card
 * {@link DENSITY_MIN_CARD_PX}. Four columns in a 300px rail produced 70px cards
 * whose filenames truncated to about eight characters — the density preference
 * has to lose to legibility, or "S" is just a broken layout.
 */
const DENSITY_MAX_COLUMNS: Record<BinDensity, number> = { S: 4, M: 3, L: 2 };
/** Narrowest a card may be at each density before the grid gives up a column. */
const DENSITY_MIN_CARD_PX: Record<BinDensity, number> = { S: 80, M: 104, L: 148 };
/**
 * Thumbnail height per density used only when the rail's width is unknown — in
 * jsdom (no layout, no `ResizeObserver`) and on the first pre-measure paint.
 * With a real measurement the thumb is sized to {@link THUMB_ASPECT} instead, so
 * a footage tile is a 16:9 frame at every density and rail width rather than a
 * fixed box footage has to squash into.
 */
const DENSITY_THUMB_FALLBACK_PX: Record<BinDensity, number> = { S: 64, M: 84, L: 96 };
/** Footage tiles are 16:9 — the shape of the media, not of the rail. */
const THUMB_ASPECT = 9 / 16;
/** Grid column gap (`--space-2`), needed to divide the row's width into cards. */
const GRID_GAP_PX = 8;
/** Space between a card's thumbnail and its filename caption (`--space-1`). */
const CARD_CAPTION_GAP_PX = 4;
/** One line of the 12px filename caption at `--leading-tight`. */
const CARD_CAPTION_LINE_PX = 17;
/** `.bin-vrow`'s bottom padding — the gap between grid rows. */
const ROW_GAP_PX = 6;

/**
 * How many columns fit: the density's ceiling, reduced until every card clears
 * that density's minimum width. Falls back to the ceiling when the width is not
 * yet known (see {@link DENSITY_THUMB_FALLBACK_PX}) so the un-measured first
 * paint matches the measured one for a normal rail.
 */
const gridColumns = (density: BinDensity, contentWidth: number): number => {
  const max = DENSITY_MAX_COLUMNS[density];
  if (contentWidth <= 0) return max;
  const fits = Math.floor(
    (contentWidth + GRID_GAP_PX) / (DENSITY_MIN_CARD_PX[density] + GRID_GAP_PX),
  );
  return Math.max(1, Math.min(max, fits));
};

/**
 * Observe an element's *content* width (padding excluded, so it is the width the
 * card grid actually gets). Returns 0 until measured, and stays 0 where there is
 * no layout engine (jsdom) or no `ResizeObserver` — callers must treat 0 as
 * "unknown" and fall back, never as "zero-width".
 */
function useContentWidth(ref: React.RefObject<HTMLElement>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** Filter options — kinds only (no "Text": captions/text are timeline
 * layers, not a real {@link Asset.kind} the bin can hold). */
const FILTER_OPTIONS: ReadonlyArray<{ readonly value: BinFilter; readonly label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'video', label: 'Video' },
  { value: 'audio', label: 'Audio' },
  { value: 'image', label: 'Images' },
];
const SORT_OPTIONS: ReadonlyArray<SelectOption<BinSort>> = [
  { value: 'recent', label: 'Recent' },
  { value: 'name', label: 'Name' },
  { value: 'duration', label: 'Duration' },
  { value: 'type', label: 'Type' },
  { value: 'unused', label: 'Unused' },
];
const FOLDER_ROW_HEIGHT = 36;
const EMPTY_ROW_HEIGHT = 48;
/** Extra rows rendered beyond the viewport so fast scrolls don't flash blank. */
const VIRTUAL_OVERSCAN = 8;
/** Indent (px) added per tree depth so nested folders read as a hierarchy. */
const DEPTH_INDENT = 14;
/**
 * Viewport height to assume when the scroll container measures as 0 — i.e. in
 * jsdom (no layout) and on the first pre-layout paint. Without it the virtualizer
 * would mount only the first row. The virtualizer never renders more than
 * `count` rows, so in a real browser this only matters for the single frame
 * before the real height arrives; in jsdom it makes every row mount (tests rely
 * on querying any asset, not just the first window).
 */
const FALLBACK_VIEWPORT_PX = 100_000;

/**
 * Wrap the virtual-core rect observer to substitute {@link FALLBACK_VIEWPORT_PX}
 * for a zero height. See {@link FALLBACK_VIEWPORT_PX} for why.
 */
const observeRectWithFallback: typeof observeElementRect = (instance, cb) =>
  observeElementRect(instance, (rect) =>
    cb({ width: rect.width, height: rect.height || FALLBACK_VIEWPORT_PX }),
  );

/**
 * One row of the flattened, virtualized bin tree. The nested folder tree is
 * flattened into a single list (honouring collapse state) so the bin can render
 * only the rows in view — essential when a project holds dozens of clips.
 */
type BinRow =
  | { readonly kind: 'folder'; readonly folder: Folder; readonly depth: number }
  /** A single grid row of up to two asset cards (the footage grid is 2-up). */
  | { readonly kind: 'assetpair'; readonly assets: readonly Asset[]; readonly depth: number }
  /** The inline "new folder" name field, under `parentId` (null = bin root). */
  | { readonly kind: 'draft'; readonly parentId: string | null; readonly depth: number }
  /** The "Empty folder" placeholder shown inside an expanded, empty folder. */
  | { readonly kind: 'empty'; readonly folderId: string; readonly depth: number };

export function MediaBin({
  editor,
  project,
  editMode = 'overwrite',
  onOpenInSource,
  ensureSavedForTranscription,
}: MediaBinProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  /**
   * Which bin folders are folded shut — remembered between sessions.
   *
   * Persisted as an id array and used as a Set, the same shape `useTrackLayout` already
   * uses for per-lane view state: ids are project-scoped, one global store holds them all,
   * and an id from another project simply never matches a folder here. Collapsing a tree
   * and finding it fully expanded on every open is the kind of small tax that makes a bin
   * feel like it is not listening.
   */
  const [collapsedIds, setCollapsedIds] = useViewPreference<readonly string[]>(
    'binCollapsedFolders',
    EMPTY_IDS,
    coerceIdList,
  );
  const collapsed = useMemo<ReadonlySet<string>>(() => new Set(collapsedIds), [collapsedIds]);
  const setCollapsed = useCallback(
    (update: (previous: ReadonlySet<string>) => ReadonlySet<string>): void => {
      setCollapsedIds((previous) => {
        const next = update(new Set(previous));
        // Sorted so the stored value is stable: the same set of folders must not rewrite
        // storage (and re-render) just because they were toggled in a different order.
        return [...next].sort();
      });
    },
    [setCollapsedIds],
  );
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  /** True while OS files are being dragged over the bin (for the import overlay). */
  const [fileDragActive, setFileDragActive] = useState(false);
  /** The in-progress folder create/rename, or `null` when nothing is being named. */
  const [draft, setDraft] = useState<FolderDraft | null>(null);
  /** Unified search: matches both asset filenames and spoken transcript words. */
  const [query, setQuery] = useState('');
  /**
   * Files currently being imported, in arrival order. Import is not instant —
   * probing the file, copying its bytes to the project's media folder, and
   * deriving waveform peaks/thumbnails through the sidecar each take real time on
   * camera-scale media. Until now nothing on screen changed during that window,
   * so the bin looked broken (or empty) mid-import. Each entry renders as a
   * placeholder card in the grid it will become, so the wait has a visible shape
   * and the list never jumps.
   */
  const [pendingImports, setPendingImports] = useState<readonly PendingImport[]>([]);
  /**
   * Which card owns the grid's single tab stop, and a counter that says when to
   * move focus there programmatically (see {@link AssetCardProps.focusSeq}).
   */
  const [focus, setFocus] = useState<{ readonly id: string; readonly seq: number } | null>(null);
  /** Density/filter/sort — view-only state, persisted across sessions. */
  const binView = useMediaBinView();
  /** The scrollable bin viewport — the element the virtualizer measures. */
  const scrollRef = useRef<HTMLDivElement>(null);
  // The grid is sized from the rail's real width, not from fixed per-density
  // numbers, so a narrow rail loses a column instead of shipping unreadable
  // cards, and a tile is always a 16:9 frame.
  const contentWidth = useContentWidth(scrollRef);
  const columns = gridColumns(binView.density, contentWidth);
  const cardWidth = contentWidth > 0 ? (contentWidth - GRID_GAP_PX * (columns - 1)) / columns : 0;
  const thumbHeight =
    cardWidth > 0
      ? Math.round(cardWidth * THUMB_ASPECT)
      : DENSITY_THUMB_FALLBACK_PX[binView.density];
  // One exact row height, derived from the same numbers the CSS uses, so the
  // virtualizer's windowing math cannot drift out of lockstep with the layout.
  const rowHeight = thumbHeight + CARD_CAPTION_GAP_PX + CARD_CAPTION_LINE_PX + ROW_GAP_PX;

  // Read the bin straight from the store (the source of truth) so the tree
  // reflects edits/undo immediately, without waiting for the lift-up to App.
  const assets = editor.state.assets;
  const folders = editor.state.folders;
  const transcript = project.transcript;

  // Auto visual-index config (MI4.2): read the readable plaintext key slot + the
  // auto-index toggle so a completed import can kick off background indexing.
  const { config: aiConfig } = useAiConfig();
  const { settings } = useSettings();

  const trimmedQuery = query.trim();
  const isSearching = trimmedQuery.length > 0;
  /**
   * Off the bin's default (folder-tree) view whenever a filter or sort is
   * active. Rather than layering a second grouping scheme (type) on top of the
   * user's own folder structure, filter/sort flatten the whole bin — the same
   * move unified search already makes to produce its results.
   */
  const isFlatView = binView.filter !== 'all' || binView.sort !== 'recent';

  /** Asset ids with at least one clip on the timeline (redesign brief's "used
   * on timeline" indicator). Purely derived — never persisted. */
  const usedAssetIds = useMemo(
    () =>
      new Set(
        editor.state.timeline.tracks.flatMap((track) => track.clips.map((clip) => clip.assetId)),
      ),
    [editor.state.timeline],
  );

  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);

  /** Filename matches: case-insensitive substring (forgiving of partial names/typos). */
  const nameMatches = useMemo(() => {
    if (!isSearching) return [];
    const q = trimmedQuery.toLowerCase();
    return assets.filter((asset) => assetDisplayName(asset, asset.id).toLowerCase().includes(q));
  }, [assets, isSearching, trimmedQuery]);

  /** "Spoken in your footage" matches: whole-word, mapped back to a clip/asset. */
  const transcriptMatches = useMemo(() => {
    if (!isSearching) return [];
    return searchTranscript(transcript, editor.state.timeline, trimmedQuery);
  }, [isSearching, trimmedQuery, transcript, editor.state.timeline]);

  /** Child folders grouped by parent id (null/root under ROOT). */
  const childFolders = useMemo(() => {
    const map = new Map<string, Folder[]>();
    for (const folder of folders) {
      const key = folder.parentId ?? ROOT;
      (map.get(key) ?? map.set(key, []).get(key)!).push(folder);
    }
    return map;
  }, [folders]);

  /** Assets grouped by their folder id (undefined → ROOT). */
  const assetsByFolder = useMemo(() => {
    const map = new Map<string, Asset[]>();
    for (const asset of assets) {
      const key = asset.folderId ?? ROOT;
      (map.get(key) ?? map.set(key, []).get(key)!).push(asset);
    }
    return map;
  }, [assets]);

  /**
   * The bin's assets filtered by kind and sorted, computed only in flat view
   * (filter/sort active). "Recent" needs no timestamp field on `Asset` — it
   * reads the array's own import order (assets are appended on import) rather
   * than adding a schema field for it.
   */
  const flatAssets = useMemo(() => {
    if (!isFlatView) return [];
    const filtered =
      binView.filter === 'all' ? assets : assets.filter((asset) => asset.kind === binView.filter);
    const indexed = filtered.map((asset, index) => ({ asset, index }));
    const byRecent = (a: { index: number }, b: { index: number }): number => b.index - a.index;
    indexed.sort((a, b) => {
      switch (binView.sort) {
        case 'name':
          return assetDisplayName(a.asset, a.asset.id).localeCompare(
            assetDisplayName(b.asset, b.asset.id),
          );
        case 'duration':
          return (b.asset.durationSeconds ?? 0) - (a.asset.durationSeconds ?? 0);
        case 'type':
          return (
            a.asset.kind.localeCompare(b.asset.kind) ||
            assetDisplayName(a.asset, a.asset.id).localeCompare(
              assetDisplayName(b.asset, b.asset.id),
            )
          );
        case 'unused': {
          const aUsed = usedAssetIds.has(a.asset.id);
          const bUsed = usedAssetIds.has(b.asset.id);
          return aUsed === bUsed ? byRecent(a, b) : aUsed ? 1 : -1;
        }
        case 'recent':
        default:
          return byRecent(a, b);
      }
    });
    return indexed.map((entry) => entry.asset);
  }, [isFlatView, assets, binView.filter, binView.sort, usedAssetIds]);

  /**
   * Flatten the visible folder tree into one ordered row list so the bin can
   * window it (render only what's on screen) — the fix for a sluggish bin once a
   * project holds dozens of clips. Order mirrors the former recursive render: at
   * each level a pending "new folder" draft comes first, then each child folder
   * immediately followed by its own (recursively flattened) subtree, then the
   * level's assets. Collapsed folders contribute only their header row.
   *
   * In flat view (a filter or sort is active) the folder tree is bypassed
   * entirely — filter/sort browse *across* the whole bin, same as unified
   * search already does, rather than layering a second (type-based) grouping
   * scheme on top of the user's own folder structure.
   */
  const rows = useMemo<BinRow[]>(() => {
    if (isFlatView) {
      const out: BinRow[] = [];
      for (let i = 0; i < flatAssets.length; i += columns) {
        out.push({ kind: 'assetpair', assets: flatAssets.slice(i, i + columns), depth: 0 });
      }
      return out;
    }
    const out: BinRow[] = [];
    const walk = (parentId: string | null, depth: number): void => {
      if (draft?.kind === 'create' && draft.parentId === parentId) {
        out.push({ kind: 'draft', parentId, depth });
      }
      const key = parentId ?? ROOT;
      for (const folder of childFolders.get(key) ?? []) {
        out.push({ kind: 'folder', folder, depth });
        if (collapsed.has(folder.id)) continue;
        const childFolderList = childFolders.get(folder.id) ?? [];
        const folderAssets = assetsByFolder.get(folder.id) ?? [];
        const isCreatingHere = draft?.kind === 'create' && draft.parentId === folder.id;
        if (childFolderList.length === 0 && folderAssets.length === 0 && !isCreatingHere) {
          out.push({ kind: 'empty', folderId: folder.id, depth: depth + 1 });
        } else {
          walk(folder.id, depth + 1);
        }
      }
      // Assets at this level render as an N-up card grid (N = the density
      // column count): pair consecutive assets into one virtual row so
      // windowing stays row-based and folder headers keep spanning full width.
      // A final partial row is left-aligned.
      const levelAssets = assetsByFolder.get(key) ?? [];
      for (let i = 0; i < levelAssets.length; i += columns) {
        out.push({
          kind: 'assetpair',
          assets: levelAssets.slice(i, i + columns),
          depth,
        });
      }
    };
    walk(null, 0);
    return out;
  }, [isFlatView, flatAssets, columns, childFolders, assetsByFolder, collapsed, draft]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const row = rows[index];
      if (!row || row.kind === 'assetpair') return rowHeight;
      if (row.kind === 'empty') return EMPTY_ROW_HEIGHT;
      return FOLDER_ROW_HEIGHT;
    },
    overscan: VIRTUAL_OVERSCAN,
    observeElementRect: observeRectWithFallback,
  });

  /**
   * Every rendered card id in visual order — the sequence the arrow keys walk.
   * Held in a ref so the navigation callbacks below stay referentially stable
   * (they are handed to a memoized {@link AssetCard}, which would otherwise
   * re-render on every keystroke and defeat the memo).
   */
  const orderedIdsRef = useRef<readonly string[]>([]);
  orderedIdsRef.current = useMemo(
    () => rows.flatMap((row) => (row.kind === 'assetpair' ? row.assets.map((a) => a.id) : [])),
    [rows],
  );

  /**
   * Probe and import a batch of files as undoable `add_asset` patches, optionally
   * placing them directly into `folderId` (the folder they were dropped on).
   * Shared by the file picker and OS drag-and-drop.
   */
  const importFiles = useCallback(
    async (files: readonly File[], folderId: string | null = null) => {
      if (files.length === 0) return;
      const importedIds: string[] = [];
      // Show one placeholder card per file up front, then retire each as its own
      // import settles — so a 12-file drop visibly drains rather than freezing.
      const pending: readonly PendingImport[] = files.map((file) => ({
        id: nextImportId(),
        name: file.name,
      }));
      setPendingImports((current) => [...current, ...pending]);
      const retire = (id: string): void =>
        setPendingImports((current) => current.filter((entry) => entry.id !== id));
      for (const [index, file] of files.entries()) {
        const pendingId = pending[index]!.id;
        try {
          const probed = await probeMediaFile(file);
          // Copy the bytes onto disk in the desktop app so the render engine and
          // the fp-media:// preview both resolve the same file; browser mode keeps
          // the session object URL. Duration comes from the probe either way.
          const media = await materializeImportedMedia(probed, file, project.id);
          // Derive engine media (waveform peaks + thumbnails) for the on-disk file
          // so the timeline draws real waveforms/filmstrip frames. Best-effort:
          // when the engine is down (or in the browser) this is `undefined` and the
          // import still succeeds — the timeline simply draws a skeleton. The
          // asset id is computed up front so the sidecar can record the import
          // in the project brain under the same id (plan B0.4).
          const existingIds = [...assets.map((a) => a.id), ...importedIds];
          const assetId = assetIdFor(media.fileName, existingIds);
          const engineMedia = await deriveEngineMedia(media.path, {
            projectId: project.id,
            assetId,
          });
          const asset = buildAsset(media, existingIds, engineMedia);
          editor.applyPatch(addAssetPatch(folderId ? { ...asset, folderId } : asset));
          importedIds.push(asset.id);
        } catch (error) {
          setStatus(error instanceof Error ? error.message : String(error));
        } finally {
          // Always retire the placeholder — a failed probe must not leave a card
          // shimmering forever (the error surfaces in the status line instead).
          retire(pendingId);
        }
      }
      if (importedIds.length > 0) {
        setStatus(`Imported ${importedIds.length} file${importedIds.length === 1 ? '' : 's'}.`);
        // Fire-and-forget background visual indexing (MI4.2, decision D3): gated
        // on a configured key + the auto-index toggle, paced across HTTP slices,
        // and degrading honestly if the sidecar is down. Deliberately NOT awaited
        // — it must never block import or preview. Its own errors are swallowed by
        // the honest-degrade client, so there is no rejection to handle here.
        void autoIndexImportedAssets({
          projectId: project.id,
          assetIds: importedIds,
          config: aiConfig,
        });
        // Fire-and-forget auto-transcribe (Settings → "Automatically on import"). Same
        // no-block contract as auto-index: it establishes the project transcript from the
        // first imported clip when enabled and none exists yet, and swallows its own
        // errors. Desktop only — `ensureSavedForTranscription` is absent in the browser.
        void autoTranscribeImportedAssets({
          assets: editor.state.assets,
          assetIds: importedIds,
          existingTranscriptWordCount: project.transcript?.length ?? 0,
          enabled: settings.transcribeOnImport,
          provider: settings.asrProvider,
          ...(ensureSavedForTranscription ? { ensureSaved: ensureSavedForTranscription } : {}),
          applyPatchChecked: editor.applyPatchChecked,
        });
      }
    },
    [
      assets,
      editor,
      project.id,
      project.transcript,
      aiConfig,
      settings.transcribeOnImport,
      settings.asrProvider,
      ensureSavedForTranscription,
    ],
  );

  const onPick = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = ''; // allow re-importing the same file
      await importFiles(files);
    },
    [importFiles],
  );

  const addToTimeline = useCallback(
    (asset: Asset) => {
      const timeline = editor.state.timeline;
      const assetById = new Map(editor.state.assets.map((a) => [a.id, a]));
      // Insert mode: drop the clip in at the playhead on the frontmost same-kind
      // (or empty) lane, pushing that lane's downstream clips right (one patch).
      // Falls through to the append path when there is no compatible lane.
      if (editMode === 'insert') {
        const kind = assetKind(asset);
        const lane = timeline.tracks.find((t) => {
          const k = layerKind(t, assetById);
          return !t.locked && (k === null || k === kind);
        });
        if (lane) {
          const patch = insertClipPatch(timeline, lane.id, asset, editor.getPlayhead());
          if (patch) editor.applyPatch(patch);
          return;
        }
      }
      // CapCut-style auto-layering (Phase 2, ADR 0032): append at the end of the
      // timeline's existing content and let `placeAssetPatch` pick a same-kind layer
      // with room, or spawn a new layer at the front. Layers are type-agnostic, so we
      // no longer route by a fixed `track.type` lane.
      const appendAt = timeline.tracks.reduce(
        (max, t) => t.clips.reduce((m, c) => Math.max(m, c.end), max),
        0,
      );
      const patch = placeAssetPatch(timeline, assetById, asset, appendAt);
      if (patch) editor.applyPatch(patch);
    },
    [editor, editMode],
  );

  const removeFromBin = useCallback(
    (asset: Asset) => {
      // Drop the asset's timeline clips, then the bin entry, in one undoable patch
      // so deleting media never strands a clip on a missing source.
      const clipsPatch = removeAssetClipsPatch(editor.state.timeline, asset.id);
      const removePatch = removeAssetPatch(asset.id);
      const operations = [...(clipsPatch?.operations ?? []), ...removePatch.operations];
      editor.applyPatch({ ...removePatch, operations });
      setStatus(`Removed ${asset.id}.`);
    },
    [editor],
  );

  /**
   * Move the grid's tab stop to `id`, scrolling its (possibly unmounted, since
   * the list is windowed) row into view first — otherwise arrowing past the
   * viewport would move focus to an element that does not exist yet.
   */
  const focusCard = useCallback(
    (id: string) => {
      const rowIndex = rows.findIndex(
        (row) => row.kind === 'assetpair' && row.assets.some((a) => a.id === id),
      );
      if (rowIndex >= 0) virtualizer.scrollToIndex(rowIndex, { align: 'auto' });
      setFocus((current) => ({ id, seq: (current?.seq ?? 0) + 1 }));
    },
    [rows, virtualizer],
  );

  const cardActions = useMemo<AssetCardActions>(
    () => ({
      onOpen: (asset) => onOpenInSource?.(asset),
      onAdd: (asset) => addToTimeline(asset),
      onRemove: (asset) => removeFromBin(asset),
      onMove: (fromId, delta) => {
        const ids = orderedIdsRef.current;
        const from = ids.indexOf(fromId);
        if (from < 0) return;
        // Clamp rather than wrap: arrowing off the end of a grid should stop at
        // the last card, not teleport back to the first.
        const next = ids[Math.min(ids.length - 1, Math.max(0, from + delta))];
        if (next && next !== fromId) focusCard(next);
      },
      onMoveEdge: (edge) => {
        const ids = orderedIdsRef.current;
        const next = edge === 'first' ? ids[0] : ids[ids.length - 1];
        if (next) focusCard(next);
      },
      onFocused: (id) =>
        // A real focus event only records who owns the tab stop; it must not bump
        // `seq`, or the programmatic-focus effect would fire in a loop.
        setFocus((current) => (current?.id === id ? current : { id, seq: current?.seq ?? 0 })),
    }),
    [addToTimeline, focusCard, onOpenInSource, removeFromBin],
  );

  /** Begin creating a folder under `parentId`, auto-expanding that parent. */
  const startCreateFolder = useCallback((parentId: string | null) => {
    if (parentId !== null) {
      setCollapsed((prev) => {
        if (!prev.has(parentId)) return prev;
        const next = new Set(prev);
        next.delete(parentId);
        return next;
      });
    }
    setDraft({ kind: 'create', parentId });
  }, []);

  /** Begin renaming an existing folder inline. */
  const startRenameFolder = useCallback((folder: Folder) => {
    setDraft({ kind: 'rename', folderId: folder.id });
  }, []);

  /** Commit (or cancel) the in-progress folder name edit. */
  const commitDraft = useCallback(
    (name: string | null) => {
      const current = draft;
      setDraft(null);
      if (current === null || name === null) return;
      const trimmed = name.trim();
      if (trimmed === '') return;
      if (current.kind === 'create') {
        editor.applyPatch(createFolderPatch(nextFolderId(), trimmed, current.parentId));
        return;
      }
      const folder = folders.find((f) => f.id === current.folderId);
      if (folder && trimmed !== folder.name) {
        editor.applyPatch(renameFolderPatch(current.folderId, trimmed));
      }
    },
    [draft, editor, folders],
  );

  const deleteFolder = useCallback(
    (folder: Folder) => {
      editor.applyPatch(deleteFolderPatch(folder.id));
      setStatus(`Deleted folder "${folder.name}".`);
    },
    [editor],
  );

  const toggleCollapse = useCallback((folderId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }, []);

  /**
   * Handle a drop onto a folder (or the root). OS file drops (which carry
   * `dataTransfer.files`) import straight into the target folder; internal drags
   * move the dragged asset/folder.
   */
  const onDropInto = useCallback(
    (event: React.DragEvent, targetFolderId: string | null) => {
      event.preventDefault();
      event.stopPropagation();
      setDropTarget(null);
      setFileDragActive(false);
      const files = Array.from(event.dataTransfer.files ?? []);
      if (files.length > 0) {
        void importFiles(files, targetFolderId);
        return;
      }
      const assetId = event.dataTransfer.getData(ASSET_DND_TYPE);
      if (assetId) {
        editor.applyPatch(moveAssetToFolderPatch(assetId, targetFolderId));
        return;
      }
      const folderId = event.dataTransfer.getData(FOLDER_DND_TYPE);
      // Dropping a folder onto itself is a no-op; a cycle is caught by the validator.
      if (folderId && folderId !== targetFolderId) {
        editor.applyPatch(moveFolderPatch(folderId, targetFolderId));
      }
    },
    [editor, importFiles],
  );

  const onDragOver = useCallback((event: React.DragEvent, key: string) => {
    const { types } = event.dataTransfer;
    // OS file drag: accept anywhere over the bin and show the import overlay.
    if (types.includes('Files')) {
      event.preventDefault();
      event.stopPropagation();
      setFileDragActive(true);
      setDropTarget(key);
      return;
    }
    if (types.includes(ASSET_DND_TYPE) || types.includes(FOLDER_DND_TYPE)) {
      event.preventDefault();
      event.stopPropagation();
      setDropTarget(key);
    }
  }, []);

  /**
   * The in-progress "new folder" draft rendered as a folder tile in inline-edit
   * mode (master-prompt §3.2): a filled folder glyph beside a name field seeded
   * with a pre-selected default. Enter/blur commit, Escape cancels.
   */
  const renderDraftRow = (): JSX.Element => (
    <div className="bin-folder bin-folder--draft">
      <div className="bin-folder-head">
        <span className="bin-folder-icon" aria-hidden="true">
          <FolderGlyph size={ICON_SIZE.md} open />
        </span>
        <FolderNameField
          initial="Untitled folder"
          label="folder name"
          placeholder="Folder name"
          onDone={commitDraft}
        />
      </div>
    </div>
  );

  /**
   * A footage card, wired to this bin's shared state: which card owns the tab
   * stop, whether the asset is on the timeline, and the grid's column stride for
   * vertical arrow keys. The card itself is memoized — see {@link AssetCard}.
   */
  const renderAssetCard = (asset: Asset): JSX.Element => (
    <AssetCard
      key={asset.id}
      asset={asset}
      used={usedAssetIds.has(asset.id)}
      // Nothing focused yet ⇒ the first card holds the tab stop, so one Tab
      // reaches the grid rather than landing on whichever card came last.
      tabbable={focus ? focus.id === asset.id : orderedIdsRef.current[0] === asset.id}
      focusSeq={focus?.id === asset.id ? focus.seq : null}
      columns={columns}
      actions={cardActions}
    />
  );

  /**
   * A single folder *header* row. The folder's contents are sibling rows in the
   * flattened list, so this never renders a nested body — it stays a drop target
   * (file/asset/folder drops) and carries the collapse/rename/delete controls.
   */
  const renderFolderRow = (folder: Folder): JSX.Element => {
    const isCollapsed = collapsed.has(folder.id);
    const isRenaming = draft?.kind === 'rename' && draft.folderId === folder.id;
    return (
      <div
        className={`bin-folder${dropTarget === folder.id ? ' is-drop-target' : ''}`}
        role="listitem"
        aria-label={`folder ${folder.name}`}
        onDragOver={(event) => onDragOver(event, folder.id)}
        onDragLeave={() => setDropTarget((t) => (t === folder.id ? null : t))}
        onDrop={(event) => onDropInto(event, folder.id)}
      >
        <div className="bin-folder-head">
          {isRenaming ? (
            <FolderNameField
              initial={folder.name}
              label={`rename folder ${folder.name}`}
              onDone={commitDraft}
            />
          ) : (
            <button
              type="button"
              className={`bin-folder-toggle${isCollapsed ? '' : ' is-open'}`}
              aria-expanded={!isCollapsed}
              aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${folder.name}`}
              onClick={() => toggleCollapse(folder.id)}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(FOLDER_DND_TYPE, folder.id);
                event.dataTransfer.effectAllowed = 'move';
              }}
            >
              <span className="bin-folder-chevron" aria-hidden="true">
                <ChevronRight size={ICON_SIZE.sm} />
              </span>
              <span className="bin-folder-icon" aria-hidden="true">
                <FolderGlyph size={ICON_SIZE.md} open={!isCollapsed} />
              </span>
              <span
                className="bin-folder-name"
                title="Double-click to rename"
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  startRenameFolder(folder);
                }}
              >
                {folder.name}
              </span>
            </button>
          )}
          <span className="bin-folder-actions">
            <button
              type="button"
              className="bin-folder-btn"
              aria-label={`new subfolder in ${folder.name}`}
              title="New subfolder"
              onClick={() => startCreateFolder(folder.id)}
            >
              <Plus size={ICON_SIZE.sm} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="bin-folder-btn"
              aria-label={`rename ${folder.name}`}
              title="Rename folder"
              onClick={() => startRenameFolder(folder)}
            >
              <Pencil size={ICON_SIZE.sm} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="bin-folder-btn"
              aria-label={`delete ${folder.name}`}
              title="Delete folder"
              onClick={() => deleteFolder(folder)}
            >
              <Trash2 size={ICON_SIZE.sm} aria-hidden="true" />
            </button>
          </span>
        </div>
      </div>
    );
  };

  /** Render one flattened row by kind (the outer positioned wrapper is added below). */
  const renderRow = (row: BinRow): JSX.Element => {
    switch (row.kind) {
      case 'folder':
        return renderFolderRow(row.folder);
      case 'assetpair':
        return (
          <div className="bin-grid-row" role="presentation">
            {row.assets.map((asset) => renderAssetCard(asset))}
          </div>
        );
      case 'draft':
        return renderDraftRow();
      case 'empty':
        return <p className="bin-folder-empty">Empty folder. Drag media here.</p>;
    }
  };

  /**
   * One "spoken in your footage" result: a seekable snippet with the
   * time and, when the transcript still lines up with the timeline, which
   * asset it's in. Clicking (or Enter) seeks the shared playhead — the same
   * `editor.seek` affordance `TranscriptView`'s word buttons use — so jumping
   * to a line of dialogue behaves identically whether you found it here or in
   * the transcript panel.
   */
  const renderTranscriptResult = (result: TranscriptSearchResult): JSX.Element => {
    const asset = result.assetId ? assetById.get(result.assetId) : undefined;
    return (
      <li key={result.wordIndex}>
        <button
          type="button"
          className="bin-transcript-result"
          onClick={() => editor.seek(result.start)}
        >
          <span className="bin-transcript-result-time tabular">{formatClock(result.start)}</span>
          <span className="bin-transcript-result-snippet">{result.snippet}</span>
          {asset && (
            <span className="bin-transcript-result-asset">{assetDisplayName(asset, asset.id)}</span>
          )}
        </button>
      </li>
    );
  };

  /**
   * Unified search results: filename matches and transcript matches side by
   * side under one query (a second search box felt redundant — a creator
   * searching "the intro clip" or "thanks for watching" wants one box). Honest
   * empty states throughout: no transcript yet says so rather than silently
   * showing zero spoken matches.
   */
  const renderSearchResults = (): JSX.Element => (
    <div className="bin-search-results" aria-label="search results">
      {nameMatches.length > 0 && (
        <div className="bin-search-group">
          <h3 className="bin-search-group-title">Media</h3>
          <div className="bin-list">
            {nameMatches.map((asset) => (
              <div key={asset.id} className="bin-grid-row">
                {renderAssetCard(asset)}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="bin-search-group">
        <h3 className="bin-search-group-title">Spoken in your footage</h3>
        {transcript.length === 0 ? (
          <p className="panel-empty">Transcribe your footage to search what is said.</p>
        ) : transcriptMatches.length === 0 ? (
          <p className="panel-empty">No spoken matches for “{trimmedQuery}”.</p>
        ) : (
          <ul className="bin-transcript-results" aria-label="transcript matches">
            {transcriptMatches.map(renderTranscriptResult)}
          </ul>
        )}
      </div>
      {nameMatches.length === 0 && transcript.length > 0 && transcriptMatches.length === 0 && (
        <p className="panel-empty">No media matches “{trimmedQuery}” either.</p>
      )}
    </div>
  );

  /** Stable key per row so React reconciles rows by identity, not by position. */
  const rowKey = (row: BinRow): string => {
    switch (row.kind) {
      case 'folder':
        return `folder:${row.folder.id}`;
      case 'assetpair':
        return `pair:${row.assets.map((a) => a.id).join(',')}`;
      case 'draft':
        return `draft:${row.parentId ?? ROOT}`;
      case 'empty':
        return `empty:${row.folderId}`;
    }
  };

  const creatingRoot = draft?.kind === 'create' && draft.parentId === null;
  const isEmpty = assets.length === 0 && folders.length === 0;
  const isImporting = pendingImports.length > 0;

  /**
   * The in-flight import placeholders, rendered as the very cards they will
   * become: same tile geometry, a shimmering thumb, and the real filename
   * underneath so it's obvious *which* files are landing. Announced via
   * `role="status"` so the wait is not a visual-only signal.
   */
  const renderPendingImports = (): JSX.Element => (
    <div className="bin-list bin-import-pending" role="status" aria-label="importing media">
      <p className="bin-import-pending-label">
        Importing {pendingImports.length} file{pendingImports.length === 1 ? '' : 's'}…
      </p>
      <div className="bin-grid-row">
        {pendingImports.map((entry) => (
          <div
            key={entry.id}
            className="bin-card bin-card--pending"
            aria-label={`importing ${entry.name}`}
          >
            <span className="bin-card-thumb">
              <span className="bin-thumb is-loading" aria-hidden="true">
                <span className="skeleton bin-thumb-shimmer" />
              </span>
            </span>
            <span className="bin-card-name">{entry.name}</span>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <section
      className="bin"
      data-density={binView.density}
      aria-label="media bin"
      // The grid's shape is computed from the rail's real width (see
      // `gridColumns`), so the CSS reads it from here instead of hard-coding a
      // column count and a thumbnail height per density that JS then has to
      // mirror exactly for the virtualizer's math to hold.
      style={
        {
          '--bin-columns': String(columns),
          '--bin-thumb-h': `${thumbHeight}px`,
        } as React.CSSProperties
      }
    >
      <header className="panel-head">
        <h2>
          Assets <span className="panel-head-count">· {assets.length}</span>
        </h2>
        <div className="panel-head-actions">
          <div
            className="segmented segmented-xs bin-density"
            role="group"
            aria-label="Thumbnail size"
          >
            {(['S', 'M', 'L'] as const).map((density) => (
              <button
                key={density}
                type="button"
                className={binView.density === density ? 'is-active' : ''}
                aria-pressed={binView.density === density}
                title={`${{ S: 'Small', M: 'Medium', L: 'Large' }[density]} thumbnails`}
                onClick={() => binView.setDensity(density)}
              >
                {density}
              </button>
            ))}
          </div>
          <Tooltip label="New folder">
            <button
              type="button"
              className="icon-btn bin-new-folder"
              aria-label="new folder"
              onClick={() => startCreateFolder(null)}
            >
              <FolderPlus size={ICON_SIZE.md} aria-hidden="true" />
            </button>
          </Tooltip>
          <Button
            variant="secondary"
            className="bin-import-btn"
            type="button"
            aria-label="Import media"
            onClick={() => inputRef.current?.click()}
          >
            <CloudUpload size={ICON_SIZE.sm} aria-hidden="true" />
            <span>Import</span>
          </Button>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="video/*,audio/*,image/*"
          multiple
          aria-label="import media"
          className="bin-file-input"
          onChange={onPick}
        />
      </header>

      <div className="bin-search">
        <Search size={ICON_SIZE.sm} aria-hidden="true" />
        <input
          type="search"
          aria-label="search media and transcript"
          placeholder="Search media & transcript…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          // Escape backs out one level, matching every other overlay/field in the
          // editor, so leaving a search never needs the mouse.
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query !== '') {
              event.preventDefault();
              event.stopPropagation();
              setQuery('');
            }
          }}
        />
        {isSearching && (
          <button
            type="button"
            className="bin-search-clear"
            aria-label="clear search"
            title="Clear search (Esc)"
            onClick={() => setQuery('')}
          >
            <X size={ICON_SIZE.sm} aria-hidden="true" />
          </button>
        )}
      </div>

      {/* View strip: what you are looking at (kind) beside how it is ordered.
          The kind filter is a segmented control rather than loose chips — four
          mutually exclusive options are what a segmented control is for, it is
          the same control language as the density switch above, and it is compact
          enough that the strip stays on ONE line in a narrow rail (loose chips
          wrapped, stranding "Images" on a second line beside the sort menu). */}
      <div className="bin-view-strip">
        <div className="segmented segmented-xs bin-filter" role="group" aria-label="Filter by kind">
          {FILTER_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={binView.filter === option.value ? 'is-active' : ''}
              aria-pressed={binView.filter === option.value}
              onClick={() => binView.setFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <Select
          value={binView.sort}
          onChange={binView.setSort}
          options={SORT_OPTIONS}
          label="Sort media"
          className="bin-sort"
        />
      </div>

      <div
        ref={scrollRef}
        className={`bin-root${dropTarget === ROOT ? ' is-drop-target' : ''}${
          fileDragActive ? ' is-file-drag' : ''
        }`}
        aria-label="bin root"
        onDragOver={(event) => onDragOver(event, ROOT)}
        onDragLeave={() => {
          setDropTarget((t) => (t === ROOT ? null : t));
          setFileDragActive(false);
        }}
        onDrop={(event) => onDropInto(event, null)}
      >
        {/* Placeholders sit above the real bin so newly imported media appears to
            resolve in place, and so the first-ever import replaces the empty
            state with skeletons instead of leaving "No media yet" on screen. */}
        {isImporting && !isSearching && renderPendingImports()}
        {isSearching ? (
          renderSearchResults()
        ) : isEmpty && !creatingRoot ? (
          isImporting ? null : (
            // First run: name what goes here and give the action, rather than
            // describing a button the user then has to go find (§"empty states").
            <div className="bin-empty" role="note">
              <Film size={ICON_SIZE.lg} aria-hidden="true" />
              <p className="bin-empty-title">No media yet</p>
              <p className="bin-empty-hint">Import video, audio, or images, or drag files here.</p>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => inputRef.current?.click()}
              >
                Import media
              </Button>
            </div>
          )
        ) : isFlatView && rows.length === 0 ? (
          // Empty *by filter* is a different state from empty-by-nothing: the way
          // out is to widen the filter, not to import.
          <div className="bin-empty" role="note">
            <p className="bin-empty-title">
              No {FILTER_OPTIONS.find((o) => o.value === binView.filter)?.label.toLowerCase()}{' '}
              assets.
            </p>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => binView.setFilter('all')}
            >
              Show all media
            </Button>
          </div>
        ) : (
          // Only the rows in view are mounted (windowing): the sized container
          // reserves the full scroll height while each visible row is absolutely
          // positioned at its offset. Depth indents nested folders/assets.
          <div
            className="bin-list bin-vlist"
            // `role="list"` so the `aria-label` is honoured and the cards'
            // `role="listitem"` have the parent they were always missing; the
            // positioned windowing wrappers in between are presentational, which
            // keeps the list's item structure flat for assistive tech.
            role="list"
            aria-label="assets"
            style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]!;
              return (
                <div
                  key={rowKey(row)}
                  data-index={item.index}
                  className="bin-vrow"
                  role="presentation"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${item.size}px`,
                    transform: `translateY(${item.start}px)`,
                    paddingLeft: `${row.depth * DEPTH_INDENT}px`,
                  }}
                >
                  {renderRow(row)}
                </div>
              );
            })}
          </div>
        )}
        {fileDragActive && (
          <div className="bin-drop-overlay" aria-hidden="true">
            Drop files to import
          </div>
        )}
      </div>

      {status && (
        <p className="panel-status" role="status" aria-label="import status">
          {status}
        </p>
      )}
    </section>
  );
}
