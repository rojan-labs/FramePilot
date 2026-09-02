/**
 * Authoritative in-process project revision lane.
 *
 * Persisted revision metadata tracks content that is proven written to disk. Renderer-live
 * refreshes update the authoritative working document without serializing it or changing
 * the persisted fingerprint. External observations still fingerprint full documents so
 * restart/external-file reconciliation remains exact.
 */
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { isProjectFileConflictError } from '@framepilot/timeline-schema/file';
import { createLogger } from '@framepilot/shared-types';
import { createHash } from 'node:crypto';
import {
  commitProjectPatch,
  DEFAULT_DURABLE_HISTORY_LIMITS,
  fromPersistedHistory,
  toPersistedHistory,
  validatePatch,
  type HistoryEntry,
  type Patch,
  type ValidationIssue,
} from '@framepilot/editor-core';

const log = createLogger('desktop:projects:command-service');

export interface ProjectVersion {
  readonly projectId: string;
  readonly revision: number;
}

export type ProjectWriteResult =
  | { readonly ok: true; readonly revision: number }
  | {
      readonly ok: false;
      readonly code: 'revision_conflict';
      readonly expectedRevision: number;
      readonly currentRevision: number;
    };

export type ProjectPatchCommitResult =
  | {
      readonly ok: true;
      readonly revision: number;
      readonly project: Project;
      readonly rebased: boolean;
      /** The identical patch was already durable; no write or revision advance occurred. */
      readonly replayed?: boolean;
      readonly conflictKind?: 'disjoint_rebaseable';
    }
  | {
      readonly ok: false;
      readonly code: 'project_not_open' | 'revision_conflict' | 'invalid_patch';
      readonly conflictKind?: 'overlapping_replan' | 'authority_required';
      readonly currentRevision?: number;
      readonly issues?: readonly ValidationIssue[];
    };

interface VersionEntry {
  revision: number;
  /** Fingerprint of the last document observed/written on disk, never an unsaved refresh. */
  persistedFingerprint: string;
  project: Project;
}

interface PersistedVersionEntry {
  readonly revision: number;
  readonly fingerprint: string;
}

interface PersistedRevisionRegistry {
  readonly version: 1;
  readonly projects: Readonly<Record<string, PersistedVersionEntry>>;
}

export interface ProjectRevisionIO {
  read(): Promise<string | null>;
  write(contents: string): Promise<void>;
}

const fingerprint = (canonical: string): string =>
  createHash('sha256').update(canonical).digest('hex');

function isPersistedVersion(value: unknown): value is PersistedVersionEntry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(candidate.revision) &&
    Number(candidate.revision) >= 1 &&
    typeof candidate.fingerprint === 'string' &&
    candidate.fingerprint.length > 0
  );
}

function isHistoryPatch(value: unknown): value is Patch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<Patch>;
  return (
    typeof candidate.patchId === 'string' &&
    (candidate.createdBy === 'user' || candidate.createdBy === 'agent') &&
    typeof candidate.reason === 'string' &&
    Array.isArray(candidate.operations)
  );
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<HistoryEntry>;
  return isHistoryPatch(candidate.patch) && isHistoryPatch(candidate.inverse);
}

export class ProjectCommandService {
  private readonly versions = new Map<string, VersionEntry>();
  private readonly restoredVersions = new Map<string, PersistedVersionEntry>();
  private readonly commitLanes = new Map<string, Promise<void>>();
  private persistenceLane: Promise<void> = Promise.resolve();

  public constructor(
    private readonly serialize: (project: Project) => string,
    private readonly revisionIO?: ProjectRevisionIO,
  ) {}

