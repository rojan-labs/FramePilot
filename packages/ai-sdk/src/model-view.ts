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
};

/** Drop the engine-derived render block and collapse provenance to the one actionable bit. */
export function toModelAsset(asset: Asset): ModelAsset {
  const { media: _media, source, ...rest } = asset;
  return source?.attributionRequired === true ? { ...rest, attributionRequired: true } : rest;
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
