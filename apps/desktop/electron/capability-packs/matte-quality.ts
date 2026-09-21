/**
 * Which background-removal engine a job runs (plan 13). Its own module so the capability status,
 * which only needs to say whether Fast exists here, does not import the matte service.
 */
import { compareSemver } from './pack-paths.js';

/**
 * The first Smart Mask release that parses `quality` and reports whole-job progress (plan 13).
 * An older pack's strict parser refuses the unknown key, so it is never sent the field: it runs
 * its models exactly as before.
 */
export const MATTE_QUALITY_MIN_PACK_VERSION = '1.1.0';

export type MatteQuality = 'fast' | 'best';

/**
 * Which engine a job uses. The Fast engine is Apple's Vision framework, so it exists only on
 * macOS; asked for anywhere else, or of an older pack, the job runs Best, never fails.
 */
export function resolveMatteQuality(asked: MatteQuality | undefined, os: string, packVersion: string): MatteQuality | undefined {
  if (compareSemver(packVersion, MATTE_QUALITY_MIN_PACK_VERSION) < 0) return undefined;
  if (os !== 'darwin') return 'best';
  return asked ?? 'fast';
}
