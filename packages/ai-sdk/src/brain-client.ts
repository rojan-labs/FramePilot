/**
 * @framepilot/ai-sdk/brain-client — read persisted analysis results from the
 * engine sidecar's project brain (plan B1.4).
 *
 * WHY: analysis results are persisted per-asset in the project brain (plan
 * B1.3), so a new agent run can start with everything already known about the
 * media — `semanticIndexFor()` gets a warmed {@link AnalysisResultsBag}
 * instead of an empty one, and no ffmpeg re-runs for data the brain already
 * holds. This module is the TS side of that contract: Zod schemas mirroring
 * the engine's Pydantic response models (pinned by
 * `engine/python/tests/test_brain_client_ts_parity.py`), an injectable-fetch
 * reader, and the rows → bag mapper.
 *
 * Honest degradation: every failure path (no sidecar, HTTP error, timeout,
 * malformed payload, `available: false`) returns `undefined` — the caller
 * proceeds exactly as if the brain did not exist, never with fabricated data.
 */
import { createLogger } from '@framepilot/shared-types';
import { z } from 'zod/v4';
import type { AnalysisResultsBag } from './kernel/semantic-index/semantic-index.js';
// Reuse the visual-index Zod schema rather than re-declaring the shape — the two must
// never diverge (MI4.2). It mirrors the engine's Pydantic `VisualStatusResponse`
// field-for-field and is parity-checked by `test_brain_client_ts_parity.py`.
// Imported for the reader/summarizer only — NOT re-exported here (the barrel already
// exports it from visual-index-client.js; re-exporting would make the name ambiguous
// across the two `export *`s in index.ts).
import { type VisualStatusResponse, visualStatusResponseSchema } from './visual-index-client.js';

const log = createLogger('ai-sdk:brain-client');

/** Default per-read timeout — a brain read is a local SQLite lookup, not a decode. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * One persisted analysis result for an asset, as `GET /brain/analysis` returns
 * it. Mirrors the engine's Pydantic `AnalysisResultRow`
 * (`framepilot_engine/brain/models.py`) field-for-field — the parity test
 * reads these keys straight from this source file.
 */
export const analysisResultRowSchema = z.object({
  assetId: z.string(),
  /** Analyzer id: `silence` | `scenes` | `beats` | `loudness` | … */
  kind: z.string(),
  /** Analysis tier the result was produced under: `quick` | `standard` | `deep`. */
  depth: z.string(),
  /** Stable hash of the analyzer parameters; part of the engine's cache key. */
  paramsHash: z.string(),
  /** The typed analyzer output, as JSON (camelCase — the tool payload shape). */
  result: z.record(z.string(), z.unknown()),
  /** Provenance: `machine` (deterministic tooling) | `model` | `human`. */
  source: z.string(),
  /** Tool/model id + version that produced the result. */
  tool: z.string(),
  /** ISO-8601 UTC. */
  createdAt: z.string(),
});

export type AnalysisResultRow = z.infer<typeof analysisResultRowSchema>;

/**
 * `GET /brain/analysis` response. `available: false` is the engine's
 * honest-unavailable shape (no sandbox root, no brain, traversal-rejected id)
 * — zero rows plus the reason, never an HTTP error or a fabricated empty
 * success. Mirrors Pydantic `BrainAnalysisResponse` (`service.py`).
 */
export const brainAnalysisResponseSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullish(),
  results: z.array(analysisResultRowSchema).default([]),
});

export type BrainAnalysisResponse = z.infer<typeof brainAnalysisResponseSchema>;

export interface BrainClientOptions {
  /** Sidecar base URL (e.g. `http://127.0.0.1:8765`). */
  readonly baseUrl: string;
  /** Injectable `fetch` (defaults to the global) for testing / Electron net. */
  readonly fetchFn?: typeof fetch;
  /** Per-read timeout in ms; a hung sidecar must not stall a run's start. */
  readonly timeoutMs?: number;
}

/**
 * Reads a project's persisted analysis rows, or `undefined` when the brain
 * cannot serve them (browser build, sidecar down, brain unavailable).
 */
export type BrainAnalysisReader = (
  projectId: string,
  assetId?: string,
) => Promise<readonly AnalysisResultRow[] | undefined>;

/**
 * Create a {@link BrainAnalysisReader} against the sidecar's
 * `GET /brain/analysis` route. Never throws — every failure degrades to
 * `undefined` with a debug log, so run-start warming can never break a run.
 */
