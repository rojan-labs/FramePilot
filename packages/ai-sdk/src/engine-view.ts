/**
 * @framepilot/ai-sdk/engine-view — the project document as an ENGINE route needs it.
 *
 * ## Why this is not `toModelProject`
 *
 * Every sidecar route this package calls — `/render/frame` (`get_frame`),
 * `/review/temporal-evidence` (the post-apply perceptual review and `measure_color`),
 * the analysis and brain routes — inlines the working document. They used to send
 * `toModelProject(project)`, the MODEL's projection, which drops `asset.media` whole on
 * the reasoning that "the engine never reads it".
 *
 * That stopped being true with mask schema v22. A cut-out (every `remove_background`) is
 * a matte stored in source pixels, and the compiler resolves it against
 * `asset.media`'s display size (`render/compiler.py#_asset_media_size`). With `media`
 * stripped the size is unknown and the compile refuses the whole batch:
 *
 *   Temporal evidence engine rejected the batch (500): CompileError: Mask … is stored in
 *   source pixels but the media size is unknown. Measure this media first.
 *
 * So from the first cut-out onwards, every review of a run and every `get_frame` on the
 * masked picture failed — the agent went blind exactly when it was compositing (captured
 * desktop runs of 2026-09-23: seven reviews, zero looks). The export path had already hit
 * the same class of bug and fixed it in `render/queue.py#project_for_render_worker`; this
 * is the same projection, for the same reason, on the AI side.
 *
 * What is dropped is only what is big and never rendered: waveform `peaks` (one float per
 * bucket — megabytes on a real bin, and echoed whole by a FastAPI 422), their rate, the
 * bin thumbnail list, and editor undo history (a history entry can hold inverse patches
 * the size of a transcript). Dimensions, rotation, pixel aspect and the proxy path stay.
 */
import type { Asset, Project } from '@framepilot/timeline-schema';

/** An asset with its engine-derived `media` block minus the parts no render reads. */
export function toEngineAsset(asset: Asset): Asset {
  const media = asset.media;
  if (media === undefined || media === null) return asset;
  const { peaks: _peaks, peaksPerSecond: _rate, thumbnailPaths: _thumbs, ...rest } = media;
  return { ...asset, media: rest };
}

/**
 * The working document for an engine request: every asset keeps its measured size, and
 * nothing the engine never reads is sent.
 *
 * @param project - The live working project.
 * @returns A copy safe to inline in any sidecar request body.
 */
export function toEngineProject(project: Project): Project {
  return { ...project, assets: project.assets.map(toEngineAsset), history: [] };
}
