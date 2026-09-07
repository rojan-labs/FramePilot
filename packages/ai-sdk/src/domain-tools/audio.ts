/**
 * Audio tools — the clip's level, and the analyses that tell you where to cut.
 *
 * Silence and beat detection sit here rather than in a generic "analysis" bucket
 * because what they measure is sound: the questions they answer ("where are the
 * gaps", "where is the downbeat") are the ones the level and edit decisions in
 * this domain are made from. Transcription is the same argument — it is what the
 * dialogue track says.
 *
 * The resolver-backed `professional_audio`, which owns EQ, compression, ducking
 * and gain automation, lives in `professional-audio.ts`.
 */
import { z } from 'zod/v4';
import type { ToolSpec } from '../tool-registry.js';
import type { Operation } from '@framepilot/editor-core';
import { analysisTool, mutateTool } from './tool-factories.js';
import { filterString, numeric, seconds } from './tool-args.js';
import { DEFAULT_FILLER_WORDS, fillerCutOps } from '../silence-cut.js';

const transcribeSchema = z
  .object({
    assetId: filterString(),
  })
  .strict();
const analyzeSilenceSchema = z
  .object({
    assetId: filterString(),
    noiseFloorDb: numeric(z.number()).optional(),
    minSilenceSeconds: seconds.optional(),
  })
  .strict();
// `hardSync` was the beat-grid validator's declaration (ADR 0174 retired it). A model that
// learned it — from an older skill text, or its own earlier turns in a resumed session —
// still sends it, and a strict schema would spend a turn on "unrecognized key". Dropped
// silently: it never reached the engine, and nothing acts on it any more.
const detectBeatsSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'object' || value === null || !('hardSync' in value)) return value;
    const { hardSync: _retired, ...rest } = value as Record<string, unknown>;
    return rest;
  },
  z
    .object({
      assetId: filterString(),
      sensitivity: numeric(z.number().min(0.5).max(4)).optional(),
    })
    .strict(),
);

// `add_music` downloads ONE track found by `search_music` and puts it on its own
// music track. The download is a host side effect; the timeline change is the same
// reversible add_asset + add_layer + add_clip patch the Sounds panel builds by hand,
// so an agent-placed bed and a hand-placed one are indistinguishable afterwards —
// including the credit the project records (`Asset.source`, schema v20).
const addMusicSchema = z
  .object({
    remoteId: z.string().min(1),
    atSeconds: seconds.optional(),
    duckUnderTrackId: filterString(),
  })
  .strict();

