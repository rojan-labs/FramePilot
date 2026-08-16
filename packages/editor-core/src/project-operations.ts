/**
 * @framepilot/editor-core/project-operations — typed, reversible **project-scoped**
 * operations for the media bin: assets and folders (PRD §11.1, schema v3, ADR 0026).
 *
 * The timeline operations in `operations.ts` mutate `Timeline`. These mutate the
 * parts of a {@link Project} that live *outside* the timeline — the asset list,
 * folder tree, transcript, and markers — through the same validated/reversible
 * patch authority as every timeline edit.
 */
import type { Asset, Folder, Marker, Project, TranscriptWord } from '@framepilot/timeline-schema';

// ---------------------------------------------------------------------------
// Project-operation union
// ---------------------------------------------------------------------------

export interface AddAssetOp {
  readonly type: 'add_asset';
  readonly asset: Asset;
}

export interface RemoveAssetOp {
  readonly type: 'remove_asset';
  readonly assetId: string;
}

export interface MoveAssetOp {
  readonly type: 'move_asset';
  readonly assetId: string;
  readonly folderId: string | null;
}

export interface CreateFolderOp {
  readonly type: 'create_folder';
  readonly folderId: string;
  readonly name: string;
  readonly parentId: string | null;
}

export interface RenameFolderOp {
  readonly type: 'rename_folder';
  readonly folderId: string;
  readonly name: string;
}

export interface MoveFolderOp {
  readonly type: 'move_folder';
  readonly folderId: string;
  readonly parentId: string | null;
}

export interface DeleteFolderOp {
  readonly type: 'delete_folder';
  readonly folderId: string;
}

/**
 * Replace transcript words.
 *
 * `assetId` is intentionally tri-state for backward compatibility:
 * - string: replace only that asset's words;
 * - null: explicit whole-project replacement (used by lossless inverse snapshots);
 * - omitted: infer an asset-scoped replacement when every incoming word has the same
 *   non-null `assetId`, otherwise use whole-project replacement.
 *
 * The omitted form is what makes the existing host `transcribe` path safe without
 * duplicating merge logic in the orchestrator: a one-asset ASR response replaces only
 * that asset and cannot wipe transcripts already stored for another camera/file.
 */
export interface SetTranscriptOp {
  readonly type: 'set_transcript';
  readonly words: readonly TranscriptWord[];
  readonly assetId?: string | null;
}

export interface AddMarkerOp {
  readonly type: 'add_marker';
  readonly id: string;
  readonly time: number;
  readonly label?: string;
  readonly color?: string;
}

export interface RemoveMarkerOp {
  readonly type: 'remove_marker';
  readonly id: string;
}

export interface RestoreAssetsOp {
  readonly type: 'restore_assets';
  readonly assets: readonly Asset[];
}

export interface RestoreFoldersOp {
  readonly type: 'restore_folders';
  readonly folders: readonly Folder[];
}

export type ProjectOperation =
  | AddAssetOp
  | RemoveAssetOp
  | MoveAssetOp
  | CreateFolderOp
  | RenameFolderOp
  | MoveFolderOp
  | DeleteFolderOp
  | SetTranscriptOp
  | AddMarkerOp
  | RemoveMarkerOp
  | RestoreAssetsOp
  | RestoreFoldersOp;

export type ProjectOperationType = ProjectOperation['type'];

const PROJECT_OPERATION_TYPES: ReadonlySet<string> = new Set<ProjectOperationType>([
  'add_asset',
  'remove_asset',
  'move_asset',
  'create_folder',
  'rename_folder',
  'move_folder',
  'delete_folder',
  'set_transcript',
  'add_marker',
  'remove_marker',
  'restore_assets',
  'restore_folders',
]);

export const isProjectOperation = (op: { type: string }): op is ProjectOperation =>
  PROJECT_OPERATION_TYPES.has(op.type);