export function createBrainAnalysisReader(options: BrainClientOptions): BrainAnalysisReader {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (projectId, assetId) => {
    const query = new URLSearchParams({ projectId });
    if (assetId !== undefined) query.set('assetId', assetId);
    const url = `${options.baseUrl}/brain/analysis?${query.toString()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // The fetch + parse attempt is its own try/catch (never throws — every failure
    // returns `undefined`); the outer try/finally only owns clearing `timer`. Kept
    // separate so the "catch rethrows" shape a combined try/catch/finally implies
    // never exists — this reader's "never throws" contract has no rethrow path to
    // hide.
    const attempt = async (): Promise<readonly AnalysisResultRow[] | undefined> => {
      try {
        const response = await fetchFn(url, { signal: controller.signal });
        if (!response.ok) {
          log.debug('brain read → HTTP error; degrading to no warm data', {
            projectId,
            status: response.status,
          });
          return undefined;
        }
        const parsed = brainAnalysisResponseSchema.safeParse(await response.json());
        if (!parsed.success) {
          log.warn('brain read → payload did not match schema; degrading', { projectId });
          return undefined;
        }
        if (!parsed.data.available) {
          log.debug('brain read → brain unavailable; degrading', {
            projectId,
            reason: parsed.data.reason ?? undefined,
          });
          return undefined;
        }
        return parsed.data.results;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log.debug('brain read → request failed; degrading to no warm data', { projectId, reason });
        return undefined;
      }
    };
    try {
      return await attempt();
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The persisted analyzer kinds the {@link AnalysisResultsBag} can carry. */
const BAG_FIELD_FOR_KIND = {
  scenes: 'shots',
  silence: 'silences',
  beats: 'beats',
  loudness: 'loudness',
  black: 'black',
} as const satisfies Record<string, keyof AnalysisResultsBag>;

/**
 * Map persisted brain rows to the {@link AnalysisResultsBag} the semantic
 * index ingests, reconstructing each field's legacy single-asset tool payload
 * (`{ assetId, ...result }` — e.g. `{ assetId, cuts: [...] }` for scenes).
 *
 * Each bag field holds ONE asset's payload (the bag predates multi-asset
 * analysis — see `semantic-index.ts`); when several assets have rows of the
 * same kind, the newest row (by `createdAt`, ties → last listed) wins. That is
 * a documented narrowing, not data loss: the brain still holds every row, and
 * the loop's analysis tools remain available for the other assets.
 * `undefined` when no row maps to any bag field — the honest "nothing to warm"
 * result, indistinguishable from a bag-less call downstream.
 */
export function analysisBagFromRows(
  rows: readonly AnalysisResultRow[],
): AnalysisResultsBag | undefined {
  const newestByKind = new Map<keyof typeof BAG_FIELD_FOR_KIND, AnalysisResultRow>();
  for (const row of rows) {
    if (!(row.kind in BAG_FIELD_FOR_KIND)) continue;
    const kind = row.kind as keyof typeof BAG_FIELD_FOR_KIND;
    const current = newestByKind.get(kind);
    if (!current || row.createdAt >= current.createdAt) newestByKind.set(kind, row);
  }
  if (newestByKind.size === 0) return undefined;
  const bag: { -readonly [K in keyof AnalysisResultsBag]: AnalysisResultsBag[K] } = {};
  for (const [kind, row] of newestByKind) {
    bag[BAG_FIELD_FOR_KIND[kind]] = { assetId: row.assetId, ...row.result };
  }
  return bag;
}

/**
 * `POST /brain/session-context` response (plan B6.3). Mirrors the engine's
 * Pydantic `SessionContext` (`framepilot_engine/brain/models.py`) — the parity
 * test reads these keys straight from this source file. The sections are
 * markdown the engine has already bounded (recent-entry tails, capped soul
 * digest).
 */
export const sessionContextResponseSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullish(),
  /** The media-bin digest — one section per asset. */
  binSummary: z.string().default(''),
  /** The most recent day's session note. */
  sessionNote: z.string().default(''),
  /** Tail of `corrections.md` — edits the user rejected, and why. */
  corrections: z.string().default(''),
  /** Tail of `decisions.md` — edits the user accepted. */
  decisions: z.string().default(''),
  /** The user's cross-project soul digest (plan B6.2). */
  soul: z.string().default(''),
});

export type SessionContextResponse = z.infer<typeof sessionContextResponseSchema>;

/**
 * Reads a project's assembled session context, or `undefined` when the brain
 * cannot serve it (browser build, sidecar down, no sandbox root).
 */
export type SessionContextReader = (
  projectId: string,
) => Promise<SessionContextResponse | undefined>;

/**
 * Create a {@link SessionContextReader} against `POST /brain/session-context`.
 * Never throws — every failure degrades to `undefined`, so a session that starts
 * without its memory still starts.
 */
export function createSessionContextReader(options: BrainClientOptions): SessionContextReader {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (projectId) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Same split as `createBrainAnalysisReader`: the fetch + parse attempt owns its
    // own try/catch (never throws), the outer try/finally only clears `timer`.
    const attempt = async (): Promise<SessionContextResponse | undefined> => {
      try {
        const response = await fetchFn(`${options.baseUrl}/brain/session-context`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId }),
          signal: controller.signal,
        });
        if (!response.ok) {
          log.debug('session context → HTTP error; degrading to none', {
            projectId,
            status: response.status,
          });
          return undefined;
        }
        const parsed = sessionContextResponseSchema.safeParse(await response.json());
        if (!parsed.success) {
          log.warn('session context → payload did not match schema; degrading', { projectId });
          return undefined;
        }
        if (!parsed.data.available) {
          log.debug('session context → unavailable; degrading', {
            projectId,
            reason: parsed.data.reason ?? undefined,
          });
          return undefined;
        }
        return parsed.data;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log.debug('session context → request failed; degrading to none', { projectId, reason });
        return undefined;
      }
    };
    try {
      return await attempt();
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Default bound for the injected digest — a context tier, not a document dump. */
export const DEFAULT_SESSION_DIGEST_MAX_CHARS = 4000;

/** The sections a session digest renders, in priority order (most useful first). */
const DIGEST_SECTIONS: readonly {
  readonly key: keyof Pick<
    SessionContextResponse,
    'corrections' | 'decisions' | 'soul' | 'sessionNote' | 'binSummary'
  >;
  readonly heading: string;
}[] = [
  // Corrections lead: the costliest mistake is repeating one the user already rejected.
  { key: 'corrections', heading: 'Edits this user rejected before (do not repeat these)' },
  { key: 'decisions', heading: 'Edits this user accepted before' },
  { key: 'soul', heading: "This user's working style, across projects" },
  { key: 'sessionNote', heading: 'Last session' },
  { key: 'binSummary', heading: 'Media bin' },
];

/**
 * Render a {@link SessionContextResponse} as the bounded markdown digest the
 * context builder injects (`ContextInput.sessionContext`, plan B6.3).
 *
 * The digest is a PREFIX of {@link DIGEST_SECTIONS} in priority order: it stops
 * at the first section that would bust `maxChars`, so the model gets whole,
 * coherent sections rather than a mid-sentence truncation, and a lower-priority
 * section can never jump ahead of a dropped higher-priority one (showing "what
 * they accepted" while silently dropping "what they rejected" would actively
 * mislead).
 *
 * The first non-empty section is emitted even if it alone exceeds `maxChars` —
 * the same rule the engine's tier truncation uses (`fit_entries` always keeps
 * the newest entry): one fat section must not starve the digest to nothing.
 * Returns '' only when nothing has been learned yet.
 */
export function summarizeSessionContext(
  context: SessionContextResponse,
  maxChars: number = DEFAULT_SESSION_DIGEST_MAX_CHARS,
): string {
  const blocks: string[] = [];
  let used = 0;
  for (const { key, heading } of DIGEST_SECTIONS) {
    const body = context[key].trim();
    if (body === '') continue;
    const block = `### ${heading}\n${body}`;
    if (blocks.length > 0 && used + block.length > maxChars) break;
    blocks.push(block);
    used += block.length;
  }
  return blocks.join('\n\n');
}

