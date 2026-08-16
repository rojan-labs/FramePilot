/**
 * Compact authoritative-project transport used for routine host commits.
 *
 * The renderer already owns the full validated project. Sending that entire document
 * back after a tiny AI patch structured-clones waveform peaks, thumbnails, transcript,
 * clips and keyframes again. A normal same-revision commit therefore carries only the
 * typed patch plus the host's bounded restart history. Rebased commits deliberately fall
 * back to a full project snapshot because the renderer may not have the intervening work.
 */
export const PROJECT_PATCH_TRANSPORT_KIND = 'framepilot.project-patch.v1' as const;

export interface ProjectPatchTransport {
  readonly kind: typeof PROJECT_PATCH_TRANSPORT_KIND;
  /** Project id. Named `id` so existing host-only call sites can identify the project. */
  readonly id: string;
  readonly baseRevision: number;
  readonly revision: number;
  readonly patch: unknown;
  readonly history: unknown;
}

export function isProjectPatchTransport(value: unknown): value is ProjectPatchTransport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === PROJECT_PATCH_TRANSPORT_KIND &&
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    Number.isSafeInteger(record.baseRevision) &&
    Number(record.baseRevision) >= 0 &&
    Number.isSafeInteger(record.revision) &&
    Number(record.revision) >= 0 &&
    typeof record.patch === 'object' &&
    record.patch !== null &&
    Array.isArray(record.history)
  );
}
