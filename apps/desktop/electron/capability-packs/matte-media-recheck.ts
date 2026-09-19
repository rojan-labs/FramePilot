/**
 * Did an asset's media change under its mattes? (audit P9, plan 03 "Media changes", BR4.10)
 *
 * Relinking or replacing a file can leave the same asset id pointing at different pictures, and
 * a matte made for the old ones is silently wrong. At commit the host recorded the source's
 * content fingerprint and the decoded-frame sha256 of the coverage's exact first and last frames
 * plus 16 evenly spaced frames. This re-measures them:
 *
 * - fingerprint unchanged → unchanged (no decode at all);
 * - fingerprint changed, every sampled frame decodes to the same hash at the same pts →
 *   unchanged (a remux or metadata edit keeps the matte valid);
 * - otherwise → STALE, including when the frames cannot be decoded or were never sampled:
 *   a matte that cannot be proven to match is not assumed to.
 *
 * Re-proxying never changes the source file, so a proxy regeneration keeps mattes as they are;
 * the check exists for the file the matte was made from.
 */
import path from 'node:path';
import { createLogger } from '@framepilot/shared-types';
import type { MatteArtifactRecord } from '@framepilot/capability-packs';
import type { MatteMediaInspector } from './matte-media-inspector.js';
import { readMatteRecord, sourceContentFingerprint } from './matte-store.js';
import { MATTE_REMEDIES, matteMasksOf, type MatteValidationIssue } from './matte-validation.js';

const log = createLogger('desktop:capability-packs:matte-media-recheck');

/** "The source media changed": STALE, refused by the export with the same sentence. */
export const MATTE_MEDIA_CHANGED = 'matte_media_changed' as const;
export const MATTE_MEDIA_CHANGED_REMEDY = MATTE_REMEDIES.matte_media_changed.remedy;

export type MatteMediaVerdict = 'unchanged' | 'changed';

export async function recheckMatteSource(
  record: MatteArtifactRecord,
  mediaPath: string,
  inspector: MatteMediaInspector,
  signal?: AbortSignal,
): Promise<MatteMediaVerdict> {
  try {
    const timing = await inspector.videoTiming(mediaPath, signal);
    if ((await sourceContentFingerprint(mediaPath, timing)) === record.contentFingerprint) return 'unchanged';
    if (record.sourceSamples.length === 0) return 'changed';
    const hashes = await inspector.frameHashesByPts(
      mediaPath,
      record.sourceSamples.map((sample) => sample.pts),
      signal,
    );
    return record.sourceSamples.every((sample, index) => hashes[index] === sample.sha256) ? 'unchanged' : 'changed';
  } catch (error) {
    if (signal?.aborted === true) throw error;
    // Unreadable media (missing after a bad relink, undecodable) cannot vouch for the matte.
    return 'changed';
  }
}

/**
 * STALE issues for every matte mask whose artifact's source media changed.
 *
 * @param assetIds - Only re-check these assets (the ones a relink or replace just touched);
 *   omit to check every asset that carries a matte.
 */
export async function recheckProjectMatteMedia(
  projectDir: string,
  project: { readonly assets?: readonly { readonly id: string; readonly path: string }[] },
  inspector: MatteMediaInspector,
  options: { readonly assetIds?: readonly string[]; readonly signal?: AbortSignal } = {},
): Promise<MatteValidationIssue[]> {
  const only = options.assetIds === undefined ? undefined : new Set(options.assetIds);
  const verdicts = new Map<string, MatteMediaVerdict | 'skip'>();
  const issues: MatteValidationIssue[] = [];
  for (const mask of matteMasksOf(project)) {
    // Verdicts are per artifact AND asset: one matte can sit on clips of different assets.
    const verdictKey = `${mask.key}|${mask.assetId ?? ''}`;
    if (!verdicts.has(verdictKey)) {
      const record = await readMatteRecord(projectDir, mask.key).catch(() => undefined);
      const assetId = record?.assetId ?? mask.assetId;
      const asset = project.assets?.find((candidate) => candidate.id === assetId);
      if (asset === undefined || (only !== undefined && !only.has(asset.id))) {
        verdicts.set(verdictKey, 'skip');
      } else if (record === undefined) {
        // No record means nothing to prove the relinked media against: a matte that cannot be
        // shown to match is STALE, never silently kept (BR4.12 re-review).
        verdicts.set(verdictKey, 'changed');
      } else {
        // A saved project may store media relative to its folder; the engine's export and the
        // fp-media handler resolve it there, so the re-check must measure the same file (not one
        // relative to main's working directory, which is never the project and reads as STALE).
        const mediaPath = path.resolve(projectDir, asset.path);
        verdicts.set(verdictKey, await recheckMatteSource(record, mediaPath, inspector, options.signal));
      }
    }
    if (verdicts.get(verdictKey) !== 'changed') continue;
    issues.push({
      clipId: mask.clipId,
      maskId: mask.maskId,
      artifactKey: mask.key,
      code: MATTE_MEDIA_CHANGED,
      status: 'stale',
      remedy: MATTE_MEDIA_CHANGED_REMEDY,
    });
  }
  if (issues.length > 0) log.action('matteMediaChanged', { masks: issues.length });
  return issues;
}
