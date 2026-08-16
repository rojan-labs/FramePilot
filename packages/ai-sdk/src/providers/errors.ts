/**
 * @framepilot/ai-sdk/providers/errors — classify a failed provider response or a
 * thrown transport error into a typed {@link ProviderError}
 * (plan `AGENT-ORCHESTRATION-RELIABILITY.md` R1, ADR 0035).
 *
 * WHY: every provider used to `throw new Error(...)` on the first non-2xx, so no
 * caller could tell a transient 429 (retry) from a permanent 401 (fail fast). This
 * module is the single place that maps HTTP status + body into a `ProviderError`
 * with a `retryable` flag and an optional `retryAfterMs`.
 */
import { ProviderError, type ProviderErrorKind } from '../reliability/types.js';

/** Minimal shape of the header bag we read `Retry-After` from (case-insensitive). */
export interface HeaderLike {
  get(name: string): string | null;
}

/**
 * Parse an HTTP `Retry-After` value into milliseconds. Supports both forms:
 * a delta-seconds integer (`"30"`) and an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`).
 * Returns `undefined` for a missing/unparseable value or a date in the past.
 *
 * @param value - The raw header value (or `null` when absent).
 * @param now - Injectable clock for deterministic tests (defaults to `Date.now`).
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now: () => number = Date.now,
): number | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  // Delta-seconds form.
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  // HTTP-date form.
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  const deltaMs = dateMs - now();
  return deltaMs > 0 ? deltaMs : undefined;
}

/** Map an HTTP status code to a {@link ProviderErrorKind}. */
export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 429) return 'rate_limit';
  if (status === 529) return 'overloaded';
  if (status === 401 || status === 403) return 'auth';
  if (status === 400 || status === 422) return 'bad_request';
  if (status >= 500) return 'server';
  // Any other 4xx we can't act on is a bad request from our side.
  return 'bad_request';
}

/**
 * True when a provider error body signals Anthropic's transient `overloaded_error`
 * (which can arrive as a 200-with-error-frame or a 5xx). Cheap substring probe so a
 * malformed/huge body never throws here.
 */
function looksOverloaded(body: string): boolean {
  return body.includes('overloaded_error') || body.includes('overloaded');
}

/**
 * Classify a non-2xx provider HTTP response into a typed {@link ProviderError}.
 *
 * @param provider - Provider name, for the error message.
 * @param status - HTTP status code.
 * @param body - Response body text (used to detect `overloaded_error` and for context).
 * @param headers - Optional response headers (read for `Retry-After`).
 * @param now - Injectable clock for `Retry-After` HTTP-date math.
 */
export function classifyResponse(
  provider: string,
  status: number,
  body: string,
  headers?: HeaderLike,
  now: () => number = Date.now,
): ProviderError {
  const kind: ProviderErrorKind =
    status < 500 || status === 529
      ? kindForStatus(status)
      : looksOverloaded(body)
        ? 'overloaded'
        : 'server';
  const retryAfterMs = parseRetryAfterMs(headers?.get('retry-after'), now);
  const snippet = body.length > 300 ? `${body.slice(0, 300)}…` : body;
  return new ProviderError(
    `${provider} API error ${status}: ${snippet}`,
    kind,
    retryAfterMs !== undefined ? { status, retryAfterMs } : { status },
  );
}

/** Map a wire-format error `type` string onto a {@link ProviderErrorKind}. */
function kindForErrorType(type: string, body: string): ProviderErrorKind {
  if (/overloaded/i.test(type) || looksOverloaded(body)) return 'overloaded';
  if (/rate.?limit/i.test(type)) return 'rate_limit';
  if (/(authentication|permission|api.?key)/i.test(type)) return 'auth';
  if (/(invalid_request|invalid.?param|not_found)/i.test(type)) return 'bad_request';
  return 'server';
}

/**
 * Classify an **in-stream** SSE error frame into a typed {@link ProviderError}, or
 * `undefined` when the payload is not an error frame.
 *
 * WHY: a 200 response can still fail mid-body. Both wire formats we speak say so inside
 * the stream — Anthropic sends `{"type":"error","error":{"type":"overloaded_error",…}}`,
 * OpenAI-compatible gateways send `{"error":{"message":"…"}}` — and both then close the
 * body normally. A parser that only reads `choices`/`content_block` sees no content and
 * ends the stream cleanly, so an upstream outage arrives at the orchestrator disguised as
 * a successful, empty answer: the run reads it as "the model has nothing to add", reports
 * "no further edits", and edits nothing. Turning the frame into the same typed error a
 * non-2xx response produces puts it back on the normal path: `ResilientProvider` retries
 * it before the first chunk, and a run that still can't get an answer fails honestly.
 *
 * @param provider - Provider name, for the error message.
 * @param payload - One already-parsed `data:` frame from the stream.
 */
