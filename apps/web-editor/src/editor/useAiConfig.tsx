/**
 * AI configuration state (Settings → AI): the active provider plus, per provider,
 * the model id and whether an API key is saved. One source of truth shared by the
 * Settings dialog (which edits it) and the AI sidebar (which reads the active
 * provider to run with).
 *
 * Two backends, one hook: on desktop the config lives in the main process
 * (`ai-config.json`) and is read/written over IPC — **keys are write-only**, never
 * read back. In a plain browser the config (including keys, for the direct-SDK path)
 * lives in `localStorage` via {@link aiConfigStorage}. Both expose the identical
 * secret-free {@link AiConfig} to the UI, so the Settings panel is backend-agnostic.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  AiConfig,
  AiConfigUpdate,
  AiProviderName,
  AsrProviderName,
} from '@framepilot/shared-types';
import { DEFAULT_ASR_PROVIDER } from '@framepilot/ai-sdk';
import { getBridge } from './bridge.js';
import { useSettings } from './useSettings.js';
import {
  applyBrowserUpdate,
  loadBrowserAiConfig,
  toAiConfig as browserToAiConfig,
} from './aiConfigStorage.js';

/** The config value plus mutators exposed through the context. */
export interface AiConfigContextValue {
  readonly config: AiConfig;
  /** Switch the provider AI runs use by default. */
  readonly setActiveProvider: (name: AiProviderName) => void;
  /** Save (`string`) or clear (`null`) a provider's API key. */
  readonly setKey: (name: AiProviderName, key: string | null) => void;
  /** Set a provider's model id (empty string restores the default). */
  readonly setModel: (name: AiProviderName, model: string) => void;
  /** Set a provider's OpenAI-compatible base URL (empty/`null` reverts to default). */
  readonly setBaseUrl: (name: AiProviderName, baseUrl: string | null) => void;
  /**
   * Save (`string`) or clear (`null`/empty) the comma-separated NVIDIA
   * visual-embeddings key(s) — its own slot, not the chat `nvidia` key (D5).
   */
  readonly setNvidiaEmbeddings: (keys: string | null) => void;
  /**
   * Save (`string`) or clear (`null`/empty) the TwelveLabs media-understanding
   * key — its own slot, not a chat key. When set, indexing/search delegate to
   * TwelveLabs instead of the built-in pipeline.
   */
  readonly setTwelveLabs: (key: string | null) => void;
  /** Toggle background auto-indexing of imported media (default on — D3). */
  readonly setEmbeddingsAutoIndex: (enabled: boolean) => void;
  /** Select the configured provider used to caption indexed scenes. */
  readonly setVisualCaptionProvider: (provider: AiProviderName) => void;
  /**
   * Save (`string`) or clear (`null`/empty) the dedicated hosted speech-to-text
   * API key — its own slot, not a chat provider key (plan H0.1).
   */
  readonly setAsrApiKey: (key: string | null) => void;
  /**
   * Select the speech-to-text provider `transcribe` uses. Persisted to the desktop
   * AI config (not just renderer settings) so the AI agent honors the choice and can
   * route hosted providers off-device (plan H0.1).
   */
  readonly setAsrProvider: (provider: AsrProviderName) => void;
  /**
   * Save (`string`) or clear (`null`/empty) the model id passed to the hosted ASR
   * provider. Clearing reverts to the provider's built-in default.
   */
  readonly setAsrModel: (model: string | null) => void;
}

/**
 * The config a component sees before the async desktop load resolves. Read lazily
 * per mount (not once at module load) so a value written to localStorage after
 * import — e.g. the readable embeddings key slot — is visible when the UI opens.
 */
const loadInitialConfig = (): AiConfig => browserToAiConfig(loadBrowserAiConfig());

const AiConfigContext = createContext<AiConfigContextValue | null>(null);

export interface AiConfigProviderProps {
  readonly children: ReactNode;
}

