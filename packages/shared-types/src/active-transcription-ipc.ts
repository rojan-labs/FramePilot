/** Active speech-to-text choices allowed on new renderer→host requests. */
export const ACTIVE_ASR_PROVIDER_NAMES = ['whisper-cli', 'twelvelabs'] as const;
export type ActiveAsrProviderName = (typeof ACTIVE_ASR_PROVIDER_NAMES)[number];

/**
 * New transcription request contract. Legacy Groq/NVIDIA names are intentionally absent;
 * they exist only at persisted-config migration boundaries in ai-sdk.
 */
export interface ActiveTranscriptionRequest {
  readonly projectPath: string;
  readonly assetId: string;
  readonly provider: ActiveAsrProviderName;
}

export function isActiveAsrProviderName(value: unknown): value is ActiveAsrProviderName {
  return (
    typeof value === 'string' &&
    (ACTIVE_ASR_PROVIDER_NAMES as readonly string[]).includes(value)
  );
}

export function isActiveTranscriptionRequest(value: unknown): value is ActiveTranscriptionRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.projectPath === 'string' &&
    record.projectPath.trim().length > 0 &&
    typeof record.assetId === 'string' &&
    record.assetId.trim().length > 0 &&
    isActiveAsrProviderName(record.provider)
  );
}
