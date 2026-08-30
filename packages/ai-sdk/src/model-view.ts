/**
 * @framepilot/ai-sdk/model-view — what a read tool hands back to the MODEL.
 *
 * ## Why this exists
 *
 * `list_assets` and `get_project_state` used to return the stored {@link Asset}
 * objects verbatim, including `media` — the engine-derived render data
 * (`media/waveform.py`, `media/derive.py`). That block carries `peaks`: one
 * normalized float per waveform bucket, so a one-minute clip is hundreds of
 * numbers like `0.00894165039...` and a real bin is tens of thousands. None of it
 * is reasoning material: the model never draws a waveform, never opens a proxy,
 * and never picks a thumbnail — those exist for the timeline canvas and the
 * preview player, which read them from the project directly.
 *
 * The cost was not theoretical. Every read's payload is stored in the run's
 * evidence store, whose model-facing preview is the first
 * `EVIDENCE_PREVIEW_CHARS` of the rendered JSON and whose `recall_evidence`
 * answer is the first `EVIDENCE_RECALL_CHARS`. With peaks in the payload, both
 * budgets were spent on a run of waveform floats from the FIRST asset — the ids
 * the read exists to deliver never appeared — and the same numbers were shown in
 * the UI's result popup.
 *
 * Project undo history is excluded for the same reason. A history entry can contain
 * large inverse patches (for example, a transcript replacement), and it is editor
 * recovery state rather than material the model can act on. Returning it once produced
 * a 116 MB `get_project_state` result and exhausted Electron while the durable run WAL
 * validated and replayed that payload.
 *
 * So the projection is applied at the SOURCE, where the tool result is built,
 * rather than at each place a result is later rendered: one strip, and every
 * consumer (log digest, evidence preview, recall, UI popup) is bounded.
 * `source` (provider provenance, schema v20) is collapsed for a related but
 * distinct reason. It is not render data, but eight fields of licence URLs,
 * creator URLs and fetch timestamps are not reasoning material either — the
 * model never opens a licence page. What it can act on is the single fact that
 * a track obliges a credit, so that survives as `attributionRequired` and the
 * rest does not. The full record stays in the project file, where the Credits
 * view reads it (ADR 0138).
 *
 * The Python sidecar mirrors this in `ai_tools/handlers.py`; the two tool
 * surfaces must return the same shape.
 */
import type { Asset, Project } from '@framepilot/timeline-schema';

/**
 * An {@link Asset} as the model sees it: identity, media kind, duration, bin
 * placement, and whether it obliges a credit. `media` and the full `source`
 * record are absent by construction — see the module note.
 */
export type ModelAsset = Omit<Asset, 'media' | 'source'> & {
  /**
   * Present and `true` only for a provider-sourced asset whose licence obliges
   * a credit. Omitted otherwise — including for every user-imported file, which
   * has no provenance at all. Absent means "nothing to credit", never "unknown".
   */
  readonly attributionRequired?: true;
  /**
   * The shape of the source picture, when the engine has probed it (schema v21).
   *
   * Two fields rather than the whole `media` block, for the same reason the block is
   * stripped: `peaks` is thousands of floats the model never reasons over, and orientation
   * is one word it reasons over constantly. A landscape source in a portrait sequence
   * renders with black bars unless the clip carries a crop — `_place_video_clip` fits, it
   * does not cover — and until now nothing told the model which of its assets those were.
   * Run `fc10301a` placed 34 landscape photos in a 1080x1920 frame against a brief that
   * said "no black bars", with no way to know.
   *
   * Omitted when the asset has not been probed. Absent means unknown, never square: a
   * guessed orientation would send a run to crop the wrong axis.
   */
  readonly orientation?: 'landscape' | 'portrait' | 'square';
  /** Width ÷ height, rounded to three places. Omitted with `orientation`. */
  readonly aspect?: number;
  /**
   * Present, and only ever `'unmeasured'`, for PICTURE whose pixel dimensions nobody
   * probed — the honest counterpart to the two fields above.
   *
   * WHY a field for an absence. Omitting `orientation` was already the rule (never guess a
   * shape), but an omission is not a statement: the model reads `{id, path, kind,
   * durationSeconds}` and has nothing to be uncertain about. That silence is what disarmed
   * both letterbox safeguards in the captured talking-head run — `letterboxNote` gates on
   * `orientation` and `critic.ts#checkReframeCoverage`'s fail branch gates on measured
   * dimensions, so an unprobed asset turned both off and the run reported success over a
   * pillarboxed 1080x1920 export.
   *
   * Only picture carries it. Audio has no shape, so a missing one there is not a gap.
   */
  readonly shape?: 'unmeasured';
};

/**
 * The kinds that HAVE a shape.
 *
 * Audio is excluded deliberately: flagging a music bed as "unmeasured" would put a
 * meaningless word on every asset in a bin and teach the model to ignore the field
 * on the assets where it matters.
 */
const PICTURE_KINDS: ReadonlySet<Asset['kind']> = new Set<Asset['kind']>(['video', 'image']);

/** Landscape, portrait or square — or `undefined` when the asset was never probed. */
function shapeOf(
  media: Asset['media'],
): { orientation: 'landscape' | 'portrait' | 'square'; aspect: number } | undefined {
  const width = media?.width;
  const height = media?.height;
  if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) {
    return undefined;
  }
  return {
    orientation: width > height ? 'landscape' : width < height ? 'portrait' : 'square',
    aspect: Math.round((width / height) * 1000) / 1000,
  };
}

/** Drop the engine-derived render block and collapse provenance to the one actionable bit. */
export function toModelAsset(asset: Asset): ModelAsset {
  const { media, source, ...rest } = asset;
  const shape = shapeOf(media);
  return {
    ...rest,
    ...(source?.attributionRequired === true ? { attributionRequired: true } : {}),
    // Measured shape, or an explicit statement that nobody measured it. Never both, and
    // never neither for picture — see `ModelAsset.shape`.
    ...(shape ?? (PICTURE_KINDS.has(asset.kind) ? { shape: 'unmeasured' as const } : {})),
  };
}

export function toModelAssets(assets: readonly Asset[]): ModelAsset[] {
  return assets.map(toModelAsset);
}

/**
 * The project document as the model sees it: current editable state without
 * engine-derived asset media or editor-only undo history.
 */
export function toModelProject(project: Project): Omit<Project, 'assets'> & {
  readonly assets: ModelAsset[];
} {
  return { ...project, assets: toModelAssets(project.assets), history: [] };
}