/** Provide AI config to the tree, backed by IPC (desktop) or localStorage (browser). */
export function AiConfigProvider({ children }: AiConfigProviderProps): JSX.Element {
  const [config, setConfig] = useState<AiConfig>(loadInitialConfig);

  // Desktop: hydrate from the main-process store once on mount.
  useEffect(() => {
    const bridge = getBridge();
    if (!bridge || typeof bridge.aiConfigGet !== 'function') return;
    let cancelled = false;
    void bridge.aiConfigGet().then((next) => {
      if (!cancelled) setConfig(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const applyUpdate = useCallback((update: AiConfigUpdate): void => {
    const bridge = getBridge();
    if (bridge && typeof bridge.aiConfigSet === 'function') {
      void bridge.aiConfigSet(update).then(setConfig);
    } else {
      setConfig(browserToAiConfig(applyBrowserUpdate(update)));
    }
  }, []);

  // Keep the agent's ASR provider in lockstep with the renderer's Speech-to-text
  // choice. WHY: the provider selection historically lived only in renderer settings
  // (which only the manual Transcribe button read); the AI agent's `transcribe` reads
  // it from THIS config in the desktop main process. Reconcile them so an existing
  // selection — chosen before this config slot existed — reaches the agent path without
  // the user re-picking it, and so future changes stay in sync. Idempotent: only writes
  // on a real difference, and converges (the write updates `config.asrProvider`).
  const { settings } = useSettings();
  useEffect(() => {
    const desired = settings.asrProvider;
    const current = config.asrProvider ?? DEFAULT_ASR_PROVIDER;
    if (desired !== current) applyUpdate({ asrProvider: desired });
  }, [settings.asrProvider, config.asrProvider, applyUpdate]);

  const value = useMemo<AiConfigContextValue>(
    () => ({
      config,
      setActiveProvider: (name) => applyUpdate({ activeProvider: name }),
      setKey: (name, key) => applyUpdate({ keys: { [name]: key } }),
      setModel: (name, model) => applyUpdate({ models: { [name]: model } }),
      setBaseUrl: (name, baseUrl) => applyUpdate({ baseUrls: { [name]: baseUrl } }),
      setNvidiaEmbeddings: (keys) => applyUpdate({ nvidiaEmbeddings: keys }),
      setTwelveLabs: (key) => applyUpdate({ twelveLabs: key }),
      setEmbeddingsAutoIndex: (enabled) => applyUpdate({ embeddingsAutoIndex: enabled }),
      setVisualCaptionProvider: (visualCaptionProvider) => applyUpdate({ visualCaptionProvider }),
      setAsrApiKey: (key) => applyUpdate({ asrApiKey: key }),
      setAsrProvider: (asrProvider) => applyUpdate({ asrProvider }),
      setAsrModel: (model) => applyUpdate({ asrModel: model }),
    }),
    [config, applyUpdate],
  );

  return <AiConfigContext.Provider value={value}>{children}</AiConfigContext.Provider>;
}

/**
 * Read AI config. Outside a {@link AiConfigProvider} this falls back to a live
 * localStorage-backed value with working mutators, so a standalone component/test
 * still works.
 */
export function useAiConfig(): AiConfigContextValue {
  const context = useContext(AiConfigContext);
  const [standalone, setStandalone] = useState<AiConfig>(loadInitialConfig);
  const fallback = useMemo<AiConfigContextValue>(
    () => ({
      config: standalone,
      setActiveProvider: (name) =>
        setStandalone(browserToAiConfig(applyBrowserUpdate({ activeProvider: name }))),
      setKey: (name, key) =>
        setStandalone(browserToAiConfig(applyBrowserUpdate({ keys: { [name]: key } }))),
      setModel: (name, model) =>
        setStandalone(browserToAiConfig(applyBrowserUpdate({ models: { [name]: model } }))),
      setBaseUrl: (name, baseUrl) =>
        setStandalone(browserToAiConfig(applyBrowserUpdate({ baseUrls: { [name]: baseUrl } }))),
      setNvidiaEmbeddings: (keys) =>
        setStandalone(browserToAiConfig(applyBrowserUpdate({ nvidiaEmbeddings: keys }))),
      setTwelveLabs: (key) =>
        setStandalone(browserToAiConfig(applyBrowserUpdate({ twelveLabs: key }))),
      setEmbeddingsAutoIndex: (enabled) =>
        setStandalone(browserToAiConfig(applyBrowserUpdate({ embeddingsAutoIndex: enabled }))),
      setVisualCaptionProvider: (visualCaptionProvider) =>
        setStandalone(browserToAiConfig(applyBrowserUpdate({ visualCaptionProvider }))),
      setAsrApiKey: (key) =>
        setStandalone(browserToAiConfig(applyBrowserUpdate({ asrApiKey: key }))),
      setAsrProvider: (asrProvider) =>
        setStandalone(browserToAiConfig(applyBrowserUpdate({ asrProvider }))),
      setAsrModel: (model) =>
        setStandalone(browserToAiConfig(applyBrowserUpdate({ asrModel: model }))),
    }),
    [standalone],
  );
  return context ?? fallback;
}
