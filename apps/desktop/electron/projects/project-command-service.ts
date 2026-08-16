/**
 * Public project command service with transport compaction.
 *
 * The authoritative revision/write implementation remains byte-for-byte in
 * project-command-service-base.ts. This façade changes only the value returned after a
 * successful same-revision patch commit: the host keeps the complete Project internally
 * and on disk, while routine renderer IPC receives a patch/history envelope. A rebase
 * returns the full snapshot because unseen intervening edits cannot be reconstructed from
 * the accepted patch alone.
 */
export * from './project-command-service-base.js';

import type { Project } from '@framepilot/timeline-schema';
import type { Patch, ValidationIssue } from '@framepilot/editor-core';
import {
  PROJECT_PATCH_TRANSPORT_KIND,
  type ProjectPatchTransport,
} from '@framepilot/shared-types';
import {
  ProjectCommandService as BaseProjectCommandService,
  type ProjectRevisionIO,
  type ProjectVersion,
  type ProjectWriteResult,
} from './project-command-service-base.js';

export type ProjectPatchCommitResult =
  | {
      readonly ok: true;
      readonly revision: number;
      readonly project: Project | ProjectPatchTransport;
      readonly rebased: boolean;
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

export class ProjectCommandService {
  private readonly delegate: BaseProjectCommandService;

  public constructor(
    serialize: (project: Project) => string,
    revisionIO?: ProjectRevisionIO,
  ) {
    this.delegate = new BaseProjectCommandService(serialize, revisionIO);
  }

  public restore(): Promise<void> {
    return this.delegate.restore();
  }

  public checkpoint(): Promise<void> {
    return this.delegate.checkpoint();
  }

  public observe(project: Project): ProjectVersion {
    return this.delegate.observe(project);
  }

  public revision(projectId: string): number | undefined {
    return this.delegate.revision(projectId);
  }

  public project(projectId: string): Project | undefined {
    return this.delegate.project(projectId);
  }

  public refresh(project: Project, expectedRevision: number): boolean {
    return this.delegate.refresh(project, expectedRevision);
  }

  public write(
    project: Project,
    expectedRevision: number | undefined,
    write: () => Promise<void>,
  ): Promise<ProjectWriteResult> {
    return this.delegate.write(project, expectedRevision, write);
  }

  public async commitPatch(
    projectId: string,
    expectedRevision: number,
    patch: Patch,
    write: (project: Project) => Promise<void>,
    historyGroupId?: string,
  ): Promise<ProjectPatchCommitResult> {
    const result = await this.delegate.commitPatch(
      projectId,
      expectedRevision,
      patch,
      write,
      historyGroupId,
    );
    if (!result.ok || result.rebased || result.replayed) return result;

    return {
      ...result,
      project: {
        kind: PROJECT_PATCH_TRANSPORT_KIND,
        id: result.project.id,
        baseRevision: expectedRevision,
        revision: result.revision,
        patch,
        history: result.project.history,
      },
    };
  }
}
