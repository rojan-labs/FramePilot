/**
 * FramePilot settings dialog.
 *
 * Preferences remain local view state. AI configuration is split into chat
 * providers, speech-to-text, and automatic media intelligence. Indexing is not a
 * user workflow: semantic features prepare unchanged media in the background or
 * on first need, then reuse it.
 */
import { lastProviderSuccess } from '../editor/providerHealth.js';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { Button, SegmentedControl, Switch } from '@framepilot/ui';
import type {
  AiProviderInfo,
  AiProviderName,
  CapabilityPackInstallProposalWire,
  CapabilityPackProgressWire,
} from '@framepilot/shared-types';
import {
  capabilitiesFor,
  LocalWhisperCliClient,
  type LocalAsrSetupProgress,
  type LocalAsrStatus,
  type UserAsrProviderName,
  type UserPreferenceKey,
  runVisualIndexLoop,
  type VisualStatusResponse,
} from '@framepilot/ai-sdk';
import {
  type Density,
  type Theme,
  MAX_RUN_MINUTES,
  MAX_RUN_USD,
  MIN_RUN_MINUTES,
  MIN_RUN_USD,
  OVERLAY_SECONDS_BOUNDS,
  RUN_USD_STEP,
  useSettings,
} from '../editor/useSettings.js';
import type { TimeDisplay } from '../editor/selectors.js';
import { resolveEngineBaseUrl } from '../editor/ai.js';
import {
  createVisualIndexClient,
  nvidiaEmbeddingsKeys,
  twelveLabsKey,
  understandingCredentials,
} from '../editor/visualIndex.js';
import { useAiConfig } from '../editor/useAiConfig.js';
import { onStockQuotaChanged, stockQuota, type StockQuotaSnapshot } from '../editor/bridge.js';
import { useUserMemory } from '../editor/useUserMemory.js';
import {
  BASE_URL_PROVIDERS,
  KEYLESS_PROVIDERS,
  URL_REQUIRED_PROVIDERS,
  REAL_PROVIDERS,
} from '../editor/aiConfigStorage.js';
import { Select } from './Select.js';
import { ShortcutList } from './ShortcutList.js';
import {
  BookOpen,
  ChevronDown,
  ICON_SIZE,
  Keyboard,
  HardDrive,
  Receipt,
  Monitor,
  Play,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  X,
  type LucideIcon,
} from './icons.js';
import { useModalFocusTrap } from './ai/useModalFocusTrap.js';
import { CapabilityPackStorageSettings } from './CapabilityPackStorageSettings.js';
import { UsageAndSpend } from './UsageAndSpend.js';
import { getBridge } from '../editor/bridge.js';

export type SettingsSection =
  | 'display'
  | 'editing'
  | 'playback'
  | 'ai'
  | 'usage'
  | 'storage'
  | 'memory'
  | 'shortcuts';

export interface SettingsDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly initialSection?: SettingsSection;
  readonly projectId?: string;
}

type Section = SettingsSection;

interface SectionMeta {
  readonly id: Section;
  readonly label: string;
  readonly group: 'Workspace' | 'Intelligence' | 'Reference';
  readonly icon: LucideIcon;
  readonly description: string;
}

const SECTIONS: readonly SectionMeta[] = [
  {
    id: 'display',
    label: 'Display',
    group: 'Workspace',
    icon: Monitor,
    description: 'Theme, time and density',
  },
  {
    id: 'editing',
    label: 'Editing',
    group: 'Workspace',
    icon: SlidersHorizontal,
    description: 'Timeline behavior and defaults',
  },
  {
    id: 'playback',
    label: 'Playback',
    group: 'Workspace',
    icon: Play,
    description: 'Monitor, guides and performance',
  },
  {
    id: 'ai',
    label: 'AI',
    group: 'Intelligence',
    icon: Sparkles,
    description: 'Providers and media intelligence',
  },
  {
    id: 'usage',
    label: 'Usage & Spend',
    group: 'Intelligence',
    icon: Receipt,
    description: 'What your AI edits cost, and where it went',
  },
  {
    id: 'memory',
    label: 'Memory',
    group: 'Intelligence',
    icon: BookOpen,
    description: 'What FramePilot remembers about how you edit',
  },
  {
    id: 'storage',
    label: 'Storage',
    group: 'Intelligence',
    icon: HardDrive,
    description: 'On-demand models and workers',
  },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    group: 'Reference',
    icon: Keyboard,
    description: 'Find every keyboard command',
  },
];

function SettingGroup({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <section className="settings-group" aria-label={title}>
      <header className="settings-group-head">
        <h4>{title}</h4>
        <p>{description}</p>
      </header>
      <div className="settings-group-controls">{children}</div>
    </section>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
}): JSX.Element {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <span className="setting-label">{label}</span>
        {hint ? <span className="setting-hint">{hint}</span> : null}
      </div>
      <Switch checked={checked} label={label} onCheckedChange={onChange} size="md" />
    </div>
  );
}

function Segmented<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
  className,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly value: T;
  readonly options: readonly { value: T; label: string }[];
  readonly onChange: (next: T) => void;
  readonly className?: string;
}): JSX.Element {
  return (
    <div className={`setting-row${className ? ` ${className}` : ''}`}>
      <div className="setting-text">
        <span className="setting-label">{label}</span>
        {hint ? <span className="setting-hint">{hint}</span> : null}
      </div>
      <SegmentedControl label={label} value={value} options={options} onValueChange={onChange} />
    </div>
  );
}

/** Example endpoint per provider, so the field shows the shape it expects. */
const BASE_URL_PLACEHOLDER: Partial<Record<AiProviderName, string>> = {
  ollama: 'http://localhost:11434/v1',
  'openai-compatible': 'http://127.0.0.1:8000/v1',
};

/**
 * Providers whose credential is a login the user already has, not a key they paste.
 *
 * These need no API-key field at all, and showing one is worse than showing nothing: it
 * invites the user to hunt for a credential that does not exist for this provider, and a
 * key typed into it would be stored and never sent anywhere.
 */
const LOGIN_PROVIDERS: readonly AiProviderName[] = ['claude-agent-sdk'];

function providerStatus(
  info: AiProviderInfo | undefined,
  keyOptional: boolean,
  urlRequired: boolean,
  signsInSeparately = false,
): {
  readonly text: string;
  readonly ready: boolean;
} {
  const ready = info?.ready === true;
  // Neither "Key saved" nor "No key" is true of a provider that signs in elsewhere.
  // Whether the login is actually valid is not knowable from here without reading the OS
  // keychain, so this states the arrangement rather than claiming a verdict.
  if (signsInSeparately) return { text: 'Uses your Claude Code login', ready };
  // What is missing differs by provider, and "No key" would be actively misleading on
  // one that needs no key — it would send the user looking for a credential when the
  // server URL is the empty field.
  if (urlRequired) return { text: ready ? 'Ready' : 'No server URL', ready };
  return { text: ready ? (keyOptional ? 'Ready' : 'Key saved') : 'No key', ready };
}

/** `128000` → `128K`, matching the context meter's own compaction of the same figure. */
function compactTokens(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  const scaled = value / 1_000;
  if (scaled >= 1_000) return `${Math.round(scaled / 100) / 10}M`;
  return `${scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10}K`;
}

/**
 * Mirrors `normalizeModelId` in `@framepilot/ai-sdk`'s `model-capabilities.ts` (not
 * exported): lower-case, drop a `:tag` suffix, drop the `vendor/` prefix. Kept in step
 * with that helper so `openrouter/auto`, `auto` and `auto:free` are one id here too.
 */
