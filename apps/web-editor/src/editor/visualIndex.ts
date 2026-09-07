/**
 * Media-understanding host glue.
 *
 * The editor owns credentials and the sidecar owns media processing. Semantic tools call
 * {@link ensureProjectMediaUnderstanding} to prepare unchanged media implicitly. Users and
 * models never need to manage an index as a separate workflow.
 *
 * ## Where import-time warming went
 *
 * It used to live here, as `autoIndexImportedAssets`, and it ran only when an NVIDIA or
 * TwelveLabs key was configured. Both halves of that were wrong (ADR 0175): tier 0 of the
 * shot ledger needs no key, and a per-surface hook in the renderer left every asset the
 * AGENT acquired unindexed. Acquisition-time enrolment is now the desktop main process's
 * single batching enroller (`apps/desktop/electron/ai/asset-enrolment.ts`), which sees
 * human imports, stock and every other acquired asset alike.
 *
 * The browser build has no sidecar and no main process, so it enrols nothing and the
 * understanding surfaces degrade to `unavailable` — accepted per CLAUDE.md's desktop-first
 * rule. Nothing here throws when there is no engine to reach.
 */
import { createLogger } from '@framepilot/shared-types';
import type { AiConfig } from '@framepilot/shared-types';
import {
  ensureMediaUnderstanding,
  type EnsureMediaUnderstandingResult,
  type FootageMap,
  VisualIndexClient,
  summarizeFootageMap,
} from '@framepilot/ai-sdk';
import type { Project } from '@framepilot/timeline-schema';
import { resolveEngineBaseUrl } from './ai.js';
import { getBridge } from './bridge.js';

const log = createLogger('web-editor:visual-index');

/** Build a client against the same sidecar URL the analysis/ASR probes use. */
export function createVisualIndexClient(
  baseUrl: string = resolveEngineBaseUrl(),
): VisualIndexClient {
  const bridge = getBridge();
  return new VisualIndexClient({
    baseUrl,
    ...(bridge?.visualIndex ? { indexFn: (request) => bridge.visualIndex!(request) } : {}),
  });
}

/** The legacy built-in embedding key(s), trimmed. */
export function nvidiaEmbeddingsKeys(config: AiConfig): string | undefined {
  const keys = config.nvidiaEmbeddings?.trim();
  return keys ? keys : undefined;
}

/** The TwelveLabs key from config, trimmed. */
export function twelveLabsKey(config: AiConfig): string | undefined {
  const key = config.twelveLabs?.trim();
  return key ? key : undefined;
}

/**
 * The understanding credentials for a config, in the shape every request wants.
 *
 * Four call sites assembled this by hand and one of them got it wrong: the renderer
 * withheld the on-device key whenever a TwelveLabs key existed, so stills — which
 * TwelveLabs cannot index — had no backend at all. One helper, one policy.
 */
export function understandingCredentials(config: AiConfig): {
  twelveLabsKey?: string;
  nvidiaKeys?: string;
} {
  const hosted = twelveLabsKey(config);
  const onDevice = nvidiaEmbeddingsKeys(config);
  return {
    ...(hosted ? { twelveLabsKey: hosted } : {}),
    // Always sent, never gated on the hosted key: the engine routes stills here.
    ...(onDevice ? { nvidiaKeys: onDevice } : {}),
  };
}

export interface EnsureProjectMediaUnderstandingInput {
  readonly project: Project;
  readonly config: AiConfig;
  readonly assetIds?: readonly string[];
  readonly refresh?: boolean;
  readonly signal?: AbortSignal;
  readonly client?: VisualIndexClient;
  readonly onEvent?: Parameters<typeof ensureMediaUnderstanding>[0]['onEvent'];
}

/**
 * Prepare semantic understanding on first need, reusing existing coverage and
 * joining duplicate in-flight requests. TwelveLabs is authoritative when its key
 * is configured; FramePilot never silently spends against or falls through to a
 * different hosted backend.
 */
export async function ensureProjectMediaUnderstanding(
  input: EnsureProjectMediaUnderstandingInput,
): Promise<EnsureMediaUnderstandingResult> {
  return ensureMediaUnderstanding({
    client: input.client ?? createVisualIndexClient(),
    projectId: input.project.id,
    project: input.project as unknown as Record<string, unknown>,
    ...(input.assetIds ? { assetIds: input.assetIds } : {}),
    ...understandingCredentials(input.config),
    ...(input.refresh ? { refresh: true } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onEvent ? { onEvent: input.onEvent } : {}),
  });
}

export interface FootageMapInput {
  /** The live WORKING project, so asset spans can project onto timeline time. */
  readonly project: Project;
  readonly config: AiConfig;
  /** Narrow the map to one asset; omit for the whole project. */
  readonly assetId?: string;
  /** Force a recompute past the cached map. */
  readonly refresh?: boolean;
  /** Return asset-native times rather than timeline projection. */
  readonly assetTime?: boolean;
  /** Overridable for tests; defaults to a client on the resolved sidecar URL. */
  readonly client?: VisualIndexClient;
}

/** Fetch the footage map, or `undefined` when the sidecar is unreachable. */
export async function fetchFootageMap(input: FootageMapInput): Promise<FootageMap | undefined> {
  const client = input.client ?? createVisualIndexClient();
  const tlKey = twelveLabsKey(input.config);
  log.action('footage-map → fetch', {
    projectId: input.project.id,
    ...(input.assetId ? { assetId: input.assetId } : {}),
    backend: tlKey ? 'twelvelabs' : 'builtin',
  });
  const map = await client.footageMap({
    projectId: input.project.id,
    project: input.project,
    ...(input.assetId ? { assetId: input.assetId } : {}),
    ...(input.refresh ? { refresh: true } : {}),
    ...(input.assetTime ? { assetTime: true } : {}),
    ...(tlKey ? { twelveLabsKey: tlKey } : {}),
  });
  log.action('footage-map → done', {
    projectId: input.project.id,
    available: map?.available ?? false,
    chapters: map?.chapters.length ?? 0,
  });
  return map;
}

/** Fetch the footage map and render its compact AI-context digest. */
export async function footageMapDigest(input: FootageMapInput): Promise<string | undefined> {
  const map = await fetchFootageMap(input);
  return summarizeFootageMap(map);
}
