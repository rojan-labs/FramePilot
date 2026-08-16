/**
 * @framepilot/ai-sdk/providers/asr-types — speech-to-text provider contracts.
 *
 * The product exposes exactly two choices:
 * - `whisper-cli` — Local, offline whisper.cpp through the Python sidecar.
 * - `twelvelabs` — TwelveLabs' indexed native word transcript.
 *
 * Groq and NVIDIA remain recognized only as legacy persisted/config values while
 * callers migrate them to Local. Their adapters are not deleted until migration
 * coverage proves no saved setting or host request still references them.
 */
import { TranscriptWordSchema, type TranscriptWord } from '@framepilot/timeline-schema';
import { ProviderError } from '../reliability/types.js';

/** User-facing provider roster. Settings and new requests must derive from this tuple. */
export const ASR_PROVIDER_NAMES = ['whisper-cli', 'twelvelabs'] as const;

/** Historical values accepted only at config/settings migration boundaries. */
export const LEGACY_ASR_PROVIDER_NAMES = ['groq', 'nvidia'] as const;

export type UserAsrProviderName = (typeof ASR_PROVIDER_NAMES)[number];
export type LegacyAsrProviderName = (typeof LEGACY_ASR_PROVIDER_NAMES)[number];
/** Internal transitional union. New UI and persisted settings use UserAsrProviderName. */
export type AsrProviderName = UserAsrProviderName | LegacyAsrProviderName;

const ALL_ASR_PROVIDER_NAMES: readonly AsrProviderName[] = [
  ...ASR_PROVIDER_NAMES,
  ...LEGACY_ASR_PROVIDER_NAMES,
];

/** Narrow an untrusted string to a current user-facing provider. */
export function isUserAsrProviderName(value: string): value is UserAsrProviderName {
  return (ASR_PROVIDER_NAMES as readonly string[]).includes(value);
}

/** Narrow an untrusted string to a current or legacy provider for migration. */
export function isAsrProviderName(value: string): value is AsrProviderName {
  return (ALL_ASR_PROVIDER_NAMES as readonly string[]).includes(value);
}

/** Local whisper.cpp is the safe default: offline, free, and no consent gate. */
export const DEFAULT_ASR_PROVIDER: UserAsrProviderName = 'whisper-cli';

export interface AsrProviderMigration {
  readonly provider: UserAsrProviderName;
  /** Present when a formerly supported hosted provider was migrated to Local. */
  readonly migratedFrom?: LegacyAsrProviderName;
}

/**
 * Migrate an untrusted saved provider into the two-choice product contract.
 *
 * Existing TwelveLabs and Local choices survive. Groq/NVIDIA move to Local so a
 * reopened project never sends media to a hosted service the user can no longer
 * select. The caller may use `migratedFrom` for a one-time explanatory notice.
 */
export function migrateAsrProvider(value: unknown): AsrProviderMigration {
  if (typeof value === 'string' && isUserAsrProviderName(value)) return { provider: value };
  if (
    typeof value === 'string' &&
    (LEGACY_ASR_PROVIDER_NAMES as readonly string[]).includes(value)
  ) {
    return {
      provider: DEFAULT_ASR_PROVIDER,
      migratedFrom: value as LegacyAsrProviderName,
    };
  }
  return { provider: DEFAULT_ASR_PROVIDER };
}

/** Convenience for callers that only persist the migrated provider value. */
export function migrateAsrProviderName(value: unknown): UserAsrProviderName {
  return migrateAsrProvider(value).provider;
}

/** Legacy adapter defaults retained until their callers are fully removed. */
export const DEFAULT_NVIDIA_ASR_MODEL = 'nemotron-asr-streaming';
export const DEFAULT_GROQ_ASR_MODEL = 'whisper-large-v3';

/** Return a legacy hosted adapter's default model, when applicable. */
export function defaultAsrModel(provider: AsrProviderName): string | undefined {
  if (provider === 'nvidia') return DEFAULT_NVIDIA_ASR_MODEL;
  if (provider === 'groq') return DEFAULT_GROQ_ASR_MODEL;
  return undefined;
}

/** Whether media leaves the device for this provider. */
export function asrSendsAudioOffDevice(provider: AsrProviderName): boolean {
  return provider !== 'whisper-cli';
}

/** Whether a provider requires a hosted API key. */
export function asrNeedsApiKey(provider: AsrProviderName): boolean {
  return asrSendsAudioOffDevice(provider);
}

/** ASR provider configuration resolved from environment variables / settings. */
export interface AsrProviderConfig {
  readonly provider: AsrProviderName;
  readonly apiKey?: string;
  readonly model?: string;
  /** Engine sidecar base URL (whisper-cli) or a legacy hosted adapter base URL. */
  readonly baseUrl?: string;
}

/** A word-level transcript, or a typed unavailable reason. */
export type AsrResult =
  | { readonly available: true; readonly words: readonly TranscriptWord[] }
  | { readonly available: false; readonly reason: string };

/** Parse and validate the common timed-word response shared by every ASR adapter. */
export function parseAsrWords(provider: string, raw: string): readonly TranscriptWord[] {
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    throw new ProviderError(`${provider} returned malformed transcription JSON.`, 'server', {
      retryable: false,
    });
  }
  const words =
    typeof payload === 'object' && payload !== null && 'words' in payload
      ? ((payload as { words?: unknown }).words ?? [])
      : [];
  const parsed = TranscriptWordSchema.array().safeParse(words);
  if (!parsed.success || parsed.data.some((word) => word.end <= word.start)) {
    throw new ProviderError(`${provider} returned invalid word timestamps.`, 'server', {
      retryable: false,
    });
  }
  return parsed.data;
}

/** One configured ASR provider's capability: transcribe a piece of media. */
export interface AsrProvider {
  readonly name: AsrProviderName;
  readonly sendsAudioOffDevice: boolean;
}
