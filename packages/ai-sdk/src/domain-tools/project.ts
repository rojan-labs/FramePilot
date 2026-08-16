/**
 * Project tools — the media bin and the markers, not the timeline.
 *
 * What unites these is that they edit the *project* rather than the sequence:
 * assets, folders, and the marker track outlive every arrangement built from
 * them, and they flow through `projectMutateTool` into the same validated,
 * reversible patch pipeline as a trim.
 *
 * `list_assets` is here with them despite being a read. It is the tool whose
 * blank-filter tolerance and empty-bin note exist *because* of how this bin is
 * shaped — a filter matching nothing once read as an empty project and sent the
 * agent asking for footage that was already imported. That reasoning belongs
 * next to the bin, not in a read array with the timeline queries.
 */
import { z } from 'zod/v4';
import type { Asset } from '@framepilot/timeline-schema';
import type { ProjectOperation } from '@framepilot/editor-core';
import { toModelAssets } from '../model-view.js';
import type { ToolContext } from '../tool-context.js';
import type { ToolSpec } from '../tool-registry.js';
import { projectMutateTool, readTool } from './tool-factories.js';
import { filterString, id, seconds } from './tool-args.js';

const listAssetsSchema = z
  .object({
    kind: z.enum(['video', 'audio', 'image']).optional(),
    folderId: filterString(),
  })
  .strict();
/**
 * The line `list_assets` adds when its filters excluded every asset in a NON-empty bin.
 * States what the bin actually holds so a narrow filter can never be mistaken for an
 * empty project — the failure this exists to prevent (see {@link blankToUndefined}).
 */