export const AUDIO_TOOLS: readonly ToolSpec[] = [
  mutateTool(
    {
      name: 'adjust_audio',
      description:
        'Set audio gain (dB, absolute — 0 is unchanged, -18 is a quiet bed) on ONE clip by ' +
        'clipId, or on EVERY clip of a track by trackId in one call: a music bed tiled from ' +
        'a short file is one trackId call, never one call per tile. Give exactly one of the ' +
        'two. To lower a bed only while someone speaks, use professional_audio duck_roles ' +
        'instead.',
      // NOT `derivedFanOut`: that flag is per tool, and it would exempt a one-clip call
      // from the per-turn blast-radius cap too (a repair turn of 200 single adjustments
      // sailed through it). A track-wide call counts one op per clip against the cap,
      // which a tiled bed (eighteen clips in s9-live-all music-bed-quiet) sits well under.
    },
    z
      .object({
        clipId: z.string().min(1).optional(),
        trackId: z.string().min(1).optional(),
        gainDb: numeric(z.number()),
      })
      .strict(),
    (a, ctx) => {
      if ((a.clipId === undefined) === (a.trackId === undefined)) {
        throw new Error('adjust_audio takes exactly one of clipId or trackId.');
      }
      if (a.clipId !== undefined) {
        return [{ type: 'adjust_audio', clipId: a.clipId, gainDb: a.gainDb }];
      }
      const track = ctx.project.timeline.tracks.find((t) => t.id === a.trackId);
      if (!track) {
        throw new Error(
          `Track not found: ${String(a.trackId)}. The tracks in this timeline are: ` +
            `${ctx.project.timeline.tracks.map((t) => t.id).join(', ')}.`,
        );
      }
      if (track.clips.length === 0) {
        throw new Error(`Track ${track.id} has no clips to adjust.`);
      }
      return track.clips.map((clip) => ({
        type: 'adjust_audio' as const,
        clipId: clip.id,
        gainDb: a.gainDb,
      }));
    },
  ),
  mutateTool(
    {
      name: 'remove_filler_words',
      description:
        'Cut the "um"s and "uh"s out of a recording in ONE call: every hesitation word in ' +
        'the transcript (um, uh, er, hmm and the like — pass words to use your own list) is ' +
        'ripple-deleted from the clips that play it, with padSeconds (default 0.04) of ' +
        'breath kept on each side so the neighbouring words are never touched. Needs a ' +
        'transcript — run transcribe first. assetId limits it to one recording, trackId to ' +
        'one track. Reports how many fillers were cut and the seconds removed; if the ' +
        'transcript holds none it says so rather than cutting anything. Use ' +
        'remove_silences for dead air, this for spoken filler. Returns a reversible patch.',
      // One ripple_delete per filler word: the count is a fact about the transcript, not
      // the model's choice — the same reasoning as remove_silences and caption_the_edit.
      derivedFanOut: true,
    },
    z
      .object({
        assetId: z.string().min(1).optional(),
        trackId: z.string().min(1).optional(),
        words: z.array(z.string().min(1)).min(1).max(50).optional(),
        padSeconds: numeric(z.number().min(0).max(0.5)).optional(),
      })
      .strict(),
    (a, ctx) => {
      if (ctx.project.transcript.length === 0) {
        throw new Error(
          'remove_filler_words: this project has no transcript yet, so there are no words ' +
            'to find. Run transcribe first.',
        );
      }
      const { ops, cuts } = fillerCutOps(ctx.project, {
        ...(a.assetId === undefined ? {} : { assetId: a.assetId }),
        ...(a.trackId === undefined ? {} : { trackId: a.trackId }),
        ...(a.words === undefined ? {} : { words: a.words }),
        ...(a.padSeconds === undefined ? {} : { padSeconds: a.padSeconds }),
      });
      if (cuts.length === 0) {
        throw new Error(
          'remove_filler_words: no filler words on the timeline — the transcript has none ' +
            `of ${(a.words ?? DEFAULT_FILLER_WORDS).join(', ')} inside a placed clip. Nothing to cut; ` +
            'do not call this again with the same words.',
        );
      }
      // `ripple_delete`s only — timeline operations.
      return ops as Operation[];
    },
  ),
  analysisTool(
    {
      name: 'transcribe',
      description:
        'Transcribe an audio or video asset with the configured speech-to-text provider. ' +
        'Minutes on a long recording, paid per audio-minute on hosted providers, ' +
        'cached per file. ' +
        'The trusted host produces word timestamps and writes them through a reversible ' +
        'set_transcript patch; never provide transcript words yourself.',
    },
    transcribeSchema,
  ),
  analysisTool(
    {
      name: 'analyze_silence',
      description:
        'Detect silent ranges in an asset\'s audio (ffmpeg silencedetect). "Silent" means ' +
        'below noiseFloorDb (default -30 dB) for at least minSilenceSeconds (default 0.5): ' +
        'on audio with no speech, quiet ambience counts, so answer "is there real silence" ' +
        'from the level, not the count. Seconds of ffmpeg, free, cached per file at default ' +
        'settings. Returns start/end/duration for each gap; does not edit the timeline.',
    },
    analyzeSilenceSchema,
  ),
  analysisTool(
    {
      name: 'detect_beats',
      description:
        "Detect musical beat/onset timestamps in an asset's audio (energy-flux onset " +
        'detection) plus an estimated BPM. Use for beat-synced montage cuts. Seconds of ' +
        'ffmpeg, free, cached per file at default settings. Returns ' +
        'beat times in seconds; does not edit the timeline. Needs an asset that has an ' +
        "audio track — silent footage has no beats, so pass the music asset's id. " +
        "The onsets come back in the music's own seconds; once the bed is on the " +
        'timeline, map_time converts them to timeline time. Where a cut lands against ' +
        'them is your editorial call — nothing snaps or refuses a cut for you, so when ' +
        'the editor asked for cuts on the beat, place each boundary on an onset time ' +
        'exactly as returned.',
    },
    detectBeatsSchema,
  ),
  analysisTool(
    {
      name: 'add_music',
      description:
        'Put a track from search_music under the edit. Pass its remoteId; it lands on ' +
        'its own music track, from atSeconds (default the start), the full length of the ' +
        'track. Give duckUnderTrackId the id of the track carrying the sound the bed must ' +
        'stay out of the way of — narration usually, but a video track counts when its ' +
        'own audio is what you mean. The track must have clips on it; if a refusal says ' +
        'it does not, it names the tracks that do. Downloads the ' +
        'file into the project, so it keeps working offline. If the track requires ' +
        'crediting, the project records the credit and says so. Undoing removes the ' +
        'track, its layer and the file reference in one step.',
      // Main-process only, like `search_music` — see the note there.
      hostUiOnly: true,
    },
    addMusicSchema,
  ),
  analysisTool(
    {
      name: 'remove_silences',
      description:
        'Cut the dead air out of a recording in ONE call: measures the silences in the ' +
        'asset that plays on the timeline and ripple-deletes them where that asset is placed, ' +
        'keeping keepSeconds of breath on each side so words never touch. Use this instead of ' +
        'analyze_silence followed by many delete_range calls. Seconds of ffmpeg, free, and ' +
        'the measurement is cached per file. assetId names the recording ' +
        '(default: the asset under the first picture clip); minSilenceSeconds (default 0.5) is ' +
        'the shortest pause that counts as dead air — 0.25-0.35 for short-form, 0.8-1.0 to leave ' +
        'long-form room to breathe; noiseFloorDb (default -30) is the level below which audio ' +
        'counts as silent, so lower it to about -40 when room tone or breath is loud enough to ' +
        'hide the gaps; trackId limits the cuts to one track. Returns how many cuts and seconds ' +
        'were removed. If nothing was long enough to cut it reports how many silences it ' +
        'measured and how long the longest one is, so LOWER minSilenceSeconds towards that ' +
        'number rather than raising it. Returns a reversible patch.',
      // Runs in the TS executor (measure via the sidecar, cut in ai-sdk); it never reaches the
      // Python dispatcher, exactly like `add_music`.
      hostUiOnly: true,
      // One ripple_delete per measured silence — ~110 on a ten-minute podcast, and the
      // count is a fact about the recording, not something the model chose. Without this
      // the blast-radius bound is a ceiling on how long a recording may be de-ummed. Same
      // reasoning as `caption_the_edit`; see `ToolSpec.derivedFanOut`.
      derivedFanOut: true,
    },
    z
      .object({
        assetId: z.string().min(1).optional(),
        trackId: z.string().min(1).optional(),
        minSilenceSeconds: z.number().min(0.2).max(10).optional(),
        keepSeconds: z.number().min(0).max(2).optional(),
        noiseFloorDb: z.number().max(0).optional(),
      })
      .strict(),
  ),
];