/**
 * Compose reader + digest into a session-start hook: project id in, bounded
 * digest (or `undefined`) out — ready for `ContextInput.sessionContext`.
 */
export function createSessionContextDigester(
  options: BrainClientOptions,
  maxChars: number = DEFAULT_SESSION_DIGEST_MAX_CHARS,
): (projectId: string) => Promise<string | undefined> {
  const read = createSessionContextReader(options);
  return async (projectId) => {
    const context = await read(projectId);
    if (!context) return undefined;
    return summarizeSessionContext(context, maxChars) || undefined;
  };
}

/**
 * Compose reader + mapper into the run-start warm hook the orchestrator takes
 * (`OrchestratorOptions.warmAnalysis`, plan B1.4): project id in, warmed bag
 * (or `undefined`) out.
 */
export function createAnalysisBagWarmer(
  options: BrainClientOptions,
): (projectId: string) => Promise<AnalysisResultsBag | undefined> {
  const read = createBrainAnalysisReader(options);
  return async (projectId) => {
    const rows = await read(projectId);
    if (!rows || rows.length === 0) return undefined;
    return analysisBagFromRows(rows);
  };
}

// ---------------------------------------------------------------------------
// Visual-index status (plan MI6.2) — one line so the model knows when it can see
// ---------------------------------------------------------------------------

