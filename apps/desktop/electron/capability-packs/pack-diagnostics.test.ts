import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CapabilityPackStorageSnapshotWire } from '@framepilot/shared-types';
import type { MatteJobReport } from './matte.js';
import {
  buildDiagnosticBundle,
  MATTE_REPORTS_KEPT,
  MatteReportLog,
  writeDiagnosticBundle,
} from './pack-diagnostics.js';

const SECRET_PATH = '/Users/editor/Client Projects/secret-film/shot.mov';

const report = (overrides: Partial<MatteJobReport> = {}): MatteJobReport => ({
  at: '2026-09-17T12:00:00.000Z',
  status: 'completed',
  cacheHit: false,
  executionProvider: 'cpu',
  packVersion: '1.0.0',
  verifiedFrames: 98,
  flaggedFrames: 2,
  flaggedRatio: 0.02,
  phasesMs: { media: 120.4, 'worker.segment': 5000, verify: 40 },
  totalMs: 5300.7,
  ...overrides,
});

describe('pack diagnostic bundle (opt-in, BR4.11)', () => {
  it('keeps the newest reports only', () => {
    const log = new MatteReportLog();
    for (let index = 0; index < MATTE_REPORTS_KEPT + 5; index += 1) log.record(report({ totalMs: index }));
    expect(log.list()).toHaveLength(MATTE_REPORTS_KEPT);
    expect(log.list()[0]?.totalMs).toBe(5);
  });

  it('contains outcomes, timings and pack health, and nothing that identifies media or projects', async () => {
    const storage: CapabilityPackStorageSnapshotWire = {
      rootPath: '/Users/editor/Library/Application Support/FramePilot/capability-packs',
      totalBytes: 1,
      installedBytes: 1,
      quarantinedBytes: 0,
      pendingRemovalBytes: 0,
      reclaimableBytes: 0,
      projectUsage: { 'project-secret-id': 1 },
      items: [
        {
          identity: { id: 'framepilot.smart-mask', version: '1.0.0', releaseDigest: 'a'.repeat(64), artifactDigest: 'b'.repeat(64), os: 'darwin', arch: 'arm64' },
          state: 'installed',
          installedBytes: 1,
          lastUsedAt: '2026-09-17T00:00:00.000Z',
          pinnedProjectIds: ['project-secret-id'],
          activeLeaseCount: 0,
          health: 'unhealthy',
          healthDetail: `worker crashed reading ${SECRET_PATH}`,
        },
      ],
    };
    // A report carrying fields it should not (a future bug) and a hostile phase name.
    const leaky = {
      ...report({ status: 'failed', code: 'worker_failed' }),
      mediaPath: SECRET_PATH,
      prompts: [{ kind: 'box', box: { x: 0.123456 } }],
      phasesMs: { [`worker.${SECRET_PATH}`]: 1, verify: 2 },
    } as unknown as MatteJobReport;
    const log = new MatteReportLog();
    log.record(leaky);
    const bundle = buildDiagnosticBundle({
      generatedAt: '2026-09-17T12:00:00.000Z',
      appVersion: '1.2.3',
      platform: { os: 'darwin', arch: 'arm64', totalMemoryBytes: 16 * 1024 ** 3, cpuCount: 10 },
      storage,
      jobs: [
        {
          id: 'job-1',
          kind: 'matte',
          label: 'Remove background',
          clipId: 'clip-secret-id',
          priority: 'focused',
          state: 'running',
          progress: { phase: 'segment', completed: 3, total: 10, etaSeconds: 30 },
          resumed: false,
        },
      ],
      reports: [...log.list(), report()],
    });
    const text = JSON.stringify(bundle);
    for (const forbidden of [SECRET_PATH, 'Client Projects', 'Application Support', 'project-secret-id', 'clip-secret-id', '0.123456', 'job-1', 'crashed reading']) {
      expect(text).not.toContain(forbidden);
    }
    expect(bundle).toMatchObject({
      kind: 'framepilot-pack-diagnostics',
      version: 1,
      app: { version: '1.2.3' },
      packs: [{ id: 'framepilot.smart-mask', version: '1.0.0', health: 'unhealthy' }],
      jobs: [{ kind: 'matte', state: 'running', progress: { phase: 'segment', completed: 3, total: 10 } }],
      matteJobs: [
        { status: 'failed', code: 'worker_failed', phasesMs: { verify: 2 } },
        { status: 'completed', executionProvider: 'cpu', flaggedRatio: 0.02, phasesMs: { media: 120, 'worker.segment': 5000, verify: 40 }, totalMs: 5301 },
      ],
    });

    const dir = await mkdtemp(path.join(tmpdir(), 'framepilot-diagnostics-'));
    const file = path.join(dir, 'bundle.json');
    await writeDiagnosticBundle(file, bundle);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(bundle);
  });
});
