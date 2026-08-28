/**
 * Media-understanding host glue.
 *
 * The editor owns credentials and the sidecar owns media processing. Imported
 * media may be warmed in the background, while semantic tools can call
 * {@link ensureProjectMediaUnderstanding} to prepare unchanged media implicitly.
 * Users and models never need to manage an index as a separate workflow.
 */
import { createLogger } from '@framepilot/shared-types';
import type { AiConfig } from '@framepilot/shared-types';
import {
  ensureMediaUnderstanding,
  type EnsureMediaUnderstandingResult,
  type FootageMap,
  VisualIndexClient,
  runVisualIndexLoop,
  summarizeFootageMap,
  type VisualIndexLoopResult,
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

/**
 * Background warming is automatic whenever a media-understanding backend is
 * configured. The old `embeddingsAutoIndex` preference is migration-only and is
 * intentionally ignored: semantic tools also prepare media lazily on first need.
 */
export function shouldAutoIndex(config: AiConfig): boolean {
  return nvidiaEmbeddingsKeys(config) !== undefined || twelveLabsKey(config) !== undefined;
}

export interface AutoIndexInput {
  readonly projectId: string;
  /** The just-imported asset ids (the worklist for this run). */
  readonly assetIds: readonly string[];
  readonly config: AiConfig;
  /** Overridable for tests; defaults to a client on the resolved sidecar URL. */
  readonly client?: VisualIndexClient;
}

/**
 * Warm freshly imported assets in the background. This is an optimization only:
 * import and preview never wait for it, and semantic tools still call the ensure
 * gate before querying so cancelled or offline warming cannot create stale assumptions.
 */
export async function autoIndexImportedAssets(
  input: AutoIndexInput,
): Promise<VisualIndexLoopResult | undefined> {
  if (input.assetIds.length === 0 || !shouldAutoIndex(input.config)) return undefined;
  const nvidiaKeys = nvidiaEmbeddingsKeys(input.config);
  const tlKey = twelveLabsKey(input.config);
  if (!nvidiaKeys && !tlKey) return undefined;

  const client = input.client ?? createVisualIndexClient();
  log.action('media warmup → start', {
    projectId: input.projectId,
    assetCount: input.assetIds.length,
    backend: tlKey ? 'twelvelabs' : 'builtin',
  });
  const result = await runVisualIndexLoop({
    client,
    request: {
      projectId: input.projectId,
      assetIds: input.assetIds,
      ...understandingCredentials(input.config),
    },
  });
  log.action('media warmup → done', {
    projectId: input.projectId,
    status: result.status,
    indexed: result.last?.indexed ?? 0,
  });
  return result;
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
