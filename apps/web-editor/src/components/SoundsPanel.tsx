/**
 * Sounds — search a third-party music provider, audition a track, and add it to
 * the timeline as a licensed music bed.
 *
 * ## Licence legibility is the point of this panel
 *
 * **Every** row is labelled: "Credit required · <creator>" linked to the licence
 * text, or "No credit needed". Neither state is silent, because an unlabelled
 * row reads as *unknown* — the one thing a licence badge must never mean. A
 * track that obliges a credit is fully usable; adding it records the credit in
 * the project (`Asset.source`, schema v20) and the export dialog's Credits
 * section reads it back. Non-commercial tracks never reach this list at all —
 * they are refused at the adapter, because no badge makes one safe in a
 * sponsored video (ADR 0138).
 *
 * ## No provider URL is in this file
 *
 * Search returns tracks with no `previewUrl` or `downloadUrl`. Auditioning asks
 * main for bytes and wraps them in a `blob:` URL, which the existing CSP already
 * permits. The renderer has nothing to reach a provider host *with*, which is
 * what makes the guarantee structural.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Asset, Project } from '@framepilot/timeline-schema';
import { Button } from '@framepilot/ui';
import {
  isDesktop,
  musicDownload,
  musicDownloadCancel,
  musicPreview,
  musicSearch,
  type MusicErrorCodeWire,
  type MusicTrackWire,
} from '../editor/bridge.js';
import { musicDownloads, useDownloads } from '../editor/download-registry.js';
import { ICON_SIZE, Music, Pause, Play, X } from './icons.js';

/** Typing pause before a search fires. Long enough to not bill every keystroke. */
const SEARCH_DEBOUNCE_MS = 300;
/** Skeleton rows shown during the first search, at real row height. */
const SKELETON_ROWS = 6;

export interface SoundsPanelProps {
  readonly project: Project;
  /**
   * Add the downloaded track to the bin and place it on a `music` layer, as one
   * undoable patch. Owned by the caller because it holds the editor store.
   */
  readonly onAddMusic: (asset: Asset) => void;
}

/**
 * What a row is doing right now.
 *
 * The audition half lives in component state — it is tied to an `Audio` element
 * this mount owns, and stopping on unmount is the correct behaviour. The
 * download half comes from {@link musicDownloads} instead, because a download
 * outlives the panel: see `download-registry.ts`.
 */
type RowState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'previewLoading' }
  | { readonly kind: 'playing' }
  | { readonly kind: 'previewFailed'; readonly message: string }
  | { readonly kind: 'downloading'; readonly operationId: string; readonly percent: number | null }
  | { readonly kind: 'downloadFailed'; readonly message: string };

type SearchState =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'results';
      readonly tracks: readonly MusicTrackWire[];
      readonly stale: boolean;
    }
  | { readonly kind: 'noResults'; readonly query: string }
  | { readonly kind: 'error'; readonly message: string };

/** The sentence for each failure. No generic "something went wrong". */
function errorMessage(code: MusicErrorCodeWire, detail?: string): string {
  switch (code) {
    case 'unauthorized':
      return 'The music provider rejected this request.';
    case 'rate_limited':
      return detail
        ? `Too many searches in a row — try again shortly (${detail}).`
        : 'Too many searches in a row. Try again in a moment.';
    case 'provider_unavailable':
      return 'The music provider is not responding. Try again shortly.';
    case 'offline':
      return 'No network connection.';
    case 'timeout':
      return 'The music provider took too long to answer.';
    case 'cancelled':
      return '';
    case 'non_commercial_only':
      return "This track can't be used in monetized videos, so it wasn't added.";
    case 'disk_full':
      return 'Not enough disk space to save this track.';
    case 'download_failed':
      return "The download didn't finish. Nothing was added.";
    case 'derive_failed':
      return "Saved the track, but couldn't read its waveform.";
  }
}

