/**
 * Opt-in diagnostic bundle for pack jobs (plan 03 "Observability", BR4.11).
 *
 * The app never uploads anything. When the editor asks for help, "Export diagnostic bundle"
 * writes ONE JSON file wherever they choose: recent matte job reports (outcome codes, execution
 * provider, flagged ratio, phase timings), the job queue, installed pack identities and health,
 * and coarse machine facts. Building it is an allow-list, so what is not named here cannot leak:
 * no paths (including the pack storage root), no media or frames, no prompts, no project, asset
 * or clip ids, no free-text errors (they can carry paths).
 */
import { writeFile } from 'node:fs/promises';
import type { CapabilityPackStorageSnapshotWire } from '@framepilot/shared-types';
import type { JobSnapshot } from './job-scheduler.js';
import type { MatteJobReport } from './matte.js';

export const DIAGNOSTIC_BUNDLE_VERSION = 1;
/** Reports kept in memory for the bundle; older ones are dropped. */
export const MATTE_REPORTS_KEPT = 50;

/** Ring buffer of recent matte job reports, fed by the matte service's observer. */
export class MatteReportLog {
  private readonly reports: MatteJobReport[] = [];

  public record(report: MatteJobReport): void {
    this.reports.push(sanitizeReport(report));
    if (this.reports.length > MATTE_REPORTS_KEPT) this.reports.splice(0, this.reports.length - MATTE_REPORTS_KEPT);
  }

  public list(): readonly MatteJobReport[] {
    return [...this.reports];
  }
}

export interface DiagnosticBundleInput {
  readonly generatedAt: string;
  readonly appVersion: string;
  readonly platform: { readonly os: string; readonly arch: string; readonly totalMemoryBytes: number; readonly cpuCount: number };
  readonly storage?: CapabilityPackStorageSnapshotWire;
  readonly jobs: readonly JobSnapshot[];
  readonly reports: readonly MatteJobReport[];
}

export function buildDiagnosticBundle(input: DiagnosticBundleInput): Record<string, unknown> {
  return {
    kind: 'framepilot-pack-diagnostics',
    version: DIAGNOSTIC_BUNDLE_VERSION,
    generatedAt: input.generatedAt,
    app: { version: input.appVersion },
    platform: {
      os: input.platform.os,
      arch: input.platform.arch,
      totalMemoryBytes: input.platform.totalMemoryBytes,
      cpuCount: input.platform.cpuCount,
    },
    packs: (input.storage?.items ?? []).map((item) => ({
      id: item.identity.id,
      version: item.identity.version,
      os: item.identity.os,
      arch: item.identity.arch,
      state: item.state,
      health: item.health,
      installedBytes: item.installedBytes,
      activeLeaseCount: item.activeLeaseCount,
    })),
    jobs: input.jobs.map((job) => ({
      kind: job.kind,
      priority: job.priority,
      state: job.state,
      resumed: job.resumed,
      ...(job.progress === undefined
        ? {}
        : { progress: { phase: job.progress.phase, completed: job.progress.completed, total: job.progress.total } }),
    })),
    matteJobs: input.reports.map(sanitizeReport),
  };
}

/** Write the bundle the editor chose to export (the save dialog is the consent). */
export async function writeDiagnosticBundle(file: string, bundle: Record<string, unknown>): Promise<void> {
  await writeFile(file, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
}

function sanitizeReport(report: MatteJobReport): MatteJobReport {
  const phasesMs: Record<string, number> = {};
  for (const [name, ms] of Object.entries(report.phasesMs)) {
    // Phase names come from the host and the worker's closed progress enum.
    if (/^[a-z_.A-Z]{1,40}$/u.test(name) && Number.isFinite(ms)) phasesMs[name] = Math.round(ms);
  }
  return {
    at: report.at,
    status: report.status,
    ...(report.code === undefined ? {} : { code: report.code }),
    ...(report.verificationCode === undefined ? {} : { verificationCode: report.verificationCode }),
    ...(report.cacheHit === undefined ? {} : { cacheHit: report.cacheHit }),
    ...(report.executionProvider === undefined ? {} : { executionProvider: report.executionProvider }),
    ...(report.packVersion === undefined ? {} : { packVersion: report.packVersion }),
    ...(report.verifiedFrames === undefined ? {} : { verifiedFrames: report.verifiedFrames }),
    ...(report.flaggedFrames === undefined ? {} : { flaggedFrames: report.flaggedFrames }),
    ...(report.flaggedRatio === undefined ? {} : { flaggedRatio: report.flaggedRatio }),
    phasesMs,
    totalMs: Math.round(report.totalMs),
  };
}