function normalizedModelId(model: string): string {
  const withoutTag = model.trim().toLowerCase().split(':')[0] ?? '';
  return (withoutTag.split('/').at(-1) ?? '').trim();
}

/** Providers that will pick the underlying model for you, and so lose the prompt cache. */
const AUTO_ROUTING_PROVIDERS: readonly AiProviderName[] = ['openrouter', 'vercel-gateway'];

function ProviderKeyField({
  name,
}: {
  readonly name: Exclude<AiProviderName, 'mock'>;
}): JSX.Element {
  const { config, setKey, setModel, setBaseUrl } = useAiConfig();
  const info = config.providers.find((provider) => provider.name === name);
  const [keyDraft, setKeyDraft] = useState('');
  const showBaseUrl = BASE_URL_PROVIDERS.includes(name);
  const keyOptional = KEYLESS_PROVIDERS.includes(name);
  const signsInSeparately = LOGIN_PROVIDERS.includes(name);

  const saveKey = (): void => {
    const value = keyDraft.trim();
    if (!value) return;
    setKey(name, value);
    setKeyDraft('');
  };

  // An unknown id is not a validation error — it still saves as typed, because the
  // capability table is a cache and a genuinely new model must remain usable. It is a
  // cost the user should meet here rather than discover mid-run in the context meter.
  const modelDraft = info?.model ?? '';
  const capabilities = capabilitiesFor(name, modelDraft);
  const unknownModelHint =
    modelDraft.trim() && capabilities.source === 'provider_default'
      ? `Not a model this app knows — context capacity will be assumed at ${compactTokens(
          capabilities.contextWindow,
        )} tokens and the run budget cannot be sized to it. Pick an id from the provider's model list to fix that.`
      : undefined;
  const autoRoutingHint =
    normalizedModelId(modelDraft) === 'auto' && AUTO_ROUTING_PROVIDERS.includes(name)
      ? 'Auto-routing picks a different model for every request, and each model keeps its own prompt cache, so most of the prompt is re-sent and re-billed on every switch. Pin one model to keep the cache.'
      : undefined;

  return (
    <>
      {showBaseUrl ? (
        <div className="setting-row setting-row--stack">
          <label className="setting-field-label" htmlFor={`ai-url-${name}`}>
            Server URL
          </label>
          <input
            id={`ai-url-${name}`}
            type="text"
            className="setting-text-input"
            spellCheck={false}
            placeholder={BASE_URL_PLACEHOLDER[name] ?? 'https://example.com/v1'}
            value={info?.baseUrl ?? ''}
            onChange={(event) => setBaseUrl(name, event.target.value)}
          />
        </div>
      ) : null}
      {signsInSeparately ? (
        <div className="setting-row setting-row--stack">
          <span className="setting-hint" role="note">
            No API key needed. This provider spends your Claude subscription through the login the
            Claude CLI already stored. If a run stops and says it is not signed in, run{' '}
            <code>claude login</code> in a terminal and start it again. Desktop only — it starts the{' '}
            <code>claude</code> program, which a browser tab cannot do.
          </span>
        </div>
      ) : (
        <div className="setting-row setting-row--stack">
          <label className="setting-field-label" htmlFor={`ai-key-${name}`}>
            {keyOptional ? 'API key (optional)' : 'API key'}
          </label>
          <div className="setting-key-row">
            <input
              id={`ai-key-${name}`}
              type="password"
              className="setting-text-input"
              autoComplete="off"
              spellCheck={false}
              placeholder={info?.ready && !keyOptional ? 'Saved, type to replace' : 'Paste API key'}
              value={keyDraft}
              onChange={(event) => setKeyDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') saveKey();
              }}
            />
            <Button variant="secondary" type="button" disabled={!keyDraft.trim()} onClick={saveKey}>
              Save
            </Button>
            {info?.ready && !keyOptional ? (
              <Button variant="ghost" type="button" onClick={() => setKey(name, null)}>
                Clear
              </Button>
            ) : null}
          </div>
        </div>
      )}
      <div className="setting-row setting-row--stack">
        <label className="setting-field-label" htmlFor={`ai-model-${name}`}>
          Model
        </label>
        <input
          id={`ai-model-${name}`}
          type="text"
          className="setting-text-input"
          spellCheck={false}
          value={info?.model ?? ''}
          onChange={(event) => setModel(name, event.target.value)}
        />
        {unknownModelHint ? <span className="setting-hint">{unknownModelHint}</span> : null}
        {autoRoutingHint ? (
          <span className="setting-hint" role="note">
            {autoRoutingHint}
          </span>
        ) : null}
      </div>
    </>
  );
}

