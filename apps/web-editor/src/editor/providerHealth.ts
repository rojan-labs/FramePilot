/**
 * Did the configured AI provider ever actually answer? (plan/system-mission UX-11)
 *
 * Settings' readiness panel used to show a green dot and the provider's name whenever a
 * key was *present*. A key that returns 410 on every call reads exactly like a working
 * one, so the one place that claims to say whether FramePilot is ready to work said
 * something it could not know. The walkthrough caught it reporting NVIDIA NIM as ready
 * while the configured DeepSeek key was dead.
 *
 * This records the only evidence that settles it: a run that reached a terminal state
 * without a provider failure. Per provider, per device, in `localStorage` — it is a
 * convenience readout, not state anything depends on, so a private window that loses it
 * simply falls back to "key saved".
 */
import { createLogger } from '@framepilot/shared-types';

const log = createLogger('web:provider-health');
const KEY = 'framepilot.providerHealth';

/** ISO timestamps of the last successful call, keyed by provider name. */
type HealthRecord = Record<string, string>;

function read(): HealthRecord {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: HealthRecord = {};
    for (const [name, at] of Object.entries(parsed)) {
      if (typeof at === 'string') out[name] = at;
    }
    return out;
  } catch {
    // A private window, cleared site data, or a browser that refuses storage. Not
    // knowing is the honest answer here, and it is the same answer as "never called".
    return {};
  }
}

/** Note that `provider` answered a request successfully, just now. */
export function recordProviderSuccess(provider: string, now: Date = new Date()): void {
  if (provider === '') return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...read(), [provider]: now.toISOString() }));
  } catch (error) {
    log.debug('could not record provider health', { provider, error: String(error) });
  }
}

/** When `provider` last answered, or `undefined` if it never has on this device. */
export function lastProviderSuccess(provider: string): Date | undefined {
  const at = read()[provider];
  if (at === undefined) return undefined;
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Forget every recorded success (used by tests and by "reset to defaults"). */
export function clearProviderHealth(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}
