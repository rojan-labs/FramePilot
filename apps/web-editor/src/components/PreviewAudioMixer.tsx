/**
 * Preview audio mixer — the missing audio bus for the program monitor.
 *
 * The {@link PreviewPlayer} rides a single `<video>` element, so *footage* audio
 * plays for free, but audio-only clips (music, voiceover, SFX) on their own
 * layers have no element and were silent. This component mounts one hidden
 * `<audio>` per audio-only clip active at the playhead (the pure
 * `audibleAudioAt` projection), seeks it to the right source offset, sets
 * its volume from the clip's gain/mute, and plays/pauses it with the shared
 * transport — so the music you see on the timeline is the music you hear.
 *
 * Render-vs-preview (AGENTS.md invariant 4): this is *playback*, not media
 * compute — we only drive HTMLMediaElement `currentTime`/`volume`, never DSP.
 * The Python engine remains the sole renderer. The volume it is handed, though,
 * is the engine's own envelope sampled at the playhead (`previewClipVolume`):
 * gain, fades and ducking. A monitor that played a ducked bed flat was loudest
 * exactly where the render is quietest, which read to the editor as "the music
 * is drowning my voice" about a mix that was already correct. Normalize and
 * keyframed automation lanes remain engine-truth.
 *
 * Track solo (H0.4 J2) is folded in here too: it is session-local monitoring
 * state (never the project, never a patch — see `useTrackLayout.ts`), but it
 * must still drive what you actually hear, so the caller passes the soloed
 * track ids through and {@link audibleAudioAt} resolves the effective mute.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { Asset } from '@framepilot/timeline-schema';
import { usePlayhead, type UseEditor } from '../editor/useEditor.js';
import { mediaSrc } from '../editor/media.js';
import { audibleAudioAt, createPlaybackIndex } from '../editor/selectors.js';

const NO_SOLO: ReadonlySet<string> = new Set();

export interface PreviewAudioMixerProps {
  readonly editor: UseEditor;
  /** Project assets, used to resolve each audio clip's source media + kind. */
  readonly assets: readonly Asset[];
  /** Track ids currently soloed for preview monitoring (H0.4); empty = none. */
  readonly soloedTrackIds?: ReadonlySet<string>;
  /**
   * Force-silence this mixer regardless of clip/track settings (AI review
   * player side-by-side compare, H1.5/J3): the BEFORE panel mounts a full
   * `PreviewPlayer` next to AFTER's, and only one side should be heard.
   */
  readonly muted?: boolean;
  /**
   * MONITOR volume (0..1) — the transport's volume control (revamp Phase 2).
   * Scales every clip's own computed gain so one control governs everything the
   * editor plays, footage and music alike. Monitoring only: it never touches the
   * clip's `audio_gain`, the project, or the render (invariant 5). Defaults to
   * unity so every existing caller is unchanged.
   */
  readonly monitorVolume?: number;
}

/** Re-seek an audio element only past this gross mismatch while playing (s). */
const RESYNC_THRESHOLD_SECONDS = 0.5;

/** HTMLMediaElement.volume is clamped to [0,1]; positive gain would throw. */
const clampVolume = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function PreviewAudioMixer({
  editor,
  assets,
  soloedTrackIds = NO_SOLO,
  muted = false,
  monitorVolume = 1,
}: PreviewAudioMixerProps): JSX.Element {
  const { timeline, playing } = editor.state;
  // Live playhead from the clock: during playback the loop advances only the
  // clock (no reducer dispatch), so the mixer must subscribe here to stay synced.
  const playhead = usePlayhead(editor);
  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  // O(log n) per-frame lookup over a once-per-timeline index (H3/H8).
  const playbackIndex = useMemo(
    () => createPlaybackIndex(timeline, assetById),
    [timeline, assetById],
  );
  // `audibleAudioAt` already excludes effectively-muted tracks (persisted
  // `muted`, overridden by an active solo), so every clip below is meant to be
  // heard — no extra `track.muted` check here (that would ignore solo).
  // `muted` short-circuits to no clips at all: no elements are even mounted,
  // so there is nothing to silence-but-still-decode (cheaper than volume=0).
  const audible = muted ? [] : audibleAudioAt(playbackIndex, assetById, playhead, soloedTrackIds);

  return (
    // aria-hidden: this is an audio bus, not content — nothing to announce.
    <div className="preview-audio-mixer" aria-hidden="true" style={{ display: 'none' }}>
      {audible.map(({ clip, sourceTime, volume }) => {
        const asset = assetById.get(clip.assetId);
        if (!asset) return null;
        return (
          <PreviewAudioTrack
            // Key by clip id: a still-active clip's element persists across the
            // per-frame re-renders (React reconciles by key), so it never
            // restarts; only entering/leaving the active set mounts/unmounts.
            key={clip.id}
            src={mediaSrc(asset.path)}
            sourceTime={sourceTime}
            // The clip's own computed gain, scaled by the monitor level. Two
            // separate concerns multiplied at the last moment: the clip's gain is
            // the EDIT, the monitor level is how loud this room is.
            volume={volume * monitorVolume}
            playing={playing}
          />
        );
      })}
    </div>
  );
}

interface PreviewAudioTrackProps {
  readonly src: string;
  readonly sourceTime: number;
  readonly volume: number;
  readonly playing: boolean;
}

/** One `<audio>` element bound to a single audible clip. */
function PreviewAudioTrack({
  src,
  sourceTime,
  volume,
  playing,
}: PreviewAudioTrackProps): JSX.Element {
  const ref = useRef<HTMLAudioElement>(null);

  // Volume: drive the element gain from the clip's computed volume.
  useEffect(() => {
    const el = ref.current;
    if (el) el.volume = clampVolume(volume);
  }, [volume]);

  /* v8 ignore start -- HTMLMediaElement transport: jsdom has no media clock, so
     playback is verified manually / in e2e, not in the unit suite. */
  // Transport: play/pause with the shared flag (autoplay may be blocked until a
  // user gesture — the timeline clock stays authoritative regardless).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    try {
      if (playing) {
        const started = el.play() as unknown as Promise<void> | undefined;
        if (started && typeof started.catch === 'function') started.catch(() => {});
      } else {
        el.pause();
      }
    } catch {
      /* jsdom / unsupported media: ignore. */
    }
  }, [playing]);

  // Seek: align to the source offset. Paused → snap on any drift (scrub); playing
  // → ride the element's own clock, correcting only a gross mismatch (a scrub
  // mid-play), mirroring the video monitor so smooth playback never re-seeks.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    try {
      const delta = Math.abs(el.currentTime - sourceTime);
      if (!playing) {
        if (delta > 0.001) el.currentTime = sourceTime;
      } else if (delta > RESYNC_THRESHOLD_SECONDS) {
        el.currentTime = sourceTime;
      }
    } catch {
      /* jsdom has no media clock. */
    }
  }, [sourceTime, playing]);
  /* v8 ignore stop */

  return <audio ref={ref} src={src} preload="auto" />;
}
