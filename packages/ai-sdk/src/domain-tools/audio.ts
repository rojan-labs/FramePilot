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
import { analysisTool, mutateTool } from './tool-factories.js';
import { filterString, numeric, seconds } from './tool-args.js';

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
const detectBeatsSchema = z
  .object({
    assetId: filterString(),
    sensitivity: numeric(z.number().min(0.5).max(4)).optional(),
    // The EDITORIAL declaration, not an analysis parameter (the engine never sees it):
    // whether you intend every interior picture cut to land exactly on an onset. See the
    // tool description and `kernel/beat-grid/beat-alignment.ts`.
    hardSync: z.boolean().optional(),
  })
  .strict();

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
    { name: 'adjust_audio', description: 'Adjust a clip’s audio gain (dB).' },
    z.object({ clipId: z.string(), gainDb: numeric(z.number()) }).strict(),
    (a) => [{ type: 'adjust_audio', clipId: a.clipId, gainDb: a.gainDb }],
  ),
  analysisTool(
    {
      name: 'transcribe',
      description:
        'Transcribe an audio or video asset with the configured speech-to-text provider. ' +
        'The trusted host produces word timestamps and writes them through a reversible ' +
        'set_transcript patch; never provide transcript words yourself.',
    },
    transcribeSchema,
  ),
  analysisTool(
    {
      name: 'analyze_silence',
      description:
        "Detect silent ranges in an asset's audio (ffmpeg silencedetect). Returns " +
        'start/end/duration for each gap; does not edit the timeline.',
    },
    analyzeSilenceSchema,
  ),
  analysisTool(
    {
      name: 'detect_beats',
      description:
        "Detect musical beat/onset timestamps in an asset's audio (energy-flux onset " +
        'detection) plus an estimated BPM. Use for beat-synced montage cuts. Returns ' +
        'beat times in seconds; does not edit the timeline. Needs an asset that has an ' +
        "audio track — silent footage has no beats, so pass the music asset's id. " +
        'Set hardSync when the editor asked for cuts ON the beat — "cut to the beat", ' +
        '"beat-synced", "on every drop" — because that is a promise about the rhythm and ' +
        'the runtime then holds you to it, rejecting a cut it cannot place on an onset. ' +
        'Leave it off — the default — when the music informs the rhythm but the picture ' +
        'leads, which is the more common case: near-misses are still snapped for you, and ' +
        'a cut deliberately off the grid is reported to you rather than refused.',
    },
    detectBeatsSchema,
  ),
  analysisTool(
    {
      name: 'add_music',
      description:
        'Put a track from search_music under the edit. Pass its remoteId; it lands on ' +
        'its own music track, from atSeconds (default the start), the full length of the ' +
        'track. Give duckUnderTrackId the dialogue track id to have the bed drop under ' +
        'the voice — that is almost always what you want under narration. Downloads the ' +
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
        'analyze_silence followed by many delete_range calls. assetId names the recording ' +
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
