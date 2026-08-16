/** Node-only one-shot bridge to the deterministic Python temporal-evidence engine. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Project } from '@framepilot/timeline-schema';
import { TemporalEvidenceBatchSchema, type TemporalEvidenceRequest } from './temporal-review.js';

export interface ProfessionalEvalNodeAcquirerOptions {
  readonly repositoryRoot?: string;
  readonly timeoutMs?: number;
}

/**
 * Acquire real rendered evidence without starting the sidecar server. Missing uv/ffmpeg and engine
 * failures reject explicitly so the scorecard records acquisition_failed rather than a fake pass.
 */
export function createProfessionalEvalNodeAcquirer(
  options: ProfessionalEvalNodeAcquirerOptions = {},
) {
  const repositoryRoot =
    options.repositoryRoot ?? fileURLToPath(new URL('../../../', import.meta.url));
  return async (project: Project, requests: readonly TemporalEvidenceRequest[]) => {
    const stdout = await runBridge(
      [
        'run',
        '--project',
        `${repositoryRoot}/engine/python`,
        'python',
        '-m',
        'framepilot_engine.validation.professional_eval_bridge',
      ],
      repositoryRoot,
      JSON.stringify({ project, requests }),
      options.timeoutMs ?? 120_000,
    );
    return TemporalEvidenceBatchSchema.parse(JSON.parse(stdout));
  };
}

function runBridge(
  args: readonly string[],
  cwd: string,
  input: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('uv', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Professional eval bridge exceeded ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'));
      else reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `uv exited ${code}`));
    });
    child.stdin.end(input);
  });
}
