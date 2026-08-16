/**
 * Media tools — finding footage, and knowing what is in it.
 *
 * Text search, visual search, similarity, description, the footage map, indexing,
 * and scene detection are one subject: everything here answers "what do I have
 * and where is the bit I want", which is the question that precedes every edit.
 * They were previously scattered through a by-kind analysis array alongside
 * colour measurement and frame grabs, which share a *mechanism* — the host runs
 * them — but not a subject.
 */
import { z } from 'zod/v4';
import type { ToolSpec } from '../tool-registry.js';
import { analysisTool } from './tool-factories.js';
import { boolean, filterString, numeric, seconds } from './tool-args.js';

const detectScenesSchema = z
  .object({
    assetId: filterString(),
    threshold: numeric(z.number().min(0).max(1)).optional(),
  })
  .strict();

// `search_media` mirrors the Python `SearchMediaArgs`; the sidecar matches over the
// brain's FTS index (plan B2.2), so the host executes it like the other analyses.
const searchMediaSchema = z
  .object({
    query: z.string().min(1),
    limit: numeric(z.number().int().min(1).max(100)).optional(),
  })
  .strict();
// `find_similar` mirrors the Python `FindSimilarArgs`; the sidecar cosine-ranks the
// brain's embeddings and blends with keyword hits (plan B3.3), degrading honestly
// to keyword-only when no embeddings model is configured.
const findSimilarSchema = z
  .object({
    query: z.string().min(1),
    limit: numeric(z.number().int().min(1).max(100)).optional(),
  })
  .strict();
// A `[start, end]` asset-seconds window shared by the visual tools. Mirrors the engine's
// `VisualSearchRequest.timeRange` validation (start <= end). Numeric-string tolerant so an
// OpenAI-compatible provider that stringifies the bounds still passes.
const visualTimeRangeSchema = z
  .tuple([seconds, seconds])
  .refine(([start, end]) => start <= end, { message: 'timeRange start must be <= end.' });
// `search_visual` mirrors the Python `SearchVisualArgs`; the sidecar embeds the query
// cross-modally, runs the vector KNN, and fuses it with caption/transcript recall into
// ranked evidence packets (plan MI5.1/§3.4). `k` mirrors the engine's 1..50 bound.
const searchVisualSchema = z
  .object({
    query: z.string().min(1),
    k: numeric(z.number().int().min(1).max(50)).optional(),
    assetIds: z.array(z.string()).optional(),
    timeRange: visualTimeRangeSchema.optional(),
  })
  .strict();
// `describe_footage` mirrors the Python `DescribeFootageArgs`; the host issues a
// time-ordered visual read of ONE asset (plan §3.5) over the same `/brain/visual/search`
// substrate, so the model gets a "what am I looking at" primer without a query to craft.
const describeFootageSchema = z
  .object({
    assetId: z.string(),
    timeRange: visualTimeRangeSchema.optional(),
  })
  .strict();
// `map_footage` mirrors the Python `FootageMapRequest` (plan FI3.2); the host issues a
// time-ordered structural digest — chapters + highlights + summary — of the whole
// project (or ONE asset), with NO query. This is the first move on unfamiliar or long
// footage: get the map, then drill in with describe_footage / search_visual. `refresh`
// forces a recompute past the cached map.
const mapFootageSchema = z
  .object({
    assetId: filterString(),
    refresh: boolean().optional(),
  })
  .strict();
// `index_media` mirrors the Python `IndexMediaArgs`; the host drives the paced
// `/brain/visual/index` job (plan MI4.1) to completion (`wait`, default true) or one
// slice. `assetId` narrows the worklist; omitted indexes every visual asset the brain knows.
// `get_frame` renders ONE composited still of the timeline through the SAME compiler the
// export uses, and hands it to the model as an image. This is the only way the model can
// check what an edit LOOKS like: a caption overflowing the safe area, a punch-in cropping
// someone's head, a title on a background too busy to read — none of that is visible in
// any JSON the other read tools return.

const indexMediaSchema = z
  .object({
    assetId: filterString(),
    wait: boolean().optional(),
  })
  .strict();
// `session_context` mirrors the Python `SessionContextArgs`; it takes no arguments —
// the project is implied by the session (plan B6.3). Strict-empty so a model that
// invents parameters is rejected rather than silently ignored.

