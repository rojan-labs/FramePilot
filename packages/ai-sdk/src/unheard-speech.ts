/**
 * @framepilot/ai-sdk/unheard-speech — "the transcript exists, but nobody hears it".
 *
 * ## Why this is said out loud
 *
 * The timeline map records whether each clip's sound reaches the mix (`clipIsAudible` in
 * editor-core), and `mapTranscript` skips the silent ones, so captions, the mapped transcript
 * and every check built on them describe what the viewer HEARS. Desktop run `001be135` is the
 * shape that exposed it: the project transcript belonged to the recap video `asset_ro`, every
 * clip of which sat on a muted track, while the narration the viewer hears was a separate
 * voiceover asset nobody had transcribed. Mapped honestly, that edit carries no speech at
 * all — and "no speech survives" or an empty caption track, with nothing else said, reads as
 * a bug, or as a reason to retry the same call.
 *
 * The facts are all in the project: which asset the words belong to, that its clips are
 * silenced, and which audible assets have no transcript. Naming them is information, not a
 * rule — the tools still do exactly what they did.
 */
import {
  buildTimelineMap,
  mapTranscript,
  spanIsFrozen,
  speechAssetIdsFor,
  type TimelineMap,
} from '@framepilot/editor-core';
import type { Asset, Project } from '@framepilot/timeline-schema';

/** An asset as the model reads it: its id, which tools take, and its file name. */
export interface NamedAsset {
  readonly id: string;
  readonly name: string;
}

/** Transcript speech the edit keeps, but only on clips whose sound is silenced. */
export interface UnheardSpeech {
  /** Transcript words that survive the cuts but play only on silenced clips. */
  readonly wordCount: number;
  /** The assets those silenced clips play. */
  readonly mutedAssets: readonly NamedAsset[];
  /** Audible audio/video assets on the timeline that no transcript word belongs to. */
  readonly untranscribed: readonly NamedAsset[];
}

/** The file name an editor recognises, from the asset's path. */
const fileName = (asset: Asset): string => asset.path.split(/[\\/]/).pop() ?? asset.path;

const named = (assets: readonly Asset[], ids: Iterable<string>): NamedAsset[] => {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  return [...ids].flatMap((id) => {
    const asset = byId.get(id);
    return asset === undefined ? [] : [{ id, name: fileName(asset) }];
  });
};

/**
 * The transcript's speech when the edit keeps some of it but NONE of it is heard, or
 * `undefined` — no transcript, some of it heard, or all of it cut.
 *
 * @param project - The project to read.
 * @param map - Its timeline map, when the caller already built one.
 */
export function findUnheardSpeech(
  project: Project,
  map: TimelineMap = buildTimelineMap(project.timeline),
): UnheardSpeech | undefined {
  if (project.transcript.length === 0) return undefined;
  const speechAssetIds = speechAssetIdsFor(project.assets, project.transcript);
  if (mapTranscript(map, project.transcript, speechAssetIds).words.length > 0) return undefined;
  // The same mapping with every clip treated as heard: what WOULD play if nothing were muted.
  const unmuted: TimelineMap = {
    ...map,
    spans: map.spans.map((span) => ({ ...span, audible: true })),
  };
  const retained = mapTranscript(unmuted, project.transcript, speechAssetIds);
  if (retained.words.length === 0) return undefined;

  const mutedIds = new Set(retained.words.map((word) => word.assetId));
  const transcribedIds = new Set<string>(mutedIds);
  for (const word of project.transcript) {
    if (word.assetId != null) transcribedIds.add(word.assetId);
  }
  const audibleIds = new Set(
    map.spans
      .filter((span) => span.audible !== false && !spanIsFrozen(span))
      .map((span) => span.assetId)
      .filter((id) => !transcribedIds.has(id)),
  );
  const media = project.assets.filter((asset) => asset.kind !== 'image');
  return {
    wordCount: retained.words.length,
    mutedAssets: named(project.assets, mutedIds),
    untranscribed: named(media, audibleIds),
  };
}

const list = (assets: readonly NamedAsset[]): string =>
  assets.map((asset) => `"${asset.name}" (${asset.id})`).join(', ');

/**
 * The sentence that says what {@link findUnheardSpeech} found, naming the assets and the call
 * that captions what is heard.
 */
export function describeUnheardSpeech(unheard: UnheardSpeech): string {
  const words = `${String(unheard.wordCount)} transcript word${unheard.wordCount === 1 ? '' : 's'}`;
  const where =
    unheard.mutedAssets.length > 0
      ? ` — every clip of ${list(unheard.mutedAssets)} that carries them is on a muted track or has its own sound muted`
      : '';
  const head =
    `The edit keeps ${words}, but nobody hears them${where}, so there is no heard speech to ` +
    'caption or quote from this transcript.';
  if (unheard.untranscribed.length === 0) {
    return `${head} Nothing audible on the timeline has a transcript either.`;
  }
  const first = unheard.untranscribed[0]!;
  return (
    `${head} Audible on the timeline with no transcript: ${list(unheard.untranscribed)}. ` +
    `If that is the speech the viewer hears, transcribe { assetId: "${first.id}" } is how to ` +
    'caption it.'
  );
}

/**
 * {@link describeUnheardSpeech} for `project`, or `''` when its transcript is heard (or absent).
 */
export function unheardSpeechNote(project: Project, map?: TimelineMap): string {
  const unheard = findUnheardSpeech(project, map);
  return unheard === undefined ? '' : describeUnheardSpeech(unheard);
}