/** `92` → `1:32`. Duration is the second thing an editor looks at, after the name. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** A stable asset id for a fetched track, so re-adding the same one is detectable. */
export function musicAssetId(track: MusicTrackWire): string {
  return `music_${track.provider}_${track.remoteId}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

export function SoundsPanel({ project, onAddMusic }: SoundsPanelProps): JSX.Element {
  const [query, setQuery] = useState('');
  // Starts loading, not empty: the browse request is fired by the mount effect
  // below, and a skeleton is the honest thing to show while it is in flight.
  const [search, setSearch] = useState<SearchState>({ kind: 'loading' });
  const [rows, setRows] = useState<Readonly<Record<string, RowState>>>({});
  const [playing, setPlaying] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const downloads = useDownloads(musicDownloads);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  /**
   * Which audition is the current one.
   *
   * Two clicks in quick succession leave two `musicPreview` calls in flight, and
   * they can land in either order. Without this the loser's blob would overwrite
   * `blobUrlRef` — leaking the winner's bytes for the life of the document — and
   * its `Audio` element would play on top, unreachable by the next stop because
   * `audioRef` no longer points at it. The generation is captured before the
   * await and re-checked after: only the latest click gets to make sound.
   */
  const auditionGenerationRef = useRef(0);

  /** Assets already in this project, so a duplicate row can say so. */
  const presentRemoteIds = useMemo(
    () =>
      new Set(
        project.assets
          .map((asset) => asset.source?.remoteId)
          .filter((id): id is string => typeof id === 'string'),
      ),
    [project.assets],
  );

  const setRow = useCallback((remoteId: string, state: RowState): void => {
    setRows((current) => ({ ...current, [remoteId]: state }));
  }, []);

  /**
   * The state a row renders.
   *
   * A download outranks the audition: it is the thing with a progress bar, a
   * Cancel, and consequences. It is read from the registry rather than `rows`
   * so it is still there after a tab switch and back.
   */
  const rowState = useCallback(
    (remoteId: string): RowState => {
      const download = downloads[remoteId];
      if (download?.kind === 'downloading') {
        return {
          kind: 'downloading',
          operationId: download.operationId,
          percent: download.percent,
        };
      }
      if (download?.kind === 'failed') {
        return { kind: 'downloadFailed', message: download.message };
      }
      return rows[remoteId] ?? { kind: 'idle' };
    },
    [downloads, rows],
  );

  /** Stop playback and release the blob URL. Called on stop, swap, and unmount. */
  const stopAudition = useCallback((): void => {
    // Any audition still resolving is now stale, including the one being
    // stopped: bumping here is what stops a late `musicPreview` from starting
    // playback the user has already cancelled.
    auditionGenerationRef.current += 1;
    audioRef.current?.pause();
    audioRef.current = null;
    if (blobUrlRef.current !== null) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    setPlaying(null);
  }, []);

  useEffect(() => stopAudition, [stopAudition]);

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  useEffect(() => {
    // An empty box is a browse, not a blank panel: the provider answers without
    // a query, and an editor hunting for a bed usually wants to hear one before
    // they can name what they are after.
    const text = query.trim();

    // Previous results stay visible and dimmed rather than clearing: a list that
    // blanks on every keystroke makes the panel feel broken while it works.
    setSearch((current) =>
      current.kind === 'results' ? { ...current, stale: true } : { kind: 'loading' },
    );

    let cancelled = false;
    // The debounce exists to stop billing a request per keystroke. A browse has
    // no keystrokes, so it fires at once.
    const timer = setTimeout(
      () => {
        void musicSearch(text).then((result) => {
          if (cancelled) return;
          if (!result.ok) {
            if (result.error === 'cancelled') return;
            setSearch({ kind: 'error', message: errorMessage(result.error, result.detail) });
            return;
          }
          setSearch(
            result.tracks.length === 0
              ? { kind: 'noResults', query: text }
              : { kind: 'results', tracks: result.tracks, stale: false },
          );
        });
      },
      text === '' ? 0 : SEARCH_DEBOUNCE_MS,
    );

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  // ---------------------------------------------------------------------------
  // Audition
  // ---------------------------------------------------------------------------

  const audition = useCallback(
    async (track: MusicTrackWire): Promise<void> => {
      // One track at a time: starting another stops the first, which is what an
      // editor comparing beds expects and what stops a pile-up of audio.
      if (playing === track.remoteId) {
        stopAudition();
        setRow(track.remoteId, { kind: 'idle' });
        return;
      }
      stopAudition();
      const generation = auditionGenerationRef.current;
      const isCurrent = (): boolean => auditionGenerationRef.current === generation;

      // The spinner belongs to this row's button only — the list does not enter
      // a loading state, so the other rows stay usable.
      setRow(track.remoteId, { kind: 'previewLoading' });
      const result = await musicPreview(track.remoteId);
      if (!isCurrent()) {
        // Superseded while the bytes were in flight. The row is not touched:
        // whatever the user did instead owns the display now.
        return;
      }
      if (!result.ok) {
        setRow(track.remoteId, {
          kind: 'previewFailed',
          message: errorMessage(result.error, result.detail),
        });
        return;
      }

      const url = URL.createObjectURL(new Blob([result.data], { type: result.contentType }));
      blobUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = (): void => {
        stopAudition();
        setRow(track.remoteId, { kind: 'idle' });
      };
      await audio.play().catch(() => undefined);
      // `play()` is itself awaited, so a stop during it must be honoured —
      // otherwise the row claims to be playing audio that has been paused.
      if (!isCurrent()) return;
      setPlaying(track.remoteId);
      setRow(track.remoteId, { kind: 'playing' });
    },
    [playing, setRow, stopAudition],
  );

  // ---------------------------------------------------------------------------
  // Download
  // ---------------------------------------------------------------------------

  const add = useCallback(
    async (track: MusicTrackWire): Promise<void> => {
      // Guarded here rather than only in the click handler, because the row's
      // Enter shortcut reaches this too — and a second download of a track
      // already in flight would fight the first over the same destination file.
      if (musicDownloads.getSnapshot()[track.remoteId]?.kind === 'downloading') return;
      const operationId = `music_${track.remoteId}_${Date.now()}`;
      // Registered before the await, so switching tabs mid-download and coming
      // back still shows the progress bar and a working Cancel.
      musicDownloads.start(track.remoteId, operationId);
      setRow(track.remoteId, { kind: 'idle' });

      const result = await musicDownload({
        projectId: project.id,
        remoteId: track.remoteId,
        operationId,
      });

      if (!result.ok) {
        // A cancel is not a failure — the user did it deliberately, so the row
        // returns to idle with no error text.
        if (result.error === 'cancelled') musicDownloads.clear(track.remoteId);
        else musicDownloads.fail(track.remoteId, errorMessage(result.error, result.detail));
        return;
      }

      const { asset: downloaded } = result;
      onAddMusic({
        id: musicAssetId(track),
        path: downloaded.relativePath,
        kind: 'audio',
        ...(downloaded.durationSeconds === undefined
          ? {}
          : { durationSeconds: downloaded.durationSeconds }),
        // The wire type is readonly; `Asset` is not, so the arrays are copied
        // rather than cast — a shared frozen array would be a mutation bug
        // waiting for the first in-place edit.
        ...(downloaded.media
          ? {
              media: {
                proxyPath: downloaded.media.proxyPath ?? null,
                peaks: downloaded.media.peaks ? [...downloaded.media.peaks] : null,
                peaksPerSecond: downloaded.media.peaksPerSecond ?? null,
                thumbnailPaths: downloaded.media.thumbnailPaths
                  ? [...downloaded.media.thumbnailPaths]
                  : null,
              },
            }
          : {}),
        source: downloaded.source,
      });
      musicDownloads.clear(track.remoteId);
      setRow(track.remoteId, { kind: 'idle' });
    },
    [onAddMusic, project.id, setRow],
  );

  // ---------------------------------------------------------------------------
  // Keyboard: one tab stop, arrows move between rows (mirrors the bin grid)
  // ---------------------------------------------------------------------------

  /** An empty box lists what the provider offers rather than showing nothing. */
  const browsing = query.trim() === '';
  const tracks = search.kind === 'results' ? search.tracks : [];
  const tabbableId = focusedId ?? tracks[0]?.remoteId ?? null;

  const onRowKeyDown = useCallback(
    (event: React.KeyboardEvent, index: number, track: MusicTrackWire): void => {
      // A row contains its own controls — Cancel, the licence link. Enter and
      // Space belong to whatever is focused, so when focus is INSIDE the row the
      // row must not also act: otherwise Enter on Cancel starts a second
      // download, and Enter on the licence link is swallowed instead of opening
      // the page the user is trying to read before they commit to the track.
      // Arrow navigation still works from anywhere in the row.
      const onRowItself = event.target === event.currentTarget;
      const move = (to: number): void => {
        const clamped = Math.max(0, Math.min(tracks.length - 1, to));
        const next = tracks[clamped];
        if (!next) return;
        event.preventDefault();
        setFocusedId(next.remoteId);
        // By position, not by an attribute selector built from a provider id:
        // a `remoteId` is arbitrary provider text, and escaping it correctly for
        // a selector is a needless dependency on `CSS.escape`.
        listRef.current?.querySelectorAll<HTMLElement>('.sounds-row')[clamped]?.focus();
      };
      switch (event.key) {
        case 'ArrowDown':
          move(index + 1);
          break;
        case 'ArrowUp':
          move(index - 1);
          break;
        case 'Home':
          move(0);
          break;
        case 'End':
          move(tracks.length - 1);
          break;
        case 'Enter':
          if (!onRowItself) break;
          event.preventDefault();
          void add(track);
          break;
        case ' ':
          if (!onRowItself) break;
          event.preventDefault();
          void audition(track);
          break;
        default:
          break;
      }
    },
    [add, audition, tracks],
  );

  // Browser build: the tab is absent entirely (see Editor.tsx). This is the
  // backstop for a direct render, and says why rather than showing a dead input.
  if (!isDesktop()) {
    return (
      <div className="sounds-panel">
        <p className="sounds-note" role="note">
          Music search runs in the FramePilot desktop app, which fetches tracks outside the browser
          sandbox. Open this project in desktop to search for music.
        </p>
      </div>
    );
  }

  return (
    <div className="sounds-panel">
      <label className="sounds-search" htmlFor="sounds-search-input">
        <span className="sr-only">Search for music</span>
        <input
          id="sounds-search-input"
          type="search"
          className="sounds-search-input"
          placeholder="Search music…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      {/* Announced politely so a screen-reader user hears the result count
          without the list stealing focus mid-type. */}
      <span className="sr-only" aria-live="polite">
        {search.kind === 'results' && !search.stale
          ? `${search.tracks.length} track${search.tracks.length === 1 ? '' : 's'} ${
              browsing ? 'shown' : 'found'
            }`
          : ''}
      </span>

      {search.kind === 'loading' && (
        <ul className="sounds-list" aria-busy="true">
          {Array.from({ length: SKELETON_ROWS }, (_, index) => (
            // Real row height, so nothing shifts when the results land.
            <li key={index} className="sounds-row sounds-row--skeleton" aria-hidden="true" />
          ))}
        </ul>
      )}

      {search.kind === 'noResults' && (
        <p className="sounds-hint">
          {search.query === ''
            ? 'The music provider returned no tracks. Search by mood or instrument instead.'
            : `No tracks matched “${search.query}”. Try a broader word — a mood rather than a title.`}
        </p>
      )}

      {search.kind === 'error' && (
        <p className="sounds-error" role="alert">
          {search.message}
        </p>
      )}

      {search.kind === 'results' && (
        <ul
          ref={listRef}
          className={`sounds-list${search.stale ? ' is-stale' : ''}`}
          aria-label={browsing ? 'Openly licensed music' : 'Music search results'}
        >
          {search.tracks.map((track, index) => (
            <SoundRow
              key={track.remoteId}
              track={track}
              index={index}
              state={rowState(track.remoteId)}
              inProject={presentRemoteIds.has(track.remoteId)}
              tabbable={tabbableId === track.remoteId}
              onFocus={() => setFocusedId(track.remoteId)}
              onKeyDown={onRowKeyDown}
              onAudition={() => void audition(track)}
              onAdd={() => void add(track)}
              onCancel={(operationId) => musicDownloadCancel(operationId)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface SoundRowProps {
  readonly track: MusicTrackWire;
  readonly index: number;
  readonly state: RowState;
  readonly inProject: boolean;
  readonly tabbable: boolean;
  readonly onFocus: () => void;
  readonly onKeyDown: (event: React.KeyboardEvent, index: number, track: MusicTrackWire) => void;
  readonly onAudition: () => void;
  readonly onAdd: () => void;
  readonly onCancel: (operationId: string) => void;
}

function SoundRow({
  track,
  index,
  state,
  inProject,
  tabbable,
  onFocus,
  onKeyDown,
  onAudition,
  onAdd,
  onCancel,
}: SoundRowProps): JSX.Element {
  const downloading = state.kind === 'downloading';
  const playing = state.kind === 'playing';

  return (
    <li
      className="sounds-row"
      data-remote-id={track.remoteId}
      tabIndex={tabbable ? 0 : -1}
      onFocus={onFocus}
      onKeyDown={(event) => onKeyDown(event, index, track)}
    >
      <button
        type="button"
        className="sounds-play"
        aria-label={playing ? `Stop ${track.title}` : `Play ${track.title}`}
        disabled={state.kind === 'previewLoading'}
        onClick={onAudition}
      >
        {state.kind === 'previewLoading' ? (
          <span className="sounds-spinner" aria-hidden="true" />
        ) : playing ? (
          <Pause size={ICON_SIZE.sm} aria-hidden="true" />
        ) : (
          <Play size={ICON_SIZE.sm} aria-hidden="true" />
        )}
      </button>

      <div className="sounds-meta">
        <span className="sounds-title">{track.title}</span>
        <span className="sounds-sub">
          <span className="sounds-duration">{formatDuration(track.durationSeconds)}</span>
          {/* Both licence states are labelled. Silence would read as "unknown",
              which is the one thing a licence badge must never mean. */}
          {track.attributionRequired ? (
            <LicenceBadge
              className="sounds-badge sounds-badge--credit"
              href={track.licenseUrl}
              text={track.creator ? `Credit required · ${track.creator}` : 'Credit required'}
            />
          ) : (
            <LicenceBadge
              className="sounds-badge sounds-badge--free"
              href={track.licenseUrl}
              text="No credit needed"
            />
          )}
        </span>
        {state.kind === 'previewFailed' && (
          <span className="sounds-row-error" role="alert">
            {state.message}
          </span>
        )}
        {state.kind === 'downloadFailed' && (
          <span className="sounds-row-error" role="alert">
            {state.message}
          </span>
        )}
      </div>

      {downloading ? (
        <div className="sounds-progress-group">
          <div
            className="sounds-progress"
            role="progressbar"
            aria-label={`Downloading ${track.title}`}
            {...(state.percent === null
              ? {}
              : { 'aria-valuenow': state.percent, 'aria-valuemin': 0, 'aria-valuemax': 100 })}
          >
            <span
              className="sounds-progress-fill"
              style={{ width: `${state.percent ?? 0}%` }}
              aria-hidden="true"
            />
          </div>
          <button
            type="button"
            className="sounds-cancel"
            aria-label={`Cancel downloading ${track.title}`}
            onClick={() => onCancel(state.operationId)}
          >
            <X size={ICON_SIZE.sm} aria-hidden="true" />
          </button>
        </div>
      ) : inProject ? (
        // Already downloaded into this project. Disabled rather than hidden, so
        // the user can see it is theirs already instead of hunting for it.
        <span className="sounds-present">
          <Music size={ICON_SIZE.sm} aria-hidden="true" /> In this project
        </span>
      ) : (
        <Button variant="ghost" type="button" onClick={onAdd}>
          {state.kind === 'downloadFailed' ? 'Retry' : 'Add'}
        </Button>
      )}
    </li>
  );
}

/** The licence label, linked to its terms when the provider gave a URL. */
function LicenceBadge({
  className,
  href,
  text,
}: {
  readonly className: string;
  readonly href?: string | undefined;
  readonly text: string;
}): JSX.Element {
  if (href === undefined) return <span className={className}>{text}</span>;
  return (
    <a className={className} href={href} target="_blank" rel="noreferrer noopener">
      {text}
    </a>
  );
}
