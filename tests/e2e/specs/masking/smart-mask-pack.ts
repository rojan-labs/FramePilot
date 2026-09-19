/**
 * An installed Smart Mask pack for the masking end-to-end specs, whose worker is the REAL
 * pipeline with scripted models (`fixtures/masking/scripted_smart_mask_worker.py`).
 *
 * What is real: the desktop's `CapabilityPackMatteService` (media resolution, auto prompt hook,
 * cache key, disk preflight, staging, the worker watchdog, host verification of every file,
 * the atomic commit and the matte record), the desktop's `runCapabilityPackWorker` (process
 * launch, the sandbox checks on media and output handles, the JSON-line protocol), and the
 * worker's own runtime, windows, checkpoints and encoders.
 *
 * What is simulated, and why (for RD3): the install (no signed release exists, MO-1..MO-5 — the
 * record below stands in for what `register-local` writes), the models (no weights in CI), the
 * auto prompt (`subject.detect` needs Subject Intelligence; a fixed box on the subject's
 * quadrant stands in), and a crash, which is scripted by a control file: the worker exits 137 as
 * window 2 starts, and the host's run never returns, as a killed app's never does.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runCapabilityPackWorker } from '../../../../packages/capability-packs/dist/node/index.js';
import {
  CapabilityPackMatteService,
  SMART_MASK_PACK_ID,
} from '../../../../apps/desktop/dist/capability-packs/matte.js';
import type { DesktopMatteMediaInspector } from '../../../../apps/desktop/dist/capability-packs/matte-media-inspector.js';
import { REPO, type Workspace } from './workspace.js';

const VERSION = '1.0.0';
const INSTALL = `${SMART_MASK_PACK_ID}/${VERSION}/darwin-arm64`;
const WRAPPER = join(REPO, 'tests', 'e2e', 'fixtures', 'masking', 'scripted_smart_mask_worker.py');
const CONTROL_FILE = 'e2e-control.json';
/** The exit code the scripted worker dies with (a killed process). */
const SCRIPTED_CRASH_EXIT = 137;

/** The Python that has the worker's `cv` extra (`uv sync --extra cv` in workers/smart-mask). */
function workerPython(): string {
  const configured = process.env.MASKING_E2E_SMART_MASK_PYTHON;
  if (configured !== undefined && configured !== '') return configured;
  const venv = join(REPO, 'workers', 'smart-mask', '.venv', 'bin', 'python');
  if (!existsSync(venv)) {
    throw new Error(
      'The Smart Mask worker environment is missing. Run `uv sync --extra cv --locked` in ' +
        'workers/smart-mask (the masking-e2e CI job does), or set MASKING_E2E_SMART_MASK_PYTHON.',
    );
  }
  return venv;
}

/** One progress event the worker reported, with its own detail text. */
export interface WorkerEvent {
  readonly phase: string;
  readonly completed: number;
  readonly total: number;
  readonly detail: string | null;
}

export class ScriptedSmartMaskPack {
  private crashedResolve: (() => void) | null = null;
  /** Settles when a scripted crash has happened (the worker died; the run hangs forever). */
  public readonly crashed: Promise<void> = new Promise((resolve) => {
    this.crashedResolve = resolve;
  });
  private crashAtWindow: number | undefined;

  private constructor(
    /** Where installed packs live (`storageRoot` of the matte service). */
    public readonly storageRoot: string,
    private readonly installRoot: string,
  ) {}

  /** Lay out an installed pack under `workspace` whose entrypoint runs the scripted worker. */
  public static async install(workspace: Workspace): Promise<ScriptedSmartMaskPack> {
    const storageRoot = join(workspace.root, 'packs');
    const installRoot = join(storageRoot, INSTALL);
    await mkdir(join(installRoot, 'bin'), { recursive: true });
    const entrypoint = join(installRoot, 'bin', 'framepilot-smart-mask');
    await writeFile(entrypoint, `#!/bin/sh\nexec '${workerPython()}' '${WRAPPER}' "$@"\n`, 'utf8');
    await chmod(entrypoint, 0o755);
    return new ScriptedSmartMaskPack(storageRoot, installRoot);
  }