/**
 * Reads a project's visual-index coverage/health (`GET /brain/visual/status`), or
 * `undefined` when the brain cannot serve it (browser build, sidecar down, no sandbox
 * root). Mirrors {@link BrainAnalysisReader}'s honest-degradation contract.
 */
export type VisualStatusReader = (projectId: string) => Promise<VisualStatusResponse | undefined>;

/**
 * Create a {@link VisualStatusReader} against the sidecar's `GET /brain/visual/status`
 * route. Never throws — every failure degrades to `undefined` with a debug log, so a
 * context build can never break on it. Keys are never sent (this is a bodyless GET) and
 * the key value is never returned by either side.
 */
export function createVisualStatusReader(options: BrainClientOptions): VisualStatusReader {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (projectId) => {
    const query = new URLSearchParams({ projectId });
    const url = `${options.baseUrl}/brain/visual/status?${query.toString()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Same split as the other readers: the fetch + parse attempt owns its own try/catch
    // (never throws — every failure returns `undefined`); the outer try/finally only
    // clears `timer`. An `available: false` is a REAL engine response (honest reason),
    // returned as-is — unlike the analysis reader, the summarizer wants that reason.
    const attempt = async (): Promise<VisualStatusResponse | undefined> => {
      try {
        const response = await fetchFn(url, { signal: controller.signal });
        if (!response.ok) {
          log.debug('visual status → HTTP error; degrading to no status', {
            projectId,
            status: response.status,
          });
          return undefined;
        }
        const parsed = visualStatusResponseSchema.safeParse(await response.json());
        if (!parsed.success) {
          log.warn('visual status → payload did not match schema; degrading', { projectId });
          return undefined;
        }
        return parsed.data;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log.debug('visual status → request failed; degrading to no status', { projectId, reason });
        return undefined;
      }
    };
    try {
      return await attempt();
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Render a {@link VisualStatusResponse} as the one compact line the context builder
 * injects (`ContextInput.visualStatus`, plan MI6.2), so the model knows when it can SEE
 * the footage and when it cannot:
 *
 * - unavailable (no sandbox root / unusable brain) → the honest reason;
 * - no embeddings key → content SEARCH is off (search_visual/describe_footage stay empty);
 * - available but nothing indexed → search is not ready yet;
 * - available and indexed → coverage, vector count, and backend, and that it can search.
 *
 * Two things this line must never say, both of which it used to. It must not tell the
 * model to `index_media`: indexing is implicit lifecycle work driven by the app
 * (`ensureMediaUnderstanding`), the tool is withheld from every model-facing scope
 * (`IMPLICIT_ONLY_TOOL_NAMES`), and naming it sends the model after a capability it does
 * not have. And it must not say the model "cannot see": `get_frame` renders any moment of
 * the timeline as an image, independently of the visual INDEX, so the accurate claim is
 * that it cannot SEARCH the footage by content — a model told it is blind stops looking.
 *
 * Pure + deterministic — the reader is what does I/O.
 */
export function summarizeVisualStatus(status: VisualStatusResponse): string {
  if (!status.available) {
    const reason = status.reason ?? 'no project sandbox is configured';
    return `Visual index: unavailable (${reason}) — you cannot SEARCH this footage by content. Look at a specific moment with get_frame, or rely on the transcript and ask the editor.`;
  }
  if (!status.keyConfigured) {
    return 'Visual index: no embeddings key configured, so search_visual and describe_footage return nothing — there is no content search. Look at a specific moment with get_frame instead; never guess what is on screen.';
  }
  const vectors = status.counts.vectors ?? 0;
  if (status.indexedAssets === 0 || vectors === 0) {
    return `Visual index: 0/${status.totalAssets} assets indexed — indexing runs automatically in the background, so search_visual and describe_footage stay empty until it finishes. Look at a specific moment with get_frame instead of waiting.`;
  }
  const backend = status.backend ? `, ${status.backend} backend` : '';
  return `Visual index: ${status.indexedAssets}/${status.totalAssets} assets, ${vectors} vector${vectors === 1 ? '' : 's'}${backend} — use search_visual to ground content-dependent edits and describe_footage to read an asset in order.`;
}

/**
 * Compose reader + summarizer into a context hook: project id in, the one-line visual
 * status (or `undefined` when the brain is unreachable) out — ready for
 * `ContextInput.visualStatus`.
 */
export function createVisualStatusDigester(
  options: BrainClientOptions,
): (projectId: string) => Promise<string | undefined> {
  const read = createVisualStatusReader(options);
  return async (projectId) => {
    const status = await read(projectId);
    if (!status) return undefined;
    return summarizeVisualStatus(status);
  };
}