export function classifyStreamError(provider: string, payload: unknown): ProviderError | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const frame = payload as { error?: unknown; type?: unknown };
  if (frame.error === undefined || frame.error === null) return undefined;
  const detail = typeof frame.error === 'object' ? (frame.error as Record<string, unknown>) : {};
  const type = typeof detail['type'] === 'string' ? detail['type'] : '';
  const message =
    typeof frame.error === 'string'
      ? frame.error
      : typeof detail['message'] === 'string'
        ? detail['message']
        : JSON.stringify(frame.error);
  const snippet = message.length > 300 ? `${message.slice(0, 300)}…` : message;
  return new ProviderError(
    `${provider} stream error: ${snippet}`,
    // Lowercased for the probe: gateways word this frame "Overloaded", not "overloaded".
    kindForErrorType(type, `${type} ${message}`.toLowerCase()),
  );
}

/** Longest error body worth showing a user; the rest is noise in a chat bubble. */
const MAX_BODY_SNIPPET = 300;

/**
 * Reduce a provider error body to something readable in the sidebar.
 *
 * A misconfigured base URL is answered by whatever HTTP server is actually listening,
 * and that answer is usually an HTML error page. Pasted verbatim it fills the chat with
 * `<!DOCTYPE html>…<pre>Cannot POST /api/chat</pre>…` — the one useful phrase buried in
 * markup. The `<pre>`/`<title>` text is what Express, nginx and friends put the actual
 * reason in, so it is lifted out; any other HTML degrades to tag-stripped text.
 *
 * The markup is matched anywhere in the string, not just at the start: provider SDKs
 * prefix the body with the status they saw (`404 <!DOCTYPE html>…`), so anchoring would
 * miss exactly the case this was written for.
 */
export function readableErrorBody(body: string): string {
  const trimmed = body.trim();
  if (!/<(!doctype|html|body|pre|title)\b/i.test(trimmed)) {
    return trimmed.length > MAX_BODY_SNIPPET ? `${trimmed.slice(0, MAX_BODY_SNIPPET)}…` : trimmed;
  }
  const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(trimmed)?.[1];
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(trimmed)?.[1];
  const text = (pre ?? title ?? trimmed.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  return text.length > MAX_BODY_SNIPPET ? `${text.slice(0, MAX_BODY_SNIPPET)}…` : text;
}

/** The HTTP status a provider SDK's error object carries, when it carries one. */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as { status?: unknown; response?: { status?: unknown } };
  const direct = record.status;
  if (typeof direct === 'number') return direct;
  const nested = record.response?.status;
  return typeof nested === 'number' ? nested : undefined;
}

/**
 * Classify an error thrown by a **LangChain chat model** into a typed
 * {@link ProviderError}.
 *
 * WHY this exists separately from {@link classifyResponse}: the native adapters owned
 * their own `fetch`, so they saw the status and classified it. The LangChain adapters
 * (ADR 0105) do not — the SDK throws, and every thrown error fell through to
 * `retry.ts`'s catch-all, which labels anything unrecognised `network`. `network` is a
 * retryable kind, so *every* provider failure became retryable: a 401 from a wrong key
 * and a 404 from a wrong base URL were both retried the full budget before surfacing,
 * with the raw upstream body as their message. Reading the status the SDK already
 * attached puts those back on the same footing as the ASR paths — permanent failures
 * fail fast, and the message is the reason rather than an HTML page.
 *
 * @param provider - Provider name, for the error message.
 * @param error - Whatever the chat model threw.
 */
export function classifyLangChainError(provider: string, error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const status = statusOf(error);
  const raw = error instanceof Error ? error.message : String(error);
  const detail = readableErrorBody(raw);
  if (status === undefined)
    return new ProviderError(`${provider} request failed: ${detail}`, 'network');
  const kind: ProviderErrorKind =
    status >= 500 && status !== 529 && looksOverloaded(raw) ? 'overloaded' : kindForStatus(status);
  return new ProviderError(`${provider} API error ${status}: ${detail}`, kind, { status });
}

/**
 * Classify a thrown transport error (e.g. `fetch` rejecting on DNS/connection
 * failure, or an abort/timeout) into a {@link ProviderError}. An already-classified
 * `ProviderError` passes through unchanged. `AbortError` from a real user cancel is
 * re-thrown by callers before reaching here; a timeout is surfaced as `network`.
 */
export function classifyThrown(provider: string, error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError(`${provider} request failed: ${message}`, 'network');
}
