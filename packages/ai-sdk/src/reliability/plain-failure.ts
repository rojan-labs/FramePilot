/**
 * @framepilot/ai-sdk/reliability/plain-failure — turn a thrown run failure into a
 * sentence a video editor can act on.
 *
 * WHY: when an agent run threw, the failure card showed the raw throw message —
 * `anthropic API error 429: {"type":"error",…}`, `TypeError: fetch failed`, a JSON
 * parse error. That is a stack-trace shown to someone who wanted a cut tightened:
 * it says nothing about what to do next, and it fails goal.md's release gate
 * ("every known failure mode either recovers or fails with a message a
 * non-technical user can act on").
 *
 * {@link ProviderError} already classifies provider failures into `kind` /
 * `status` / `retryable` / `retryAfterMs`, so the headline can be chosen from the
 * classification instead of parroting the wire. Nothing is lost — the raw text
 * moves into `detail`, which the UI keeps behind "details" for a bug report.
 *
 * This module is pure: no clock, no I/O, no state. Same error in, same copy out.
 */
import { ProviderError } from './types.js';

/** What the failure card shows: a headline, the raw text behind it, and retry-ability. */
export interface PlainRunFailure {
  /** The editor-facing sentence — what went wrong and what to do next. */
  readonly message: string;
  /** The untouched technical text (plus HTTP status when known), for "details". */
  readonly detail: string;
  /** Whether offering a retry is honest. Mirrors `ProviderError.retryable`. */
  readonly retryable: boolean;
}

/** Shown when the caller has no provider name to give (never leave a hole in a sentence). */
const UNKNOWN_PROVIDER = 'the AI provider';

/** Transport-level throws that never reach classification (DNS, refused socket, dead proxy). */
const TRANSPORT_SIGNS = ['fetch failed', 'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN'];

/** Rate-limit copy falls back to this when the server sent no `Retry-After`. */
const UNKNOWN_WAIT = 'a minute';

function rawText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** `Retry-After` in the editor's units: whole seconds, never "0 seconds". */
function waitPhrase(retryAfterMs: number | undefined): string {
  if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
    return UNKNOWN_WAIT;
  }
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

function looksLikeTransportFailure(error: unknown): boolean {
  const text = rawText(error);
  return TRANSPORT_SIGNS.some((sign) => text.includes(sign));
}

function networkMessage(provider: string): string {
  return `FramePilot couldn't reach ${provider}. Check your connection (or the proxy/bridge you use) and try again.`;
}

function messageForKind(error: ProviderError, provider: string): string {
  switch (error.kind) {
    case 'auth':
      return `FramePilot can't sign in to ${provider}. Check the API key in Settings → AI, then try again.`;
    case 'rate_limit':
      return `${provider} is rate-limiting requests. Wait ${waitPhrase(error.retryAfterMs)} and try again.`;
    case 'overloaded':
    case 'server':
      return `${provider} is having trouble right now (server error). Try again in a minute; nothing on your timeline was changed by this failure.`;
    case 'network':
      return networkMessage(provider);
    case 'bad_request':
      return `${provider} rejected the request. This is usually a model or setting mismatch — open the details, and try a shorter request or a different model.`;
  }
}

/**
 * Describe a failed AI run in the editor's words.
 *
 * Abort/cancel is deliberately not handled here — a cancelled run is not a
 * failure, and the caller settles it as `cancelled` without an error card.
 *
 * @param error - Whatever the run threw. A {@link ProviderError} is classified;
 *   anything else is matched for transport signs, then falls back to generic copy.
 * @param provider - Provider display name (`provider.name`); omitted → "the AI provider".
 * @returns The headline, the raw detail, and whether to offer a retry.
 */
export function plainRunFailure(error: unknown, provider?: string): PlainRunFailure {
  const name = provider && provider.trim() !== '' ? provider : UNKNOWN_PROVIDER;
  const raw = rawText(error);

  if (error instanceof ProviderError) {
    const detail = error.status === undefined ? raw : `${raw} (HTTP ${error.status})`;
    // A thrower that already knows the editor-facing cause (an exhausted output
    // allowance, say) beats the generic copy for its `kind` — never overwrite it.
    const message = error.editorMessage ?? messageForKind(error, name);
    return { message, detail, retryable: error.retryable };
  }

  if (looksLikeTransportFailure(error)) {
    // A retry is honest here: the connection may simply come back.
    return { message: networkMessage(name), detail: raw, retryable: true };
  }

  return {
    message:
      'The AI run stopped unexpectedly. Try again; if it keeps happening, copy the details below when you report it.',
    detail: raw,
    retryable: true,
  };
}
