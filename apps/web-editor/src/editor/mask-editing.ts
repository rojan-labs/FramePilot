/**
 * The UI's one route for mask edits (MK4.4): compile a typed mask command against the editor's
 * current timeline and assets, and commit the resulting patch through the editor's validated
 * path. The Inspector mask panel, the monitor tools and the timeline lanes all call this, and
 * the agent compiles the same commands (`@framepilot/editor-core` `compileMaskCommand`), so a
 * hand edit and an agent edit of the same intent produce the same operations.
 */
import { createLogger } from '@framepilot/shared-types';
import {
  assetDisplaySize,
  compileMaskCommand,
  encodeMaskPath,
  MEASURE_MEDIA_FIRST,
  maskSourceTime,
  type MaskClipboard,
  type MaskCommand,
  type MaskGeometry,
} from '@framepilot/editor-core';
import {
  masksOf,
  type Asset,
  type Clip,
  type MaskLayer,
  type Timeline,
} from '@framepilot/timeline-schema';
import type { UseEditor } from './useEditor.js';

const log = createLogger('web-editor:mask-editing');

/** A mask command without the revision the runner stamps. */
export type MaskCommandInput = MaskCommand extends infer Command
  ? Command extends MaskCommand
    ? Omit<Command, 'timelineRevision'>
    : never
  : never;

/** The outcome of one mask edit: `null` when it committed, else the plain refusal. */
export type MaskEditResult = string | null;

/**
 * Compile and commit a mask command as one undoable patch.
 *
 * @param editor - The editor whose state the command applies to.
 * @param input - The command (the runner fills in the current timeline revision).
 * @returns `null` on success, or the refusal text to show.
 */
export function runMaskCommand(editor: UseEditor, input: MaskCommandInput): MaskEditResult {
  const { timeline, assets } = editor.state;
  const command = { ...input, timelineRevision: timeline.revision ?? 0 } as MaskCommand;
  const compiled = compileMaskCommand({ timeline, assets, command });
  if (compiled.status === 'rejected') {
    // "Nothing changed" is a normal outcome of a click that did not move anything.
    if (compiled.code !== 'nothing_to_change') {
      log.warn('mask edit refused', { type: command.type, code: compiled.code });
    }
    return compiled.code === 'nothing_to_change' ? null : compiled.detail;
  }
  const issues = editor.applyPatchChecked(compiled.patch);
  if (issues.length > 0) {
    log.warn('mask edit failed validation on commit', { type: command.type });
    return issues.map((issue) => issue.message).join('; ');
  }
  log.action('mask edit committed', {
    type: command.type,
    clipId: command.clipId,
    operations: compiled.patch.operations.length,
  });
  return null;
}

/** A drag or slider in progress that the monitor should composite before it commits. */
export interface LiveMaskPreview {
  readonly clipId: string;
  readonly maskId: string;
  readonly geometry?: MaskGeometry;
  readonly values?: Readonly<Record<string, number>>;
}

/**
 * The timeline the monitor composites while a mask edit is in progress: the edited mask shows
 * the live geometry and values as if static at every instant. Preview only; it is never applied,
 * saved or validated, and the committed edit goes through {@link runMaskCommand}.
 */
export function timelineWithLiveMask(timeline: Timeline, live: LiveMaskPreview): Timeline {
  const overridden = new Set<string>(Object.keys(live.values ?? {}));
  const fields: Record<string, unknown> = { ...(live.values ?? {}) };
  if (live.geometry !== undefined && live.geometry.kind !== 'path') {
    for (const [key, value] of Object.entries(live.geometry)) {
      if (key === 'kind') continue;
      fields[key] = value;
      overridden.add(key);
    }
  }
  const replaceMask = (mask: MaskLayer): MaskLayer => {
    const next = {
      ...mask,
      ...fields,
      keyframes: mask.keyframes.filter((keyframe) => !overridden.has(keyframe.property)),
    } as MaskLayer;
    if (live.geometry?.kind === 'path' && next.kind === 'path') {
      const first = next.pathKeyframes[0];
      return {
        ...next,
        pathKeyframes: [
          {
            id: first?.id ?? `${mask.id}__live`,
            sourceTime: first?.sourceTime ?? 0,
            easing: 'linear',
            ...encodeMaskPath(live.geometry.vertices),
          },
        ],
      };
    }
    return next;
  };
  return {
    ...timeline,
    tracks: timeline.tracks.map((track) =>
      track.clips.some((clip) => clip.id === live.clipId)
        ? {
            ...track,
            clips: track.clips.map((clip) =>
              clip.id === live.clipId && clip.masks !== undefined
                ? {
                    ...clip,
                    masks: clip.masks.map((mask) =>
                      mask.id === live.maskId ? replaceMask(mask) : mask,
                    ),
                  }
                : clip,
            ),
          }
        : track,
    ),
  };
}

/** Bisection steps for the source → timeline inverse (2^-48 of a clip: far below a frame). */
const INVERSE_STEPS = 48;

/**
 * The timeline second at which a clip shows asset source second `sourceTime`, clamped to the
 * clip. The inverse of {@link clipSourceTimeAt}, by bisection so speed ramps and reverse play
 * need no special case (the clock is monotone within a clip).
 */
export function clipTimelineTimeForSource(clip: Clip, sourceTime: number): number {
  const duration = Math.max(0, clip.end - clip.start);
  const clampLocal = (local: number): number => clip.start + Math.min(duration, Math.max(0, local));
  // Constant speed has an exact inverse; only a ramp needs the search.
  if (clip.speedRamp === undefined || clip.speedRamp.length === 0) {
    const speed = clip.speed ?? 1;
    if (speed === 0) return clip.start;
    return clampLocal(
      speed > 0 ? (sourceTime - clip.sourceStart) / speed : (sourceTime - clip.sourceEnd) / speed,
    );
  }
  const first = maskSourceTime(clip, 0);
  const last = maskSourceTime(clip, duration);
  const ascending = last >= first;
  let low = 0;
  let high = duration;
  for (let step = 0; step < INVERSE_STEPS; step += 1) {
    const middle = (low + high) / 2;
    const value = maskSourceTime(clip, middle);
    if (value < sourceTime === ascending) low = middle;
    else high = middle;
  }
  return clip.start + (low + high) / 2;
}

/**
 * The asset source second the playhead shows on a clip: the instant mask keyframes are read
 * and written at (ADR 0178: mask keyframes live on the source clock).
 */
export function clipSourceTimeAt(clip: Clip, playhead: number): number {
  const local = Math.max(0, Math.min(clip.end - clip.start, playhead - clip.start));
  return maskSourceTime(clip, local);
}

/**
 * Copy masks of a clip for `paste_masks`: the masks plus what pasting needs to rescale them to
 * another picture (the source size and in-point).
 *
 * @returns The clipboard, or the refusal text (unmeasured media, nothing selected).
 */
export function copyMasks(
  clip: Clip,
  assets: readonly Asset[],
  maskIds: readonly string[],
): MaskClipboard | string {
  const size = assetDisplaySize(assets.find((asset) => asset.id === clip.assetId)?.media);
  if (size === null) return MEASURE_MEDIA_FIRST;
  const wanted = new Set(maskIds);
  const masks = masksOf(clip).filter((mask) => wanted.has(mask.id));
  if (masks.length === 0) return 'Select a mask to copy.';
  return {
    assetId: clip.assetId,
    width: size.width,
    height: size.height,
    sourceStart: clip.sourceStart,
    masks: structuredClone(masks),
  };
}
