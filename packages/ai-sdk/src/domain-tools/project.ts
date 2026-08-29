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
import { type ModelAsset, toModelAssets } from '../model-view.js';
import type { ToolContext } from '../tool-context.js';
import type { ToolSpec } from '../tool-registry.js';
import { readMemory, type MemoryPreferenceKey } from '../memory-store.js';
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

/**
 * Deterministic, filesystem-safe asset id derived from a media path.
 *
 * No empty-result fallback: {@link modelAuthoredMediaPath} requires an alphanumeric file
 * extension, so the squeezed string always has characters left. A `|| 'media'` arm here
 * would be an unreachable branch pretending to guard something.
 */
const assetIdFromPath = (path: string): string =>
  `asset_${path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;

/** Canonical by-kind folders for the deterministic `manage_assets` fallback. */
const KIND_FOLDERS: Record<Asset['kind'], { id: string; name: string }> = {
  video: { id: 'folder_video', name: 'Video' },
  audio: { id: 'folder_audio', name: 'Audio' },
  image: { id: 'folder_images', name: 'Images' },
};

/**
 * A media path a MODEL may author.
 *
 * `path` used to be a bare `z.string()`, and nothing downstream looked at it either — the
 * editor-core validator checks an `add_asset` op for a duplicate id and an unknown folder,
 * and stops. So a captured run proposed `add_asset` with `stock://pexels/20349219`, the
 * patch reported `valid: true`, the card showed "Added asset" with a checkmark, and the
 * project gained a reference to a file that does not exist and never could. On the second
 * attempt it tried `stock/pexels/8474616.mp4` — same result.
 *
 * Every asset that legitimately enters the bin comes from a HOST path that supplies a real,
 * on-disk location it just wrote: `add_stock`, `add_music`, or the user's own import. The
 * model's job is to name a `remoteId`, never a filename. This schema therefore rejects the
 * shapes a model invents when it is guessing, and the refusal names the tool it should have
 * reached for — a dead end the run can act on beats a checkmark it cannot.
 *
 * Shape-only by design: this layer is pure (PRD §18.2 — a tool touches no filesystem), so
 * it cannot prove a file exists. That proof belongs to the host, which has the projects
 * root, and is enforced there before the patch is committed.
 *
 * CONTAINMENT is deliberately not here either, for the same reason plus a better one: a
 * string test for ".." cannot see through `a/b/../../../etc`, symlinks, or an absolute path,
 * and a check that looks like containment without being it is worse than none. Traversal is
 * owned by the layers that RESOLVE — `resolveWithin` behind the MCP session's
 * `assertAssetPathsSandboxed` and the desktop's `unresolvableAddedAssets` — each of which
 * refuses with its own typed reason. One rule, one owner.
 */
const PROVIDER_URI = /^[a-z][a-z0-9+.-]*:\/\//i;
const HAS_EXTENSION = /\.[a-z0-9]{2,5}$/i;

const modelAuthoredMediaPath = z
  .string()
  .trim()
  .min(1, 'An asset path cannot be empty.')
  .refine((value) => !PROVIDER_URI.test(value), {
    message:
      'That is a URL or provider URI, not a media file in this project. Stock media has no ' +
      'path until it is downloaded — pass the remoteId from search_stock to add_stock (or ' +
      'search_music to add_music) and the download supplies the real one.',
  })
  .refine((value) => HAS_EXTENSION.test(value), {
    message:
      'An asset path must name a media FILE with its extension (e.g. "interview.mp4"). If ' +
      'you are trying to use a stock clip, pass its remoteId to add_stock instead.',
  });