  /**
   * Script the next worker launches.
   *
   * @param control.crashAtWindow - Exit 137 as this window starts (its predecessors checkpointed).
   * @param control.eventsLog - Append every progress event here (JSON lines).
   */
  public async setControl(control: { crashAtWindow?: number; eventsLog: string }): Promise<void> {
    this.crashAtWindow = control.crashAtWindow;
    await writeFile(join(this.installRoot, CONTROL_FILE), JSON.stringify(control), 'utf8');
  }

  /** The worker's progress events from a log the control file named. */
  public static async events(log: string): Promise<WorkerEvent[]> {
    if (!existsSync(log)) return [];
    return (await readFile(log, 'utf8'))
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as WorkerEvent);
  }

  /** The real matte service over this pack, measuring media with `inspector`. */
  public service(inspector: DesktopMatteMediaInspector): CapabilityPackMatteService {
    const identity = {
      id: SMART_MASK_PACK_ID,
      version: VERSION,
      releaseDigest: 'a'.repeat(64),
      artifactDigest: 'b'.repeat(64),
      os: 'darwin' as const,
      arch: 'arm64' as const,
    };
    const record = {
      identity,
      state: 'installed',
      installRelativePath: INSTALL,
      installedBytes: 1,
      installedAt: '2026-09-19T00:00:00.000Z',
      lastUsedAt: '2026-09-19T00:00:00.000Z',
      pinnedProjectIds: [],
      activeLeaseCount: 0,
      health: {
        checkedAt: '2026-09-19T00:00:00.000Z',
        workerProtocolVersion: 1,
        status: 'healthy',
      },
      acquisition: {
        catalogDigest: 'c'.repeat(64),
        approvedAt: '2026-09-19T00:00:00.000Z',
        licenseSpdx: ['Apache-2.0'],
        mediaEgressApproved: false,
      },
    };
    const runWorker: typeof runCapabilityPackWorker = async (options) => {
      const crashing = this.crashAtWindow !== undefined;
      if (!crashing) return runCapabilityPackWorker(options);
      const outcome = await runCapabilityPackWorker(options).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      if ('result' in outcome) {
        throw new Error('The scripted crash did not happen: the worker returned a result.');
      }
      // Only the scripted death counts; anything else (a watchdog breach, a bad request) is a
      // real failure the spec must see, not a crash to resume from.
      if (!String(outcome.error).includes(`exited ${String(SCRIPTED_CRASH_EXIT)}`))
        throw outcome.error;
      // The app is gone: nothing after the worker's death runs, so its staging stays on disk.
      this.crashedResolve?.();
      return new Promise<never>(() => undefined);
    };
    return new CapabilityPackMatteService({
      storageRoot: this.storageRoot,
      store: {
        list: async () => [record],
        acquireLease: async () => ({ release: async () => undefined }),
      } as never,
      platform: { os: 'darwin', arch: 'arm64' },
      propose: async () => ({ ok: false, code: 'catalog_unconfigured', error: 'No catalog.' }),
      inspector,
      runWorker,
      // The "dead" host of a scripted crash keeps its timers in this process: its watchdog must
      // not later signal a process group whose pid the OS has since reused.
      ...(this.crashAtWindow === undefined
        ? {}
        : { watchdog: { killGroup: () => undefined, stallMs: 24 * 60 * 60 * 1000 } }),
      // Subject Intelligence's pick, stood in: the subject is the sentinel's top-right quadrant.
      autoPrompt: async ({ frame }: { frame: { pts: number } }) => [
        { kind: 'box', pts: frame.pts, box: { x: 0.5, y: 0, width: 0.5, height: 0.5 } },
      ],
    } as never);
  }
}