  public async restore(): Promise<void> {
    if (!this.revisionIO) return;
    const raw = await this.revisionIO.read();
    if (raw === null) return;
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedRevisionRegistry>;
      if (parsed.version !== 1 || typeof parsed.projects !== 'object' || parsed.projects === null) {
        log.warn('ignored invalid project revision registry');
        return;
      }
      for (const [projectId, version] of Object.entries(parsed.projects)) {
        if (projectId.length > 0 && isPersistedVersion(version)) {
          this.restoredVersions.set(projectId, version);
        }
      }
      log.action('restored project revisions', { count: this.restoredVersions.size });
    } catch (error) {
      log.warn('ignored unreadable project revision registry', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Persist already-computed fingerprints. No project serialization/hash occurs here. */
  public async checkpoint(): Promise<void> {
    if (!this.revisionIO) return;
    const prior = this.persistenceLane;
    const write = prior
      .catch(() => {})
      .then(async () => {
        const projects: Record<string, PersistedVersionEntry> = Object.fromEntries(
          this.restoredVersions,
        );
        for (const [projectId, entry] of this.versions) {
          projects[projectId] = {
            revision: entry.revision,
            fingerprint: entry.persistedFingerprint,
          };
        }
        await this.revisionIO!.write(JSON.stringify({ version: 1, projects }, null, 2));
      });
    this.persistenceLane = write;
    await write;
  }

  private scheduleCheckpoint(): void {
    void this.checkpoint().catch((error: unknown) => {
      log.error('failed to persist project revisions', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Record content that is known to represent persisted disk state. Serialization and
   * hashing happen exactly once here, and callers choose whether checkpointing is async
   * (external observation) or awaited (an internal write already in a commit lane).
   */
  private recordPersisted(project: Project, schedule: boolean): ProjectVersion {
    const persistedFingerprint = fingerprint(this.serialize(project));
    const current = this.versions.get(project.id);
    let revision: number;
    let registryChanged = false;

    if (!current) {
      const restored = this.restoredVersions.get(project.id);
      revision =
        restored === undefined
          ? 1
          : restored.fingerprint === persistedFingerprint
            ? restored.revision
            : restored.revision + 1;
      this.versions.set(project.id, { revision, persistedFingerprint, project });
      registryChanged = true;
    } else {
      if (current.persistedFingerprint !== persistedFingerprint) {
        current.revision += 1;
        current.persistedFingerprint = persistedFingerprint;
        registryChanged = true;
      }
      current.project = project;
      revision = current.revision;
    }

    if (registryChanged) {
      log.action('observed project revision', { projectId: project.id, revision });
      if (schedule) this.scheduleCheckpoint();
    }
    return { projectId: project.id, revision };
  }

  /** Observe a validated project from open/external reload and return its revision. */
  public observe(project: Project): ProjectVersion {
    return this.recordPersisted(project, true);
  }

  public revision(projectId: string): number | undefined {
    return this.versions.get(projectId)?.revision;
  }

  public project(projectId: string): Project | undefined {
    return this.versions.get(projectId)?.project;
  }

  /**
   * Replace only the live authoritative working document. The disk fingerprint and
   * revision remain untouched until a successful save proves those bytes persisted.
   */
  public refresh(project: Project, expectedRevision: number): boolean {
    const current = this.versions.get(project.id);
    if (!current || current.revision !== expectedRevision) return false;
    current.project = project;
    log.action('refreshed authoritative working project', {
      projectId: project.id,
      revision: current.revision,
    });
    return true;
  }

  public async write(
    project: Project,
    expectedRevision: number | undefined,
    write: () => Promise<void>,
  ): Promise<ProjectWriteResult> {
    const prior = this.commitLanes.get(project.id) ?? Promise.resolve();
    let release!: () => void;
    const lane = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = prior.catch(() => {}).then(() => lane);
    this.commitLanes.set(project.id, queued);
    await prior.catch(() => {});
    try {
      const current = this.versions.get(project.id);
      if (
        expectedRevision !== undefined &&
        current !== undefined &&
        expectedRevision !== current.revision
      ) {
        log.warn('rejected stale project write', {
          projectId: project.id,
          expectedRevision,
          currentRevision: current.revision,
        });
        return {
          ok: false,
          code: 'revision_conflict',
          expectedRevision,
          currentRevision: current.revision,
        };
      }
      try {
        await write();
      } catch (error) {
        // `expectedRevision` above is checked against THIS process's in-memory revision,
        // which only learns of an external write ~120ms later, when the project watcher
        // re-reads the file. The writer's own compare-and-swap is the only guard that sees
        // the other OS process immediately, so its refusal has to survive as a refusal:
        // log it with the project it protected, and let the caller decide (main.ts turns a
        // thrown save into a typed IPC failure the renderer surfaces).
        if (isProjectFileConflictError(error)) {
          log.warn('project write refused — file changed underneath this process', {
            projectId: project.id,
            path: error.path,
          });
        }
        throw error;
      }
      const version = this.recordPersisted(project, false);
      await this.checkpoint();
      log.action('committed project revision', version);
      return { ok: true, revision: version.revision };
    } finally {
      release();
      if (this.commitLanes.get(project.id) === queued) this.commitLanes.delete(project.id);
    }
  }

  public async commitPatch(
    projectId: string,
    expectedRevision: number,
    patch: Patch,
    write: (project: Project) => Promise<void>,
    historyGroupId?: string,
  ): Promise<ProjectPatchCommitResult> {
    const prior = this.commitLanes.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const lane = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = prior.catch(() => {}).then(() => lane);
    this.commitLanes.set(projectId, queued);
    await prior.catch(() => {});
    try {
      const current = this.versions.get(projectId);
      if (!current) return { ok: false, code: 'project_not_open' };
      const validHistory = current.project.history.filter(isHistoryEntry);
      const priorPatch = validHistory
        .flatMap((entry) => entry.memberPatches ?? [entry.patch])
        .find((candidate) => candidate.patchId === patch.patchId);
      if (priorPatch !== undefined) {
        // Compare what the patch DOES, never the whole object.
        //
        // `patchIdFor` hashes the operations and nothing else, so a patch id is a claim
        // about the edit. `reason` is the model's narration for the turn — different prose
        // every single time, by design. Comparing the whole object therefore compared the
        // prose, and every legitimate repeat of an edit this project has already committed
        // was refused as `invalid_patch`: not once, but on every retry, because the id is
        // deterministic and the prose is never the same twice.
        //
        // Run `e8cb2636` lost its entire first turn to it. `transcribe` re-derived the 149
        // timed words the project already held from an earlier session, so the patch carried
        // byte-identical `set_transcript` operations and therefore the identical id — the
        // exact case this branch exists to answer with a silent replay. It came back "the
        // proposed edit failed authoritative validation" instead, and the turn was spent.
        //
        // The replay is the whole point: identical operations have already happened, so
        // doing nothing is right. Refusing them is a hard failure where a no-op was meant,
        // and it is permanent — the id is derived from the operations, so no later run can
        // get past it either. As a project accumulates history, more and more ordinary
        // edits fall into it.
        if (JSON.stringify(priorPatch.operations) !== JSON.stringify(patch.operations)) {
          // A genuine id collision: same id, different edit. Vanishingly rare, and refusing
          // it is right — but the caller has to be able to SAY so, which is why the reason
          // travels with the refusal instead of being reconstructed as a generic sentence.
          return {
            ok: false,
            code: 'invalid_patch',
            currentRevision: current.revision,
            issues: [
              {
                code: 'invalid_operation',
                severity: 'error',
                message:
                  `Patch id "${patch.patchId}" is already in this project's history with ` +
                  'different operations, so it cannot be committed again under that id.',
              },
            ],
          };
        }
        log.action('replayed committed project patch', {
          projectId,
          patchId: patch.patchId,
          revision: current.revision,
        });
        return {
          ok: true,
          revision: current.revision,
          project: current.project,
          rebased: false,
          replayed: true,
        };
      }
      const validation = validatePatch(current.project.timeline, patch, {
        assetIds: current.project.assets.map((asset) => asset.id),
        folders: current.project.folders,
        markers: current.project.markers,
      });
      if (!validation.valid) {
        const stale = expectedRevision !== current.revision;
        return {
          ok: false,
          code: stale ? 'revision_conflict' : 'invalid_patch',
          ...(stale ? { conflictKind: 'overlapping_replan' as const } : {}),
          currentRevision: current.revision,
          issues: validation.issues,
        };
      }

      const rebased = expectedRevision !== current.revision;
      const persistedHistory = toPersistedHistory(
        fromPersistedHistory(validHistory),
        DEFAULT_DURABLE_HISTORY_LIMITS,
      );
      const committed = commitProjectPatch(
        current.project,
        fromPersistedHistory(persistedHistory),
        patch,
        Date.now(),
        historyGroupId,
      );
      const next = parseProject({
        ...committed.project,
        history: toPersistedHistory(committed.history, DEFAULT_DURABLE_HISTORY_LIMITS),
      });
      await write(next);
      const version = this.recordPersisted(next, false);
      await this.checkpoint();
      log.action('committed project patch', {
        projectId,
        patchId: patch.patchId,
        revision: version.revision,
        rebased,
      });
      return {
        ok: true,
        revision: version.revision,
        project: next,
        rebased,
        ...(rebased ? { conflictKind: 'disjoint_rebaseable' as const } : {}),
      };
    } catch (error) {
      // A refused write is NOT an invalid patch: the patch validated against the project
      // this process holds, and the file moved underneath it. `main.ts` already turns
      // `revision_conflict` into a `stale` patch event telling the agent to replan from
      // the current revision, which is exactly the recovery this needs.
      //
      // `currentRevision` is deliberately omitted: the in-memory revision did NOT advance
      // (nothing was persisted), so returning it would invite the agent to retry at the
      // same number against a file that has already moved on.
      if (isProjectFileConflictError(error)) {
        log.warn('project patch commit refused — file changed underneath this process', {
          projectId,
          patchId: patch.patchId,
          path: error.path,
        });
        return { ok: false, code: 'revision_conflict', conflictKind: 'overlapping_replan' };
      }
      log.warn('project patch commit failed validation/apply', {
        projectId,
        patchId: patch.patchId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, code: 'invalid_patch' };
    } finally {
      release();
      if (this.commitLanes.get(projectId) === queued) this.commitLanes.delete(projectId);
    }
  }
}