const addAssetSchema = z
  .object({
    path: modelAuthoredMediaPath,
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

/**
 * The line `list_assets` adds when the bin holds picture that will letterbox as placed.
 *
 * The renderer FITS a clip into the frame — `_place_video_clip` computes
 * `min(target_w/w, target_h/h)`, which is *contain*, not cover — so a landscape source in
 * a portrait sequence renders with black bars unless its clip carries a crop. Nothing said
 * so. Run `fc10301a` placed 34 landscape WhatsApp photos in a 1080x1920 sequence against a
 * brief whose delivery spec read "No black bars. No stretched photos.", and the only check
 * that noticed downgraded itself to a warning whose text was never shown.
 *
 * Stated here because this is where a run learns what it is editing, and because the
 * answer is a join the model cannot make on its own: it needs each asset's shape AND the
 * project's frame, and before schema v21 it had neither.
 *
 * Says nothing when the frame is not portrait (a landscape source in a landscape sequence
 * is the ordinary case) or when nothing has been probed — silence is the honest reading of
 * "unknown", and a warning about assets whose shape nobody measured would be noise.
 */
export function letterboxNote(
  assets: readonly ModelAsset[],
  resolution: { readonly width: number; readonly height: number },
): string | undefined {
  if (resolution.height <= resolution.width) return undefined;
  const mismatched = assets.filter((asset) => asset.orientation === 'landscape');
  if (mismatched.length === 0) return undefined;
  const named = mismatched.slice(0, 3).map((asset) => asset.id);
  const rest = mismatched.length - named.length;
  return (
    `${String(mismatched.length)} of these are landscape in a ` +
    `${String(resolution.width)}x${String(resolution.height)} portrait project — ` +
    `${named.join(', ')}${rest > 0 ? `, plus ${String(rest)} more` : ''}. ` +
    'Placed as they are they render with black bars above and below: the renderer fits ' +
    'the source into the frame rather than filling it. Give each clip a set_clip_crop to ' +
    'fill the frame, choosing the part of the picture that matters.'
  );
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
        'each asset as { id, path, kind, durationSeconds, folderId }, plus ' +
        '`orientation`/`aspect` for picture the engine has measured — absent means ' +
        'unmeasured, never square. A `letterbox` note names any landscape source in a ' +
        'portrait project, which is the one thing you cannot work out from the ids.',
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
      const model = toModelAssets(assets);
      const letterbox = letterboxNote(model, ctx.project.resolution);
      return {
        assets: model,
        folders: ctx.project.folders,
        // A filter that matches nothing and an empty bin are the same `{ assets: [] }`
        // to a reader, and the agent has repeatedly read the first as the second — then
        // told the user to import media that was already there. Say which one it is.
        ...(assets.length === 0 && ctx.project.assets.length > 0
          ? { note: emptyFilterNote(ctx.project.assets) }
          : {}),
        // See `letterboxNote`: the renderer fits rather than covers, and nothing else in
        // this result would tell a run that its picture is about to arrive in a box.
        ...(letterbox ? { letterbox } : {}),
      };
    },
  ),
  projectMutateTool(
    {
      name: 'add_asset',
      description:
        'Register a media file that ALREADY EXISTS on disk into the bin. Downloads and ' +
        'creates nothing: stock goes through add_stock and music through add_music, which ' +
        'fetch the file and supply its real path. A path you were not handed is refused. ' +
        'Does not place it on the timeline — use add_clip for that.',
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
  // --- Project memory (context-management P5.2) ---------------------------
  //
  // The block headed "Project memory (honour these preferences)" is injected into every
  // turn's context, and until this tool existed nothing in the 85-tool registry could
  // WRITE it: the only writers were `style-presets.ts` and the Settings dialog. So an
  // editor who said "punchier than that" was teaching nothing durable — the agent could
  // honour a preference and could never learn one.
  projectMutateTool(
    {
      name: 'remember_preference',
      description:
        'Remember how this editor likes their videos, so the next session starts knowing ' +
        'it. Use it when they state a lasting preference ("punchier cuts than that", ' +
        '"always big yellow captions", "this is for founders") — NOT for a one-off ' +
        'instruction about the edit in front of you, which belongs in the edit and not in ' +
        'memory. Keys: preferredPacing, captionStyle, brandStyle, targetAudience, plus ' +
        'exportPlatforms for where this project is published. Writing a key replaces what ' +
        'was there. Reversible like any other edit, and stored in the project file.',
      capabilities: ['memory'],
    },
    z
      .object({
        /**
         * A CLOSED key set, not free text — and that is the guard, not a limitation.
         *
         * `ProjectMemory` is Zod-parsed and read defensively because `aiMemory`
         * round-trips through `project.fp.json`, and the block it feeds is injected into
         * every turn under "honour these preferences". A free-text memory tool would turn
         * that block into an unbounded, model-authored prompt-injection surface that grows
         * every turn. The typed union costs ~120 tokens of schema and closes it.
         */
        key: z.enum(['targetAudience', 'brandStyle', 'captionStyle', 'preferredPacing']).optional(),
        value: z.string().trim().min(1).max(200).optional(),
        /** Where this project is published, e.g. ["reels", "shorts"]. Replaces the list. */
        exportPlatforms: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
      })
      .strict()
      .refine((a) => (a.key === undefined) === (a.value === undefined), {
        message: 'remember_preference needs key and value together, or neither.',
      })
      .refine((a) => a.key !== undefined || a.exportPlatforms !== undefined, {
        message: 'remember_preference needs a key/value pair or exportPlatforms.',
      }),
    (a, ctx) => {
      // Through the typed setters' own shape, then out as ONE whole-record operation: the
      // project file has one writer, and memory is part of the project file.
      const memory = readMemory(ctx.project);
      const next: Record<string, unknown> = { ...memory };
      if (a.key !== undefined && a.value !== undefined) {
        next[a.key satisfies MemoryPreferenceKey] = a.value;
        // Dated and attributed at the point of writing. `user` is the only honest
        // source for this tool: the model is told to call it when the USER states a
        // lasting preference, so anything it records here is the user talking. An
        // inference the agent made about the footage is written by the code that made
        // it, not through a tool the model can reach.
        next['provenance'] = {
          ...memory.provenance,
          [a.key]: { source: 'user', turn: ctx.turn ?? 0 },
        };
      }
      if (a.exportPlatforms !== undefined) next.exportPlatforms = [...a.exportPlatforms];
      return [{ type: 'set_ai_memory', memory: next }];
    },
  ),
];
