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
        'Set hardSync ONLY when you intend every interior picture cut to sit exactly on an ' +
        'onset: the runtime then holds you to it and rejects a cut it cannot place there. ' +
        'Leave it off — the default — for the far more common case where the music informs ' +
        'the rhythm but the picture leads: near-misses are still snapped for you, and a cut ' +
        'that is deliberately off the grid is reported to you rather than refused.',
    },
    detectBeatsSchema,
  ),
];