export function emptyFilterNote(assets: readonly Asset[]): string {
  const tally = (['video', 'audio', 'image'] as const)
    .map((kind) => ({ kind, count: assets.filter((asset) => asset.kind === kind).length }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.count} ${entry.kind}`)
    .join(', ');
  return (
    `No asset matched this filter, but the media bin is NOT empty — it holds ` +
    `${assets.length} asset(s): ${tally}. Call list_assets with no arguments to see them all.`
  );
}

// ---------------------------------------------------------------------------
// Project (media-bin) mutating tools — assets & folders (schema v3, ADR 0026)
// ---------------------------------------------------------------------------

/** Deterministic, filesystem-safe asset id derived from a media path. */
const assetIdFromPath = (path: string): string =>
  `asset_${path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'media'}`;

/** Canonical by-kind folders for the deterministic `manage_assets` fallback. */
const KIND_FOLDERS: Record<Asset['kind'], { id: string; name: string }> = {
  video: { id: 'folder_video', name: 'Video' },
  audio: { id: 'folder_audio', name: 'Audio' },
  image: { id: 'folder_images', name: 'Images' },
};

const addAssetSchema = z
  .object({
    path: z.string(),
    kind: z.enum(['video', 'audio', 'image']).default('video'),
    durationSeconds: seconds.optional(),
    folderId: filterString(),
    /** Explicit id; a deterministic id is derived from `path` when omitted. */
    id: filterString(),
  })
  .strict();

const folderPlanSchema = z
  .object({ id: z.string(), name: z.string(), parentId: z.string().nullable().optional() })
  .strict();
const assignmentSchema = z
  .object({ assetId: z.string(), folderId: z.string().nullable() })
  .strict();
const manageAssetsSchema = z
  .object({
    /**
     * `'by-kind'` (or no plan at all) deterministically groups existing assets into
     * Video/Audio/Images folders. Otherwise provide an explicit semantic plan.
     */
    strategy: z.enum(['by-kind', 'plan']).optional(),
    folders: z.array(folderPlanSchema).optional(),
    assignments: z.array(assignmentSchema).optional(),
  })
  .strict();

/** Group the project's assets into by-kind folders (create folder, then assign). */
function organizeByKind(ctx: ToolContext): ProjectOperation[] {
  const ops: ProjectOperation[] = [];
  const existing = new Set(ctx.project.folders.map((f) => f.id));
  const usedKinds = new Set(ctx.project.assets.map((a) => a.kind));
  for (const kind of ['video', 'audio', 'image'] as const) {
    if (!usedKinds.has(kind) || existing.has(KIND_FOLDERS[kind].id)) continue;
    const f = KIND_FOLDERS[kind];
    ops.push({ type: 'create_folder', folderId: f.id, name: f.name, parentId: null });
  }
  for (const asset of ctx.project.assets) {
    const target = KIND_FOLDERS[asset.kind].id;
    if (asset.folderId !== target)
      ops.push({ type: 'move_asset', assetId: asset.id, folderId: target });
  }
  return ops;
}

export const PROJECT_TOOLS: readonly ToolSpec[] = [
  readTool(
    {
      name: 'list_assets',
      description:
        'List the media-bin assets and folders. A focused, cheaper read than ' +
        'get_project_state when you only need the media library — optionally filter ' +
        'by kind (video/audio/image) and/or folderId — OMIT a filter you do not need ' +
        'rather than passing an empty value. Returns { assets, folders }, ' +
        'each asset as { id, path, kind, durationSeconds, folderId }.',
    },
    listAssetsSchema,
    (a, ctx) => {
      let assets = ctx.project.assets;
      if (a.kind !== undefined) assets = assets.filter((asset) => asset.kind === a.kind);
      if (a.folderId !== undefined)
        assets = assets.filter((asset) => asset.folderId === a.folderId);
      // Engine-derived render data (waveform peaks, thumbnails, proxy) is stripped —
      // see model-view.ts. The timeline canvas reads it from the project; a bin listing
      // exists to hand you real asset ids.
      return {
        assets: toModelAssets(assets),
        folders: ctx.project.folders,
        // A filter that matches nothing and an empty bin are the same `{ assets: [] }`
        // to a reader, and the agent has repeatedly read the first as the second — then
        // told the user to import media that was already there. Say which one it is.
        ...(assets.length === 0 && ctx.project.assets.length > 0
          ? { note: emptyFilterNote(ctx.project.assets) }
          : {}),
      };
    },
  ),
  projectMutateTool(
    {
      name: 'add_asset',
      description:
        'Add a media asset to the project bin (e.g. a file an AI model just ' +
        'generated). Does not place it on the timeline — use add_clip for that.',
    },
    addAssetSchema,
    (a) => {
      const asset: Asset = {
        id: a.id ?? assetIdFromPath(a.path),
        path: a.path,
        kind: a.kind,
        ...(a.durationSeconds !== undefined ? { durationSeconds: a.durationSeconds } : {}),
        ...(a.folderId !== undefined ? { folderId: a.folderId } : {}),
      };
      return [{ type: 'add_asset', asset }];
    },
  ),
  projectMutateTool(
    {
      name: 'manage_assets',
      description:
        'Organize the media bin into folders. Provide an explicit semantic plan ' +
        '(folders + assignments) to group assets by meaning (e.g. "B-roll", ' +
        '"Music"), or pass strategy="by-kind" to auto-group into Video/Audio/Images.',
    },
    manageAssetsSchema,
    (a, ctx) => {
      const hasPlan = (a.folders?.length ?? 0) > 0 || (a.assignments?.length ?? 0) > 0;
      if (a.strategy === 'by-kind' || !hasPlan) return organizeByKind(ctx);
      const ops: ProjectOperation[] = [];
      for (const f of a.folders ?? []) {
        ops.push({
          type: 'create_folder',
          folderId: f.id,
          name: f.name,
          parentId: f.parentId ?? null,
        });
      }
      for (const asset of a.assignments ?? []) {
        ops.push({ type: 'move_asset', assetId: asset.assetId, folderId: asset.folderId });
      }
      return ops;
    },
  ),
  // --- Markers / chapters (schema v9, H1.2 slice) -------------------------
  // Project-scoped timeline landmarks (a bare marker) or named "chapter" points
  // (a marker with a label). Reversible via the project patch engine.
  projectMutateTool(
    {
      name: 'add_marker',
      description:
        'Add a marker (or named "chapter" point) at a position on the project timeline ' +
        '(schema v9). Give a time in seconds, an optional label to promote it to a ' +
        'chapter, and an optional CSS color for the scrub-bar. A deterministic id is ' +
        'derived from time+label when none is supplied.',
      capabilities: ['edit', 'markers'],
    },
    z
      .object({
        time: seconds,
        label: z.string().min(1).optional(),
        color: z.string().min(1).optional(),
        /** Explicit id; a deterministic one is derived from time+label when omitted. */
        id: filterString(),
      })
      .strict(),
    (a) => [
      {
        type: 'add_marker',
        id: a.id ?? id('marker', a.time, a.label ?? ''),
        time: a.time,
        ...(a.label !== undefined ? { label: a.label } : {}),
        ...(a.color !== undefined ? { color: a.color } : {}),
      },
    ],
  ),
  projectMutateTool(
    {
      name: 'remove_marker',
      description: 'Remove a marker/chapter by id (schema v9). Reversible.',
      capabilities: ['edit', 'markers'],
    },
    z.object({ id: z.string() }).strict(),
    (a) => [{ type: 'remove_marker', id: a.id }],
  ),
];