export class ProjectOperationError extends Error {
  constructor(
    readonly code:
      | 'missing_asset'
      | 'duplicate_asset'
      | 'missing_folder'
      | 'duplicate_folder'
      | 'folder_cycle'
      | 'asset_in_use'
      | 'missing_marker'
      | 'duplicate_marker'
      | 'invalid_marker_time'
      | 'invalid_transcript',
    message: string,
  ) {
    super(message);
    this.name = 'ProjectOperationError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const clone = <T>(value: T): T => structuredClone(value);

const findAsset = (project: Project, assetId: string): Asset => {
  const asset = project.assets.find((a) => a.id === assetId);
  if (!asset) throw new ProjectOperationError('missing_asset', `Asset not found: ${assetId}`);
  return asset;
};

const findFolder = (project: Project, folderId: string): Folder => {
  const folder = project.folders.find((f) => f.id === folderId);
  if (!folder) throw new ProjectOperationError('missing_folder', `Folder not found: ${folderId}`);
  return folder;
};

const withAssets = (project: Project, assets: readonly Asset[]): Project => ({
  ...project,
  assets: assets.slice(),
});

const withFolders = (project: Project, folders: readonly Folder[]): Project => ({
  ...project,
  folders: folders.slice(),
});

const withTranscript = (project: Project, transcript: readonly TranscriptWord[]): Project => ({
  ...project,
  transcript: transcript.map(clone),
});

const findMarker = (project: Project, id: string): Marker => {
  const marker = project.markers.find((m) => m.id === id);
  if (!marker) throw new ProjectOperationError('missing_marker', `Marker not found: ${id}`);
  return marker;
};

const withMarkers = (project: Project, markers: readonly Marker[]): Project => ({
  ...project,
  markers: markers.slice(),
});

const markerFromOp = (op: AddMarkerOp): Marker => ({
  id: op.id,
  time: op.time,
  ...(op.label !== undefined ? { label: op.label } : {}),
  ...(op.color !== undefined ? { color: op.color } : {}),
});

const assetWithFolder = (asset: Asset, folderId: string | null): Asset => {
  const next = clone(asset);
  if (folderId === null) delete next.folderId;
  else next.folderId = folderId;
  return next;
};

/** Infer whether an omitted transcript scope is safely attributable to one asset. */
export function inferredTranscriptAssetId(words: readonly TranscriptWord[]): string | null {
  const [first, ...rest] = words;
  if (first === undefined) return null;
  // An unattributed or blank first word means the payload cannot be scoped at all; every
  // later word must then agree with it exactly, or the payload spans more than one asset.
  const assetId = first.assetId ?? '';
  if (assetId === '') return null;
  for (const word of rest) {
    if ((word.assetId ?? '') !== assetId) return null;
  }
  return assetId;
}

function transcriptScope(op: SetTranscriptOp): string | null {
  if (op.assetId === null) return null;
  if (typeof op.assetId === 'string') return op.assetId;
  return inferredTranscriptAssetId(op.words);
}

function replaceTranscript(project: Project, op: SetTranscriptOp): Project {
  const scope = transcriptScope(op);
  if (scope === null) return withTranscript(project, op.words);
  if (scope.trim() === '') {
    throw new ProjectOperationError(
      'invalid_transcript',
      'Transcript asset scope cannot be blank.',
    );
  }
  const scopedWords = op.words.map((word) => ({ ...clone(word), assetId: scope }));
  const retained = project.transcript.filter((word) => word.assetId !== scope);
  return withTranscript(project, [...retained, ...scopedWords]);
}

export const wouldCreateFolderCycle = (
  folders: readonly Folder[],
  folderId: string,
  candidateParentId: string | null,
): boolean => {
  let cursor = candidateParentId;
  const byId = new Map(folders.map((f) => [f.id, f]));
  for (let hops = 0; cursor !== null && hops <= folders.length; hops += 1) {
    if (cursor === folderId) return true;
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return false;
};

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export function applyProjectOperation(project: Project, op: ProjectOperation): Project {
  switch (op.type) {
    case 'add_asset': {
      if (project.assets.some((a) => a.id === op.asset.id)) {
        throw new ProjectOperationError(
          'duplicate_asset',
          `Asset id already exists: ${op.asset.id}`,
        );
      }
      return withAssets(project, [...project.assets, clone(op.asset)]);
    }
    case 'remove_asset': {
      findAsset(project, op.assetId);
      return withAssets(
        project,
        project.assets.filter((a) => a.id !== op.assetId),
      );
    }
    case 'move_asset': {
      findAsset(project, op.assetId);
      return withAssets(
        project,
        project.assets.map((a) => (a.id === op.assetId ? assetWithFolder(a, op.folderId) : a)),
      );
    }
    case 'create_folder': {
      if (project.folders.some((f) => f.id === op.folderId)) {
        throw new ProjectOperationError(
          'duplicate_folder',
          `Folder id already exists: ${op.folderId}`,
        );
      }
      return withFolders(project, [
        ...project.folders,
        { id: op.folderId, name: op.name, parentId: op.parentId },
      ]);
    }
    case 'rename_folder': {
      findFolder(project, op.folderId);
      return withFolders(
        project,
        project.folders.map((f) => (f.id === op.folderId ? { ...f, name: op.name } : f)),
      );
    }
    case 'move_folder': {
      findFolder(project, op.folderId);
      return withFolders(
        project,
        project.folders.map((f) => (f.id === op.folderId ? { ...f, parentId: op.parentId } : f)),
      );
    }
    case 'delete_folder': {
      const target = findFolder(project, op.folderId);
      const folders = project.folders
        .filter((f) => f.id !== op.folderId)
        .map((f) => (f.parentId === op.folderId ? { ...f, parentId: target.parentId } : f));
      const assets = project.assets.map((a) =>
        a.folderId === op.folderId ? assetWithFolder(a, target.parentId) : a,
      );
      return { ...project, folders, assets };
    }
    case 'set_transcript':
      return replaceTranscript(project, op);
    case 'add_marker': {
      if (project.markers.some((m) => m.id === op.id)) {
        throw new ProjectOperationError('duplicate_marker', `Marker id already exists: ${op.id}`);
      }
      if (!Number.isFinite(op.time) || op.time < 0) {
        throw new ProjectOperationError(
          'invalid_marker_time',
          `add_marker time must be a non-negative finite number, got: ${op.time}`,
        );
      }
      return withMarkers(project, [...project.markers, markerFromOp(op)]);
    }
    case 'remove_marker': {
      findMarker(project, op.id);
      return withMarkers(
        project,
        project.markers.filter((m) => m.id !== op.id),
      );
    }
    case 'restore_assets':
      return withAssets(project, op.assets.map(clone));
    case 'restore_folders':
      return withFolders(project, op.folders.map(clone));
  }
}

// ---------------------------------------------------------------------------
// invert
// ---------------------------------------------------------------------------

export function invertProjectOperation(
  projectBefore: Project,
  op: ProjectOperation,
): ProjectOperation[] {
  switch (op.type) {
    case 'add_asset':
      return [{ type: 'remove_asset', assetId: op.asset.id }];
    case 'move_asset': {
      const asset = findAsset(projectBefore, op.assetId);
      return [{ type: 'move_asset', assetId: op.assetId, folderId: asset.folderId ?? null }];
    }
    case 'rename_folder': {
      const folder = findFolder(projectBefore, op.folderId);
      return [{ type: 'rename_folder', folderId: op.folderId, name: folder.name }];
    }
    case 'move_folder': {
      const folder = findFolder(projectBefore, op.folderId);
      return [{ type: 'move_folder', folderId: op.folderId, parentId: folder.parentId }];
    }
    case 'set_transcript':
      return [
        {
          type: 'set_transcript',
          words: projectBefore.transcript.map(clone),
          assetId: null,
        },
      ];
    case 'add_marker':
      return [{ type: 'remove_marker', id: op.id }];
    case 'remove_marker': {
      const marker = findMarker(projectBefore, op.id);
      return [
        {
          type: 'add_marker',
          id: marker.id,
          time: marker.time,
          ...(marker.label !== undefined ? { label: marker.label } : {}),
          ...(marker.color !== undefined ? { color: marker.color } : {}),
        },
      ];
    }
    case 'remove_asset':
    case 'restore_assets':
      return [{ type: 'restore_assets', assets: projectBefore.assets.map(clone) }];
    case 'create_folder':
    case 'restore_folders':
      return [{ type: 'restore_folders', folders: projectBefore.folders.map(clone) }];
    case 'delete_folder':
      return [
        { type: 'restore_folders', folders: projectBefore.folders.map(clone) },
        { type: 'restore_assets', assets: projectBefore.assets.map(clone) },
      ];
  }
}
