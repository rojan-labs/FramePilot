import type { ResourceSnapshot } from './launch.js';

/**
 * The P6.6 resource gate, as a pure function over two samples (plan/system-mission P9.5).
 *
 * It used to be six inline `expect`s at the bottom of the resource baseline, which made it
 * un-provable: the only way to see whether it could fail was to spend ten minutes driving
 * the real app and hope it leaked. Pulled out here, the same arithmetic can be fed a
 * seeded leak in milliseconds — which is the difference between a gate and a decoration.
 *
 * The bounds come from the 2026-08-29 desktop baseline (renderer heap 43.7–48.7 MB,
 * listeners 933–935, nodes 2,913–2,967 over 376 scripted loops) with headroom for ordinary
 * variance, so a session that merely breathes stays green and one that accumulates does not.
 */
export const RESOURCE_GATE_BOUNDS = {
  /** Heap may drift with GC timing, so allow 30% + 10 MB before calling it growth. */
  heapFactor: 1.3,
  heapSlackMb: 10,
  /** Listeners are the classic leak: an unbalanced add/remove shows up here first. */
  listenerFactor: 1.1,
  listenerSlack: 20,
  nodeFactor: 1.2,
  nodeSlack: 200,
  /** Extra documents mean a detached frame the renderer never released. */
  documentSlack: 1,
  openFileFactor: 1.2,
  openFileSlack: 20,
} as const;

/** The fields the gate reads — a narrow view so a seeded sample is cheap to build. */
export type GateSample = Pick<ResourceSnapshot, 'label' | 'renderer' | 'main' | 'ffmpegCount'>;

/**
 * @returns one human-readable line per breached bound; empty means the session held.
 */
export function resourceGateViolations(warm: GateSample, last: GateSample): string[] {
  const b = RESOURCE_GATE_BOUNDS;
  const violations: string[] = [];
  const check = (
    what: string,
    warmValue: number,
    lastValue: number,
    limit: number,
    unit = '',
  ): void => {
    if (lastValue >= limit) {
      violations.push(
        `${what} grew from ${warmValue}${unit} to ${lastValue}${unit} (limit ${limit.toFixed(1)}${unit})`,
      );
    }
  };
  check(
    'renderer heap',
    warm.renderer.jsHeapUsedMb,
    last.renderer.jsHeapUsedMb,
    warm.renderer.jsHeapUsedMb * b.heapFactor + b.heapSlackMb,
    ' MB',
  );
  check(
    'event listeners',
    warm.renderer.listeners,
    last.renderer.listeners,
    warm.renderer.listeners * b.listenerFactor + b.listenerSlack,
  );
  check(
    'DOM nodes',
    warm.renderer.nodes,
    last.renderer.nodes,
    warm.renderer.nodes * b.nodeFactor + b.nodeSlack,
  );
  check(
    'documents',
    warm.renderer.documents,
    last.renderer.documents,
    warm.renderer.documents + b.documentSlack + 1,
  );
  check(
    'open files',
    warm.main.openFiles,
    last.main.openFiles,
    warm.main.openFiles * b.openFileFactor + b.openFileSlack,
  );
  if (last.ffmpegCount !== 0) {
    violations.push(`${last.ffmpegCount} ffmpeg/ffprobe process(es) outlived the session`);
  }
  return violations;
}
