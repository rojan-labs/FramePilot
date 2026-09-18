/**
 * STALE and BROKEN mattes for the clip on screen (BR6.6).
 *
 * Only main can tell: the check hashes the media and the artifact's own files, which the renderer
 * has no access to. It runs when a clip with a background removal is selected, and again whenever
 * the artifact changes — a re-run after a fix is exactly when a BROKEN artifact would clear.
 *
 * The sentence shown is `issue.remedy`, which main copied verbatim from the engine's
 * `MATTE_REMEDIES`, so the Inspector, the export dialog and the render refusal cannot drift.
 */
import { useEffect, useState } from 'react';
import type { MatteValidationIssueWire } from '@framepilot/shared-types';
import { getBridge } from '../../../editor/bridge.js';

/**
 * Re-check one asset's mattes.
 *
 * @param assetId - The asset to check, or `null` when the clip has no background removal.
 * @param revision - Changes when the artifact does, to force a re-check.
 * @returns The issues main reported; empty in the browser build and while the check is in flight.
 */
export function useMatteIssues(
  assetId: string | null,
  revision?: string,
): readonly MatteValidationIssueWire[] {
  const [issues, setIssues] = useState<readonly MatteValidationIssueWire[]>([]);

  useEffect(() => {
    const recheck = getBridge()?.matteRecheckMedia;
    if (assetId === null || recheck === undefined) {
      setIssues([]);
      return;
    }
    let live = true;
    void recheck({ assetIds: [assetId] })
      .then((result) => {
        if (live) setIssues(result.ok ? result.issues : []);
      })
      .catch(() => {
        if (live) setIssues([]);
      });
    return () => {
      live = false;
    };
  }, [assetId, revision]);

  return issues;
}