function ProviderAccordion({
  name,
  expanded,
  onToggle,
}: {
  readonly name: Exclude<AiProviderName, 'mock'>;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}): JSX.Element {
  const { config } = useAiConfig();
  const info = config.providers.find((provider) => provider.name === name);
  const label = info?.label ?? name;
  const status = providerStatus(
    info,
    KEYLESS_PROVIDERS.includes(name),
    URL_REQUIRED_PROVIDERS.includes(name),
    LOGIN_PROVIDERS.includes(name),
  );
  const [everExpanded, setEverExpanded] = useState(expanded);
  useEffect(() => {
    if (expanded) setEverExpanded(true);
  }, [expanded]);

  return (
    <div className="setting-provider">
      <button
        type="button"
        className="setting-provider-toggle"
        aria-expanded={expanded}
        aria-label={`${label} settings`}
        onClick={onToggle}
      >
        <span className="setting-label">{label}</span>
        {name === 'ollama' ? (
          <span className="setting-hint">Offline · no network required</span>
        ) : null}
        <span className="setting-provider-state" data-ready={status.ready}>
          {status.text}
        </span>
        <ChevronDown size={ICON_SIZE.sm} aria-hidden="true" className="setting-provider-chevron" />
      </button>
      {everExpanded ? (
        <div className="setting-provider-body" data-expanded={expanded}>
          <div className="setting-provider-body-inner">
            <ProviderKeyField name={name} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export const ASR_SETUP_DOCS_URL = 'https://framepilot.app/docs/local-transcription-setup';
const ASR_SETUP_POLL_MS = 400;

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function LocalAsrSetup(): JSX.Element {
  const bridge = getBridge();
  const client = useMemo(() => new LocalWhisperCliClient(resolveEngineBaseUrl()), []);
  const [status, setStatus] = useState<LocalAsrStatus | 'loading' | 'error'>('loading');
  const [settingUp, setSettingUp] = useState(false);
  const [progress, setProgress] = useState<LocalAsrSetupProgress | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [packProposal, setPackProposal] = useState<CapabilityPackInstallProposalWire | null>(null);
  const [packOperationId, setPackOperationId] = useState<string | null>(null);
  const [packProgress, setPackProgress] = useState<CapabilityPackProgressWire | null>(null);
  const cancelled = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    setStatus('loading');
    try {
      setStatus(await client.status());
    } catch {
      setStatus('error');
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    // Adopt a download the engine is already running. Setup outlives this dialog, so
    // without this a user who closes and reopens Settings mid-download sees a "Set up"
    // button and no progress — and pressing it again is the only way to learn it was
    // already working.
    void client
      .setupProgress()
      .then((current) => {
        if (current.state !== 'downloading') return;
        setProgress(current);
        setSettingUp(true);
      })
      .catch(() => undefined);
  }, [client, refresh]);

  useEffect(() => {
    if (!bridge?.onCapabilityPackProgress) return;
    return bridge.onCapabilityPackProgress((next) => {
      if (packOperationId !== null && next.operationId !== packOperationId) return;
      setPackProgress(next);
      if (next.phase === 'installed') {
        setPackOperationId(null);
        setPackProposal(null);
        setSettingUp(false);
        window.setTimeout(() => void refresh(), 250);
      } else if (next.phase === 'failed' || next.phase === 'cancelled') {
        setSettingUp(false);
        if (next.detail) setMessage(next.detail);
      }
    });
  }, [bridge, packOperationId, refresh]);

  useEffect(() => {
    if (!settingUp) return;
    const timer = window.setInterval(() => {
      void client
        .setupProgress()
        .then(setProgress)
        .catch(() => undefined);
    }, ASR_SETUP_POLL_MS);
    return () => window.clearInterval(timer);
  }, [client, settingUp]);

  const setUp = async (): Promise<void> => {
    if (bridge?.capabilityPackPropose) {
      setMessage(null);
      const result = await bridge.capabilityPackPropose('asr.whisper.local');
      if (!result.ok) setMessage(result.error);
      else setPackProposal(result.proposal);
      return;
    }
    if (typeof status === 'object' && !status.binaryAvailable) {
      setMessage('Install whisper-cli first, then return here to download the local model.');
      return;
    }
    setMessage(null);
    cancelled.current = false;
    setSettingUp(true);
    try {
      await client.setup();
      await refresh();
    } catch (error) {
      // A cancelled setup rejects too. Reporting that rejection would replace the
      // user's own "cancelled" outcome with an engine error they did not cause.
      if (!cancelled.current) setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSettingUp(false);
    }
  };

  const approvePack = async (): Promise<void> => {
    if (!bridge?.capabilityPackInstall || packProposal === null) return;
    setSettingUp(true);
    setMessage(null);
    const result = await bridge.capabilityPackInstall({
      proposalId: packProposal.proposalId,
      identity: packProposal.identity,
      approvedSizeBytes: packProposal.downloadBytes,
      approvedLicenseSpdx: packProposal.licenses.map(({ spdx }) => spdx),
      approvedMediaEgress: packProposal.privacy.mediaLeavesDevice,
      approvedAt: new Date().toISOString(),
    });
    if (!result.ok) {
      setMessage(result.error);
      setSettingUp(false);
    } else {
      setPackOperationId(result.operationId);
    }
  };

  const cancel = async (): Promise<void> => {
    if (packOperationId !== null && bridge?.capabilityPackCancel) {
      bridge.capabilityPackCancel(packOperationId);
      return;
    }
    cancelled.current = true;
    try {
      setProgress(await client.cancelSetup());
      // Say what the cancel left behind. Silence here reads as "it finished".
      setMessage(`Setup cancelled — the local model was not installed.`);
    } finally {
      setSettingUp(false);
    }
  };

  const ready = typeof status === 'object';
  const installed = ready && status.modelPresent;
  const total = progress?.totalBytes ?? null;
  const displayedTotal = packProgress?.totalBytes ?? total;
  const downloaded = packProgress?.completedBytes ?? progress?.downloadedBytes ?? 0;
  const percent =
    displayedTotal && displayedTotal > 0
      ? Math.min(100, Math.round((downloaded / displayedTotal) * 100))
      : null;
  const hint =
    status === 'loading'
      ? 'Checking the local engine…'
      : status === 'error'
        ? 'The local engine is unreachable.'
        : !status.binaryAvailable
          ? 'whisper-cli is not installed.'
          : status.modelPresent
            ? `Model “${status.model}” is installed and ready.`
            : `One-time ${formatMegabytes(status.downloadSizeBytes)} model download required.`;

  return (
    <>
      <div className="setting-row">
        <div className="setting-text">
          <span className="setting-label">Local model</span>
          <span className="setting-hint">{hint}</span>
        </div>
        {settingUp ? (
          <Button variant="ghost" type="button" onClick={() => void cancel()}>
            Cancel
          </Button>
        ) : (
          <Button
            variant="secondary"
            type="button"
            disabled={status === 'loading' || installed}
            onClick={() => void setUp()}
          >
            Set up
          </Button>
        )}
      </div>
      {packProposal !== null && packOperationId === null ? (
        <div
          className="capability-cleanup-review"
          role="region"
          aria-label="Local transcription download approval"
        >
          <strong>
            {packProposal.displayName} · {formatMegabytes(packProposal.downloadBytes)}
          </strong>
          <span>{packProposal.description}</span>
          <span>
            Installed size {formatMegabytes(packProposal.installedBytes)} · Licenses{' '}
            {packProposal.licenses.map(({ spdx }) => spdx).join(', ')}
          </span>
          <span>{packProposal.privacy.disclosure}</span>
          <Button type="button" disabled={settingUp} onClick={() => void approvePack()}>
            Approve exact version and download
          </Button>
        </div>
      ) : null}
      {settingUp ? (
        <div className="setting-row setting-row--stack">
          <div className="ai-progress-label">
            <span>
              {percent === null
                ? 'Preparing local model…'
                : `Downloading local model · ${percent}%`}
            </span>
          </div>
          <div
            className={`ai-progress-track ${percent === null ? 'ai-progress-track--indeterminate' : ''}`}
            role="progressbar"
            aria-label="Local transcription model setup"
            {...(percent === null
              ? {}
              : { 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100 })}
          >
            <div
              className="ai-progress-fill"
              style={percent === null ? undefined : { width: `${percent}%` }}
            />
          </div>
        </div>
      ) : null}
      {message ? (
        <p className="setting-hint setting-note" role="alert">
          {message}{' '}
          <a href={ASR_SETUP_DOCS_URL} target="_blank" rel="noopener noreferrer">
            Open setup guide
          </a>
        </p>
      ) : null}
    </>
  );
}

function AsrSettings(): JSX.Element {
  const { settings, update } = useSettings();
  const { config, setAsrProvider, setTwelveLabs } = useAiConfig();

  return (
    <SettingGroup
      title="Speech-to-text"
      description="Choose local transcription or TwelveLabs native indexed transcription."
    >
      <Segmented<UserAsrProviderName>
        className="setting-row--asr-provider"
        label="Provider"
        hint="Local stays on this device. TwelveLabs sends selected media to its hosted service and may use provider credits."
        value={settings.asrProvider}
        options={[
          { value: 'whisper-cli', label: 'Local' },
          { value: 'twelvelabs', label: 'TwelveLabs' },
        ]}
        onChange={(asrProvider) => {
          update({ asrProvider });
          setAsrProvider(asrProvider);
        }}
      />
      {settings.asrProvider === 'twelvelabs' ? (
        <>
          <div className="setting-row setting-row--stack">
            <label className="setting-field-label" htmlFor="asr-twelvelabs-key">
              TwelveLabs API key
            </label>
            <input
              id="asr-twelvelabs-key"
              type="password"
              className="setting-text-input"
              autoComplete="off"
              spellCheck={false}
              placeholder="tlk_…"
              value={config.twelveLabs ?? ''}
              onChange={(event) => setTwelveLabs(event.target.value || null)}
            />
          </div>
          <p className="setting-hint setting-note">
            The same key powers transcription and semantic footage understanding. Completed results
            are reused for unchanged media.
          </p>
        </>
      ) : (
        <LocalAsrSetup />
      )}
      <Segmented<'on-demand' | 'on-import'>
        label="Transcription"
        hint="On demand runs only when a transcript-dependent feature needs it. Automatic on import warms new media in the background."
        value={settings.transcribeOnImport ? 'on-import' : 'on-demand'}
        options={[
          { value: 'on-demand', label: 'On demand' },
          { value: 'on-import', label: 'On import' },
        ]}
        onChange={(mode) => update({ transcribeOnImport: mode === 'on-import' })}
      />
    </SettingGroup>
  );
}

type MediaStatusState = VisualStatusResponse | 'loading' | 'error' | 'no-project';

/** How many failing assets to name inline before collapsing to a count. */
const MAX_LISTED_FAILURES = 3;

type CoverageTone = 'idle' | 'running' | 'completed' | 'warning';

/** What the panel can offer to do about the state it is showing. */
type CoverageRecovery = 'retry' | 'retry-failed' | 'fix-key' | undefined;

interface CoverageView {
  readonly statusText: string;
  readonly tone: CoverageTone;
  readonly recovery: CoverageRecovery;
  /** Assets to name under the row, when there is something to name. */
  readonly failures: VisualStatusResponse['failures'];
}

/**
 * A preparation job is "stalled" once it has not advanced for this long while still
 * claiming to run. Generously above the engine's own per-slice polling budget (30s), so
 * a slow upload is never mistaken for a stuck one.
 */
const STALLED_AFTER_MS = 5 * 60 * 1000;

/**
 * Turn a `/brain/visual/status` reading into an honest badge, sentence, and offer.
 *
 * ## Why this is not `indexed < total ? 'running' : 'completed'`
 *
 * That is what it used to be, and it is how the reported defect stayed invisible:
 * a preparation job that had already given up — three retries, every one stopped by the
 * same provider error — rendered as a blue "running" badge reading
 * `0/61 assets prepared · 0%`, forever. Nothing said the work had stopped, why, or what
 * to do about it. The badge follows the JOB's own state now, a stopped job shows its
 * reason, and the states that a person can act on offer the action.
 *
 * ## Why "retry" is not an "Index now" button
 *
 * The product's contract is that there is no manual indexing step, and an e2e test holds
 * that line. Recovery is therefore always framed as recovery from a NAMED failure — it
 * appears only when something actually failed or stalled, it says what it will retry, and
 * it disappears the moment there is nothing to retry.
 */
function describeCoverage(status: VisualStatusResponse, now: number): CoverageView {
  const none: CoverageView['failures'] = [];
  if (!status.available) {
    return {
      statusText: `Media understanding unavailable${status.reason ? `: ${status.reason}` : '.'}`,
      tone: 'warning',
      recovery: undefined,
      failures: none,
    };
  }
  const prepared = `${status.indexedAssets}/${status.totalAssets} assets prepared`;
  const failures = status.failures;
  const job = status.lastJob;

  if (job?.error === 'invalid_api_key') {
    return {
      statusText: 'That key was rejected. Media understanding is paused until it is replaced.',
      tone: 'warning',
      recovery: 'fix-key',
      failures: none,
    };
  }

  const finished = status.indexedAssets + failures.length >= status.totalAssets;
  if (status.totalAssets > 0 && failures.length > 0 && finished) {
    // Partial: preparation ran to the end of the worklist and some assets could not be
    // prepared. Silent before this — the reasons never left the sidecar's log.
    return {
      statusText: `${prepared}. ${failures.length} could not be prepared.`,
      tone: 'warning',
      recovery: 'retry-failed',
      failures,
    };
  }
  if (status.totalAssets > 0 && status.indexedAssets >= status.totalAssets) {
    return { statusText: `${prepared}.`, tone: 'completed', recovery: undefined, failures: none };
  }
  if (job && (job.state === 'failed' || job.state === 'interrupted')) {
    // `cancelled by user` is the engine's own wording for a deliberate stop; it is not a
    // fault, so it must not read like one.
    const cancelled = (job.error ?? '').includes('cancelled by user');
    return {
      statusText: cancelled
        ? `${prepared}. Preparation was cancelled — it resumes on the next semantic request.`
        : `${prepared}. Preparation stopped${job.error ? `: ${job.error}` : '.'}`,
      tone: cancelled ? 'idle' : 'warning',
      recovery: cancelled ? undefined : 'retry',
      failures,
    };
  }
  if (job?.state === 'running') {
    const idleMs = now - Date.parse(job.updatedAt);
    if (Number.isFinite(idleMs) && idleMs > STALLED_AFTER_MS) {
      // Claims to be running, but nothing has moved. The defect's exact shape, caught
      // even when the engine never got to mark the job failed.
      const since = new Date(job.updatedAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
      return {
        statusText: `${prepared}. Preparation has not advanced since ${since}.`,
        tone: 'warning',
        recovery: 'retry',
        failures,
      };
    }
    // Say what it is waiting on. A percentage alone cannot distinguish slow from broken.
    const waiting =
      status.backend === 'twelvelabs'
        ? `uploading to TwelveLabs (${job.cursor}/${job.total})`
        : `embedding frames (${job.cursor}/${job.total})`;
    return {
      statusText: `${prepared} · ${Math.round(job.progress * 100)}% — ${waiting}.`,
      tone: 'running',
      recovery: undefined,
      failures: none,
    };
  }
  if (status.totalAssets === 0) {
    return {
      statusText: 'No media to prepare yet.',
      tone: 'idle',
      recovery: undefined,
      failures: none,
    };
  }
  return {
    statusText: `${prepared}. Preparation starts on import or first semantic need.`,
    tone: 'idle',
    recovery: undefined,
    failures: none,
  };
}

function MediaIntelligenceSettings({ projectId }: { readonly projectId?: string }): JSX.Element {
  const { config, setTwelveLabs, setNvidiaEmbeddings } = useAiConfig();
  const client = useMemo(() => createVisualIndexClient(), []);
  const [status, setStatus] = useState<MediaStatusState>(projectId ? 'loading' : 'no-project');

  const refresh = useCallback(async (): Promise<void> => {
    if (!projectId) {
      setStatus('no-project');
      return;
    }
    const result = await client.status(projectId);
    setStatus(result ?? 'error');
  }, [client, projectId]);

  useEffect(() => {
    void refresh();
    if (!projectId) return;
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [projectId, refresh]);

  const [retrying, setRetrying] = useState(false);
  /**
   * Recover from a NAMED failure. Not an "Index now" button: preparation is automatic,
   * and this only ever appears next to a state that has already gone wrong. It starts a
   * fresh job over the whole worklist, and the assets that already succeeded are a cheap
   * no-op for it (`existing_visual_span_keys`), so retrying three failures does not
   * re-pay for the fifty-eight that worked.
   */
  const retry = useCallback(async (): Promise<void> => {
    if (!projectId || retrying) return;
    setRetrying(true);
    try {
      await runVisualIndexLoop({
        client,
        request: { projectId, ...understandingCredentials(config) },
      });
    } finally {
      setRetrying(false);
      await refresh();
    }
  }, [client, config, projectId, refresh, retrying]);

  // Two backends can be configured at once, and the engine resolves TwelveLabs FIRST
  // (`service.py` checks `resolve_twelvelabs` before `resolve_visual_embedder`), so the
  // badge has to name the one that will actually run rather than the one most recently
  // typed — otherwise a user with both keys reads "on-device" while media is leaving the
  // machine.
  const hostedKey = twelveLabsKey(config) !== undefined;
  const onDeviceKey = nvidiaEmbeddingsKeys(config) !== undefined;
  const keyConfigured = hostedKey || onDeviceKey;
  const activeBackend = hostedKey ? 'TwelveLabs' : onDeviceKey ? 'On-device' : undefined;
  let statusText = 'Open a project to see media-understanding coverage.';
  let tone: CoverageTone = 'idle';
  let recovery: CoverageRecovery;
  let failures: CoverageView['failures'] = [];
  if (status === 'loading') {
    statusText = 'Checking media understanding…';
    tone = 'running';
  } else if (status === 'error') {
    statusText =
      'The media engine is currently unreachable. Cached/local editing remains available.';
    tone = 'warning';
  } else if (typeof status === 'object') {
    ({ statusText, tone, recovery, failures } = describeCoverage(status, Date.now()));
  }

  return (
    <SettingGroup
      title="Media intelligence"
      description="Automatic semantic search, timestamp understanding, and footage mapping."
    >
      <div className="setting-row setting-row--stack">
        <label className="setting-field-label" htmlFor="ai-twelvelabs-key">
          TwelveLabs API key
        </label>
        <input
          id="ai-twelvelabs-key"
          type="password"
          className="setting-text-input"
          autoComplete="off"
          spellCheck={false}
          placeholder="tlk_…"
          value={config.twelveLabs ?? ''}
          onChange={(event) => setTwelveLabs(event.target.value || null)}
        />
        <span className="setting-hint">
          When configured, TwelveLabs is used for semantic footage understanding and native indexed
          transcription. Media may leave this device and provider credits may be used.
        </span>
      </div>
      <div className="setting-row setting-row--stack">
        <label className="setting-field-label" htmlFor="ai-nvidia-embeddings">
          On-device embeddings key
        </label>
        <input
          id="ai-nvidia-embeddings"
          type="password"
          className="setting-text-input"
          autoComplete="off"
          spellCheck={false}
          placeholder="nvapi-…"
          value={config.nvidiaEmbeddings ?? ''}
          onChange={(event) => setNvidiaEmbeddings(event.target.value || null)}
        />
        <span className="setting-hint">
          NVIDIA API key(s) for visual embeddings, comma-separated. Sampled frames are sent to
          NVIDIA to be embedded; your source files never leave this machine, and search runs here.
          Used when no TwelveLabs key is set, and always for still photos, which the hosted service
          cannot index. Extra keys share the work as well as covering for each other.
        </span>
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <span className="setting-label">Automatic preparation</span>
          <span className="setting-hint">
            FramePilot prepares media on import or first semantic need, joins duplicate requests,
            and reuses unchanged results. There is no manual indexing step.
          </span>
        </div>
        <span className="ai-tone" data-tone={keyConfigured ? 'completed' : 'idle'}>
          {activeBackend ? `${activeBackend} ready` : 'Local facts only'}
        </span>
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <span className="setting-label">Project coverage</span>
          <span className="setting-hint">{statusText}</span>
          {failures.length > 0 ? (
            // Named, not counted. "3 could not be prepared" is the difference between a
            // user who can go look at three files and one who can only re-run and hope.
            <span className="setting-hint">
              {failures
                .slice(0, MAX_LISTED_FAILURES)
                .map(
                  (failure) => `${failure.assetId}${failure.reason ? ` — ${failure.reason}` : ''}`,
                )
                .join(' · ')}
              {failures.length > MAX_LISTED_FAILURES
                ? ` · +${failures.length - MAX_LISTED_FAILURES} more`
                : ''}
            </span>
          ) : null}
        </div>
        <div className="setting-inline-actions">
          {recovery !== undefined ? (
            <Button
              type="button"
              data-variant="secondary"
              onClick={() => void retry()}
              disabled={retrying}
            >
              {retrying
                ? 'Retrying…'
                : recovery === 'retry-failed'
                  ? `Retry ${failures.length} failed`
                  : recovery === 'fix-key'
                    ? 'Replace key'
                    : 'Retry preparation'}
            </Button>
          ) : null}
          <span className="ai-tone" data-tone={tone}>
            {tone}
          </span>
        </div>
      </div>
      {hostedKey && onDeviceKey ? (
        <p className="setting-hint setting-note">
          Both keys are set. TwelveLabs takes priority for video and audio, so that footage is
          understood by the hosted service; still photos are always understood on-device, because
          TwelveLabs cannot index them. Clear the TwelveLabs key to keep everything on-device.
        </p>
      ) : null}
      {!keyConfigured ? (
        <p className="setting-hint setting-note">
          Deterministic inspection, timeline editing, frame rendering, local transcription, and
          cached results remain available without a media-understanding key.
        </p>
      ) : null}
    </SettingGroup>
  );
}

/**
 * Stock media — the Pexels key, and what is left of this month's allowance.
 *
 * ## Why the key field is not value-bound
 *
 * Every other key input in this dialog shows its saved value, because those keys
 * are renderer-readable by design: the renderer forwards them onward, to the
 * sidecar or the transcription path. Nothing forwards this one — main holds it
 * and main makes every request — so it is write-only, and there is no value to
 * bind. The affordance is "Configured / Replace / Clear" instead.
 *
 * ## Why the quota says "Monthly", and why it also says "as of"
 *
 * Pexels enforces ~200 requests/hour AND 20,000/month, but reports only the
 * monthly figure in its headers. A bar labelled just "quota" would therefore be
 * contradicted by the first 429 that arrives while it still reads 19,400 left.
 * And because the same key can be used elsewhere, these are last-observed
 * values, not live ones — so the panel says when it saw them
 * (`plan/3rd-party-sourcing/photo-video/PEXELS-API.md` §3).
 */
function StockMediaSettings(): JSX.Element {
  const { config, setPexelsApiKey } = useAiConfig();
  const [quota, setQuota] = useState<StockQuotaSnapshot>({ kind: 'no_key' });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    void stockQuota().then(setQuota);
    // Pushed on every observation rather than polled: there is no remote to
    // poll, and the quota only moves when we ourselves make a request.
    return onStockQuotaChanged(setQuota);
  }, []);

  const configured = config.pexelsReady === true;
  const showField = !configured || editing;

  const save = (): void => {
    const key = draft.trim();
    if (key === '') return;
    setPexelsApiKey(key);
    setDraft('');
    setEditing(false);
  };

  return (
    <SettingGroup
      title="Stock media"
      description="Search Pexels for photos and video without leaving the editor."
    >
      <div className="setting-row setting-row--stack">
        <label className="setting-field-label" htmlFor="stock-pexels-key">
          Pexels API key
        </label>
        {showField ? (
          <div className="setting-inline-actions">
            <input
              id="stock-pexels-key"
              type="password"
              className="setting-text-input"
              autoComplete="off"
              spellCheck={false}
              placeholder="563492ad…"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') save();
              }}
            />
            {/* Distinct accessible names: this panel already has a "Save" for
                provider keys, and two identically-named buttons on one screen
                are ambiguous to anyone navigating by name. */}
            <Button
              variant="ghost"
              type="button"
              aria-label="Save Pexels API key"
              disabled={draft.trim() === ''}
              onClick={save}
            >
              Save
            </Button>
            {configured ? (
              <Button
                variant="ghost"
                type="button"
                aria-label="Cancel replacing the Pexels API key"
                onClick={() => {
                  setEditing(false);
                  setDraft('');
                }}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="setting-inline-actions">
            <span className="ai-tone" data-tone="completed">
              Configured
            </span>
            <Button
              variant="ghost"
              type="button"
              aria-label="Replace the Pexels API key"
              onClick={() => setEditing(true)}
            >
              Replace
            </Button>
            <Button
              variant="ghost"
              type="button"
              aria-label="Clear the Pexels API key"
              onClick={() => {
                setPexelsApiKey(null);
                setDraft('');
                setEditing(false);
              }}
            >
              Clear
            </Button>
          </div>
        )}
        <span className="setting-hint">
          Free and instant from{' '}
          <a href="https://www.pexels.com/api/new/" target="_blank" rel="noopener noreferrer">
            pexels.com/api
          </a>
          . Only the words you search leave this machine; downloaded files are stored with the
          project. The key is kept by the app and never sent to the editor window.
        </span>
      </div>

      <StockQuotaReadout quota={quota} />
    </SettingGroup>
  );
}

/** The quota block. Four states, and each one says exactly what it knows. */
function StockQuotaReadout({ quota }: { readonly quota: StockQuotaSnapshot }): JSX.Element | null {
  if (quota.kind === 'no_key') return null;

  if (quota.kind === 'unmeasured') {
    return (
      <div className="setting-row">
        <div className="setting-text">
          <span className="setting-label">Monthly API quota</span>
          {/* Not a zero and not a guessed 20,000: we genuinely do not know yet,
              and a fabricated number here would be indistinguishable from a
              real reading. */}
          <span className="setting-hint">Not measured yet — search once to see your quota.</span>
        </div>
      </div>
    );
  }

  // Both arms carried `monthly`, so the ternary chose between two identical
  // expressions. The `unmeasured` case returned above, so this is simply it.
  const { monthly } = quota;
  const percent =
    monthly && monthly.limit > 0 ? Math.round((monthly.remaining / monthly.limit) * 100) : null;
  const low = percent !== null && percent <= 10;

  return (
    <>
      {monthly ? (
        <div className="setting-row setting-row--stack">
          <div className="setting-text">
            <span className="setting-label">Monthly API quota</span>
            <span className="setting-hint stock-quota-figures">
              {monthly.remaining.toLocaleString()} of {monthly.limit.toLocaleString()} requests left
            </span>
          </div>
          <div
            className="ai-progress-track"
            role="progressbar"
            aria-label="Monthly Pexels API quota remaining"
            aria-valuenow={percent ?? 0}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="ai-progress-fill"
              data-tone={low ? 'warning' : undefined}
              style={{ width: `${percent ?? 0}%` }}
            />
          </div>
          <span className="setting-hint">
            {/* Absolute so it is unambiguous across timezones, relative so it is
                readable at a glance. */}
            Resets {formatAbsolute(monthly.resetAt)} · {formatRelative(monthly.resetAt)}
          </span>
          <span className="setting-hint setting-note">
            As of {formatRelative(monthly.observedAt)}. The same key used elsewhere moves these
            numbers without this app hearing about it.
          </span>
        </div>
      ) : null}

      {quota.kind === 'hourly_limited' ? (
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-label">Hourly limit</span>
            {/* Its own line rather than a correction to the bar above: Pexels
                does not report the hourly window, so a healthy monthly figure
                and an hourly 429 are both true at the same time. */}
            <span className="setting-hint">
              Reached about {formatRelative(quota.since)}. Pexels allows roughly 200 requests an
              hour and does not report that window, so it is not shown above.
              {quota.retryAfterSeconds !== undefined
                ? ` Retry in about ${Math.ceil(quota.retryAfterSeconds / 60)} min.`
                : ''}
            </span>
          </div>
          <span className="ai-tone" data-tone="warning">
            limited
          </span>
        </div>
      ) : null}
    </>
  );
}

/** `1 Sep 2026, 00:00` in the viewer's own locale and timezone. */
function formatAbsolute(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return 'unknown';
  return when.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** `in 8 days` / `2 minutes ago`. Readable at a glance; the absolute form is exact. */
function formatRelative(iso: string): string {
  const when = Date.parse(iso);
  if (Number.isNaN(when)) return 'unknown';
  const deltaSeconds = Math.round((when - Date.now()) / 1000);
  const units: readonly [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 30],
    ['month', 12],
  ];
  let value = deltaSeconds;
  for (const [unit, step] of units) {
    if (Math.abs(value) < step) {
      return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(
        Math.round(value),
        unit,
      );
    }
    value /= step;
  }
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(
    Math.round(value),
    'year',
  );
}

function isRealProvider(name: AiProviderName): name is Exclude<AiProviderName, 'mock'> {
  return (REAL_PROVIDERS as readonly AiProviderName[]).includes(name);
}

/** Said in the dialog, in the words the run itself uses when it stops. */
const RUN_BUDGET_HINT =
  'The AI stops at the next step once a run reaches either limit, and tells you what it applied.';

/** Clamp a typed budget into range, falling back to `fallback` for anything that is not a
    finite number. Only a COMMITTED value goes through here, so a half-entered "1." never
    becomes the bound; and because a commit clamps, the store can safely distrust anything
    it later reads back out of range (see `mergeSettings`). */
function clampRunBudget(
  raw: string,
  fallback: number,
  min: number,
  max: number,
  integer: boolean,
): number {
  const text = raw.trim();
  // A number input reports '' for anything it cannot parse ("lots") as well as for an
  // emptied field. Both mean "no value entered" — `Number('')` is 0, which would silently
  // become the floor of the range instead of leaving the last real choice alone.
  if (text === '') return fallback;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return fallback;
  const clamped = Math.min(max, Math.max(min, parsed));
  return integer ? Math.round(clamped) : clamped;
}

/**
 * The run budget (goal.md Workstream D) — a preference, not a per-run announcement.
 *
 * It sits in Settings because it is set once and applies to every agent run; the SDK no
 * longer spends a transcript line restating it before each run. Typing is a draft so a
 * half-entered number never reaches the wire; blur and Enter commit it, clamped, through
 * the shared settings store — one key, every panel reading the same figure.
 */
function RunBudgetSettings(): JSX.Element {
  const { settings, update } = useSettings();
  const [usdDraft, setUsdDraft] = useState(() => String(settings.maxRunUsd));
  const [minutesDraft, setMinutesDraft] = useState(() => String(settings.maxRunMinutes));

  const commitUsd = (raw: string): void => {
    const next = clampRunBudget(raw, settings.maxRunUsd, MIN_RUN_USD, MAX_RUN_USD, false);
    setUsdDraft(String(next));
    update({ maxRunUsd: next });
  };
  const commitMinutes = (raw: string): void => {
    const next = clampRunBudget(
      raw,
      settings.maxRunMinutes,
      MIN_RUN_MINUTES,
      MAX_RUN_MINUTES,
      true,
    );
    setMinutesDraft(String(next));
    update({ maxRunMinutes: next });
  };

  return (
    <SettingGroup
      title="Run budget"
      description="Applied to every agent run, from the moment you save it."
    >
      <div className="setting-row">
        <div className="setting-text">
          <span className="setting-label">Stop a run after</span>
          <span className="setting-hint">{RUN_BUDGET_HINT}</span>
        </div>
        <div className="setting-budget">
          <span className="setting-budget-unit" aria-hidden="true">
            $
          </span>
          <input
            type="number"
            className="setting-number"
            inputMode="decimal"
            aria-label="Stop a run after, dollars"
            min={MIN_RUN_USD}
            max={MAX_RUN_USD}
            step={RUN_USD_STEP}
            value={usdDraft}
            data-testid="ai-max-usd"
            onChange={(event) => setUsdDraft(event.target.value)}
            onBlur={(event) => commitUsd(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
          <input
            type="number"
            className="setting-number"
            inputMode="numeric"
            aria-label="Stop a run after, minutes"
            min={MIN_RUN_MINUTES}
            max={MAX_RUN_MINUTES}
            step={1}
            value={minutesDraft}
            data-testid="ai-max-minutes"
            onChange={(event) => setMinutesDraft(event.target.value)}
            onBlur={(event) => commitMinutes(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
          <span className="setting-budget-unit" aria-hidden="true">
            min
          </span>
        </div>
      </div>
    </SettingGroup>
  );
}

function AiSettings({ projectId }: { readonly projectId?: string }): JSX.Element {
  const { config, setActiveProvider } = useAiConfig();
  const { settings, update } = useSettings();
  const defaultOpen = isRealProvider(config.activeProvider) ? config.activeProvider : 'anthropic';
  const [openProvider, setOpenProvider] = useState<AiProviderName | null>(defaultOpen);

  return (
    <>
      <SettingGroup title="AI provider" description="The reasoning model used by the AI sidebar.">
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-label">Active provider</span>
            <span className="setting-hint">
              Keys remain local and are sent only to the provider you select.
            </span>
          </div>
          <Select<AiProviderName>
            label="Active provider"
            value={config.activeProvider}
            options={[...config.providers]
              .sort((a, b) =>
                a.name === config.activeProvider ? -1 : b.name === config.activeProvider ? 1 : 0,
              )
              .map((provider) => ({ value: provider.name, label: provider.label }))}
            onChange={setActiveProvider}
          />
        </div>
        {[...REAL_PROVIDERS]
          .sort((a, b) => (a === config.activeProvider ? -1 : b === config.activeProvider ? 1 : 0))
          .map((name) => (
            <ProviderAccordion
              key={name}
              name={name}
              expanded={openProvider === name}
              onToggle={() => setOpenProvider((current) => (current === name ? null : name))}
            />
          ))}
      </SettingGroup>
      <RunBudgetSettings />
      <AsrSettings />
      <MediaIntelligenceSettings {...(projectId ? { projectId } : {})} />
      <StockMediaSettings />
      <SettingGroup title="Diagnostics" description="Optional details for development and QA.">
        <Toggle
          label="Show AI usage details"
          hint="Show token and estimated provider-cost details after a run."
          checked={settings.showAiUsageDetails}
          onChange={(showAiUsageDetails) => update({ showAiUsageDetails })}
        />
      </SettingGroup>
    </>
  );
}

function PreferenceField({
  label,
  hint,
  value,
  prefKey,
  onCommit,
}: {
  readonly label: string;
  readonly hint: string;
  readonly value: string;
  readonly prefKey: UserPreferenceKey;
  readonly onCommit: (key: UserPreferenceKey, value: string) => void;
}): JSX.Element {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <span className="setting-label">{label}</span>
        <span className="setting-hint">{hint}</span>
      </div>
      <input
        type="text"
        className="setting-text-input"
        aria-label={label}
        defaultValue={value}
        onBlur={(event) => onCommit(prefKey, event.target.value.trim())}
      />
    </div>
  );
}

function MemorySettings(): JSX.Element {
  const { userMemory, setPreference, setPlatforms } = useUserMemory();
  return (
    <>
      <SettingGroup
        title="Editing profile"
        description="Cross-project defaults the assistant can reuse."
      >
        <PreferenceField
          label="Target audience"
          hint="Who your videos are for."
          value={userMemory.targetAudience ?? ''}
          prefKey="targetAudience"
          onCommit={setPreference}
        />
        <PreferenceField
          label="Brand style"
          hint="The overall visual and editorial voice."
          value={userMemory.brandStyle ?? ''}
          prefKey="brandStyle"
          onCommit={setPreference}
        />
        <PreferenceField
          label="Caption style"
          hint="Your preferred caption treatment."
          value={userMemory.captionStyle ?? ''}
          prefKey="captionStyle"
          onCommit={setPreference}
        />
        <PreferenceField
          label="Preferred pacing"
          hint="How tight or relaxed edits should feel."
          value={userMemory.preferredPacing ?? ''}
          prefKey="preferredPacing"
          onCommit={setPreference}
        />
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-label">Favourite export platforms</span>
            <span className="setting-hint">Comma-separated, for example reels, shorts.</span>
          </div>
          <input
            type="text"
            className="setting-text-input"
            aria-label="Favourite export platforms"
            defaultValue={userMemory.favoriteExportPlatforms.join(', ')}
            onBlur={(event) =>
              setPlatforms(
                event.target.value
                  .split(',')
                  .map((item) => item.trim())
                  .filter(Boolean),
              )
            }
          />
        </div>
      </SettingGroup>
    </>
  );
}

export function SettingsDialog({
  open,
  onClose,
  initialSection,
  projectId,
}: SettingsDialogProps): JSX.Element | null {
  if (!open) return null;
  return (
    <SettingsDialogContent
      onClose={onClose}
      initialSection={initialSection ?? 'display'}
      {...(projectId ? { projectId } : {})}
    />
  );
}

function SettingsDialogContent({
  onClose,
  initialSection,
  projectId,
}: {
  readonly onClose: () => void;
  readonly initialSection: Section;
  readonly projectId?: string;
}): JSX.Element {
  const { settings, update, reset, persistenceError } = useSettings();
  const { config } = useAiConfig();
  const [section, setSection] = useState<Section>(initialSection);
  const dialogRef = useModalFocusTrap<HTMLDivElement>();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeProvider = config.providers.find(({ name }) => name === config.activeProvider);
  // Re-read on every open: a run in the sidebar can prove the provider between opens.
  const answeredAt = activeProvider ? lastProviderSuccess(activeProvider.name) : undefined;
  const providerTone = !activeProvider?.ready ? 'attention' : answeredAt ? 'ready' : 'idle';
  const providerReadinessText = !activeProvider?.ready
    ? 'Set up'
    : answeredAt
      ? activeProvider.label
      : `${activeProvider.label} · key saved`;
  const providerReadinessHint = !activeProvider?.ready
    ? 'No credential is stored for this provider yet.'
    : answeredAt
      ? `Last answered ${answeredAt.toLocaleString()}.`
      : 'A key is stored, but this provider has not answered a request on this device yet.';

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const moveTabFocus = (currentIndex: number, event: ReactKeyboardEvent): void => {
    let nextIndex = currentIndex;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight')
      nextIndex = (currentIndex + 1) % SECTIONS.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft')
      nextIndex = (currentIndex - 1 + SECTIONS.length) % SECTIONS.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = SECTIONS.length - 1;
    else return;
    event.preventDefault();
    const next = SECTIONS[nextIndex];
    if (next) setSection(next.id);
    tabRefs.current[nextIndex]?.focus();
  };

  return (
    <div className="overlay-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-head">
          <div className="settings-title-lockup">
            <span className="settings-kicker">Control room</span>
            <h2 id="settings-title">Settings</h2>
            <p>Tune the workspace and keep FramePilot ready.</p>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close"
            title="Close (Esc)"
            onClick={onClose}
          >
            <X size={ICON_SIZE.md} aria-hidden="true" />
          </button>
        </header>

        <div className="settings-body">
          <nav
            className="settings-nav"
            role="tablist"
            aria-label="Settings sections"
            aria-orientation="vertical"
          >
            <div className="settings-nav-scroll">
              {SECTIONS.map(({ id, label, description, icon: Icon, group }, index) => {
                const previousGroup = SECTIONS[index - 1]?.group;
                return (
                  <div key={id} className="settings-nav-entry" role="presentation">
                    {group !== previousGroup ? (
                      <span className="settings-nav-group" role="presentation">
                        {group}
                      </span>
                    ) : null}
                    <button
                      ref={(node) => {
                        tabRefs.current[index] = node;
                      }}
                      type="button"
                      role="tab"
                      aria-label={label}
                      aria-selected={section === id}
                      aria-controls={`settings-${id}`}
                      tabIndex={section === id ? 0 : -1}
                      className={section === id ? 'is-active' : ''}
                      onClick={() => setSection(id)}
                      onKeyDown={(event) => moveTabFocus(index, event)}
                    >
                      <Icon size={ICON_SIZE.md} aria-hidden="true" />
                      <span>
                        <strong>{label}</strong>
                        <small>{description}</small>
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
            <aside className="settings-readiness" aria-label="System readiness">
              <span className="settings-readiness-label">Readiness</span>
              <div>
                <i data-tone="ready" />
                <span>Preferences</span>
                <strong>Local</strong>
              </div>
              <div>
                {/* UX-11: a stored key is not a working provider. `ready` only means a
                    credential exists — the walkthrough caught this row reporting a
                    provider as ready while the configured key returned 410 on every
                    call. `ready` is now the floor, and the claim is only upgraded once
                    the provider has actually answered a run on this device. */}
                <i data-tone={providerTone} />
                <span>AI provider</span>
                <strong title={providerReadinessHint}>{providerReadinessText}</strong>
              </div>
              <div>
                <i data-tone={projectId ? 'ready' : 'idle'} />
                <span>Footage</span>
                <strong>{projectId ? 'Project open' : 'No project'}</strong>
              </div>
            </aside>
          </nav>

          <div className="settings-panel" id={`settings-${section}`} role="tabpanel">
            <div className={`settings-panel-content settings-panel-content--${section}`}>
              {section === 'display' ? (
                <SettingGroup
                  title="Appearance"
                  description="Match the edit suite to your room and working style."
                >
                  <Segmented<Theme>
                    label="Theme"
                    hint="Light, dark, or match your system."
                    value={settings.theme}
                    options={[
                      { value: 'system', label: 'System' },
                      { value: 'light', label: 'Light' },
                      { value: 'dark', label: 'Dark' },
                    ]}
                    onChange={(theme) => update({ theme })}
                  />
                  <Segmented<TimeDisplay>
                    label="Time display"
                    hint="How the monitor and ruler show time."
                    value={settings.timeDisplay}
                    options={[
                      { value: 'timecode', label: 'Timecode' },
                      { value: 'seconds', label: 'Seconds' },
                    ]}
                    onChange={(timeDisplay) => update({ timeDisplay })}
                  />
                  <Segmented<Density>
                    label="Interface density"
                    hint="Spacing of the editor chrome."
                    value={settings.density}
                    options={[
                      { value: 'comfortable', label: 'Comfortable' },
                      { value: 'compact', label: 'Compact' },
                    ]}
                    onChange={(density) => update({ density })}
                  />
                </SettingGroup>
              ) : null}

              {section === 'editing' ? (
                <>
                  <SettingGroup
                    title="Timeline behavior"
                    description="Defaults for moving through a cut and arranging clips."
                  >
                    <Toggle
                      label="Snap to edges"
                      hint="Magnetic snapping while dragging or trimming."
                      checked={settings.snapping}
                      onChange={(snapping) => update({ snapping })}
                    />
                    <Toggle
                      label="Show thumbnails on timeline"
                      hint="Draw frame previews on clips."
                      checked={settings.showTimelineThumbnails}
                      onChange={(showTimelineThumbnails) => update({ showTimelineThumbnails })}
                    />
                    <Toggle
                      label="Follow playhead"
                      hint="Keep the playhead visible during playback."
                      checked={settings.autoFollow}
                      onChange={(autoFollow) => update({ autoFollow })}
                    />
                    <Toggle
                      label="Open the Inspector when I click a clip"
                      hint="The right panel follows your selection. A running agent moves to a button above the timeline rather than being hidden."
                      checked={settings.openInspectorOnSelect}
                      onChange={(openInspectorOnSelect) => update({ openInspectorOnSelect })}
                    />
                  </SettingGroup>
                  <SettingGroup
                    title="New elements"
                    description="Starting values for content created in the editor."
                  >
                    <div className="setting-row">
                      <div className="setting-text">
                        <span className="setting-label">Default overlay duration</span>
                        <span className="setting-hint">
                          On-screen seconds for a new text overlay.
                        </span>
                      </div>
                      <input
                        type="number"
                        className="setting-number"
                        aria-label="Default overlay duration"
                        min={OVERLAY_SECONDS_BOUNDS.min}
                        max={OVERLAY_SECONDS_BOUNDS.max}
                        step={0.5}
                        value={settings.defaultOverlaySeconds}
                        onChange={(event) =>
                          update({ defaultOverlaySeconds: Number(event.target.value) })
                        }
                      />
                    </div>
                  </SettingGroup>
                </>
              ) : null}

              {section === 'playback' ? (
                <>
                  <SettingGroup
                    title="Monitor defaults"
                    description="Choose which review aids appear when a project opens."
                  >
                    <Toggle
                      label="Loop playback"
                      checked={settings.loopByDefault}
                      onChange={(loopByDefault) => update({ loopByDefault })}
                    />
                    <Toggle
                      label="Show composition grid"
                      checked={settings.gridByDefault}
                      onChange={(gridByDefault) => update({ gridByDefault })}
                    />
                    <Toggle
                      label="Show safe-area guides"
                      checked={settings.safeAreaGuidesByDefault}
                      onChange={(safeAreaGuidesByDefault) => update({ safeAreaGuidesByDefault })}
                    />
                  </SettingGroup>
                  <SettingGroup title="Comfort" description="Control interface motion.">
                    <Toggle
                      label="Reduce motion"
                      checked={settings.reducedMotion}
                      onChange={(reducedMotion) => update({ reducedMotion })}
                    />
                  </SettingGroup>
                </>
              ) : null}

              {section === 'ai' ? <AiSettings {...(projectId ? { projectId } : {})} /> : null}
              {section === 'usage' ? (
                <UsageAndSpend
                  trackHistory={settings.trackUsageHistory}
                  onTrackHistoryChange={(trackUsageHistory) => update({ trackUsageHistory })}
                  maxRunUsd={settings.maxRunUsd}
                  onOpenAiSettings={() => setSection('ai')}
                />
              ) : null}
              {section === 'storage' ? <CapabilityPackStorageSettings /> : null}
              {section === 'memory' ? <MemorySettings /> : null}
              {section === 'shortcuts' ? <ShortcutList /> : null}
            </div>
          </div>
        </div>

        <footer className="settings-foot">
          {persistenceError !== null ? (
            <span className="settings-foot-error" role="alert">
              Couldn&rsquo;t save your changes on this device — they were undone and apply to this
              session only.
            </span>
          ) : (
            <span>Changes save automatically on this device.</span>
          )}
          <Button variant="ghost" type="button" onClick={reset}>
            <RotateCcw size={ICON_SIZE.sm} aria-hidden="true" /> Reset to defaults
          </Button>
        </footer>
      </div>
    </div>
  );
}