export const MEDIA_TOOLS: readonly ToolSpec[] = [
  analysisTool(
    {
      name: 'detect_scenes',
      description:
        "Detect scene-cut timestamps in an asset's video (ffmpeg scene score). " +
        'Returns cut times; does not edit the timeline.',
    },
    detectScenesSchema,
  ),
  analysisTool(
    {
      name: 'search_media',
      description:
        'Full-text search over the transcript, markers, and asset names — use for ' +
        '"find where I said X" instead of reading the whole transcript. Returns ranked ' +
        'hits { type, assetId?, markerId?, start, end, snippet, score } with times in ' +
        'timeline seconds (asset hits add clip placements); does not edit the timeline.',
    },
    searchMediaSchema,
  ),
  analysisTool(
    {
      name: 'find_similar',
      description:
        'Semantic similarity search over the project\'s media — use for "find moments ' +
        'like X" / "shots similar to this" where exact words may differ. Returns ranked ' +
        'hits like search_media; blends meaning-based and keyword matches when an ' +
        'embeddings model is configured, and honestly degrades to keyword-only when ' +
        'not (the result says which). Does not edit the timeline.',
    },
    findSimilarSchema,
  ),
  analysisTool(
    {
      name: 'search_visual',
      description:
        'Search what is actually ON SCREEN across the footage — the primary way to GROUND ' +
        'any content-dependent edit ("cut to the product shot", "where does the whiteboard ' +
        'appear", "find the b-roll of the city"). Retrieves ranked evidence packets ' +
        '{ assetId, t0, t1 (asset seconds), sceneId, score, caption, transcriptOverlap, ' +
        'sources } fusing visual-vector, caption, and transcript recall. Prefer this over ' +
        'guessing from dialogue: read the captions/spans and cite them. Honestly degrades ' +
        '(available with a reason, no packets) when the footage is not indexed or no ' +
        'embedding key is set. Optional k (1-50), assetIds, and timeRange narrow recall. ' +
        'Does not edit the timeline.',
      capabilities: ['analysis', 'visual'],
    },
    searchVisualSchema,
  ),
  analysisTool(
    {
      name: 'describe_footage',
      description:
        'Walk ONE asset in time order — its scene captions and spans from start to end — ' +
        'the "what am I looking at" primer before you plan cuts on it. Returns the same ' +
        'evidence packets as search_visual, sorted by time rather than ranked by a query, ' +
        'so you can read the footage as a sequence. Use search_visual instead when you are ' +
        'looking for a specific thing across all footage. Optional timeRange limits the ' +
        'walk. Honestly reports when the asset is not indexed yet. Does not edit the timeline.',
      capabilities: ['analysis', 'visual'],
    },
    describeFootageSchema,
  ),
  analysisTool(
    {
      name: 'map_footage',
      description:
        'Map the WHOLE footage with no query — the FIRST move on unfamiliar or long ' +
        'material before you plan any edit. Returns a time-ordered digest ' +
        '{ chapters: [{ t0, t1, title, summary }], highlights: [{ t0, t1, label, score }], ' +
        'summary, durationSec } in timeline seconds, so you can see the story shape at a ' +
        'glance and decide where to cut, tighten, punch in, or reframe. Then drill into a ' +
        'chapter with describe_footage / search_visual. Optional assetId maps just one ' +
        'asset; refresh recomputes past the cache. Honestly reports when the footage is not ' +
        'indexed yet or generative understanding is unavailable. Does not edit the timeline.',
      capabilities: ['analysis', 'visual'],
    },
    mapFootageSchema,
  ),
  analysisTool(
    {
      name: 'index_media',
      description:
        'Build (or finish) the visual index so search_visual and describe_footage can see ' +
        'the footage: samples frames, embeds them, and captions scenes. Call it when a ' +
        'visual search reports the footage is not indexed yet. By default it waits until ' +
        'indexing is complete (wait: false returns after starting, to continue in the ' +
        'background); assetId indexes just that asset, omitted indexes every video/image ' +
        'the project knows. Needs an embedding key configured — reports honestly when none ' +
        'is set. Does not edit the timeline.',
      capabilities: ['analysis', 'visual'],
    },
    indexMediaSchema,
  ),
];
