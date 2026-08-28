/**
 * FramePilot settings dialog.
 *
 * Preferences remain local view state. AI configuration is split into chat
 * providers, speech-to-text, and automatic media intelligence. Indexing is not a
 * user workflow: semantic features prepare unchanged media in the background or
 * on first need, then reuse it.
 */
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
  LocalWhisperCliClient,
  type LocalAsrSetupProgress,
  type LocalAsrStatus,
  type UserAsrProviderName,
  type UserPreferenceKey,
  type VisualStatusResponse,
} from '@framepilot/ai-sdk';
import {
  type Density,
  type Theme,
  OVERLAY_SECONDS_BOUNDS,
  useSettings,
} from '../editor/useSettings.js';
import type { TimeDisplay } from '../editor/selectors.js';
import { resolveEngineBaseUrl } from '../editor/ai.js';
import {
  createVisualIndexClient,
  nvidiaEmbeddingsKeys,
  twelveLabsKey,
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
import { getBridge } from '../editor/bridge.js';

export type SettingsSection =
  | 'display'
  | 'editing'
  | 'playback'
  | 'ai'
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

function providerStatus(
  info: AiProviderInfo | undefined,
  keyOptional: boolean,
  urlRequired: boolean,
): {
  readonly text: string;
  readonly ready: boolean;
} {
  const ready = info?.ready === true;
  // What is missing differs by provider, and "No key" would be actively misleading on
  // one that needs no key — it would send the user looking for a credential when the
  // server URL is the empty field.
  if (urlRequired) return { text: ready ? 'Ready' : 'No server URL', ready };
  return { text: ready ? (keyOptional ? 'Ready' : 'Key saved') : 'No key', ready };
}

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

  const saveKey = (): void => {
    const value = keyDraft.trim();
    if (!value) return;
    setKey(name, value);
    setKeyDraft('');
  };

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

type CoverageTone = 'idle' | 'running' | 'completed' | 'warning';

/**
 * Turn a `/brain/visual/status` reading into an honest badge + sentence.
 *
 * ## Why this is not `indexed < total ? 'running' : 'completed'`
 *
 * That is what it used to be, and it is how the reported defect stayed invisible:
 * a preparation job that had already given up — three retries, every one stopped
 * by the same provider error — rendered as a blue "running" badge reading
 * `0/61 assets prepared · 0%`, forever. Nothing on the panel said the work had
 * stopped, why, or what to do. So the badge now follows the JOB's own state, and
 * a stopped job shows its reason. `totalAssets === 0` is its own case too: an
 * empty project is idle, not perpetually mid-run.
 */
function describeCoverage(status: VisualStatusResponse): {
  statusText: string;
  tone: CoverageTone;
} {
  if (!status.available) {
    return {
      statusText: `Media understanding unavailable${status.reason ? `: ${status.reason}` : '.'}`,
      tone: 'warning',
    };
  }
  const prepared = `${status.indexedAssets}/${status.totalAssets} assets prepared`;
  if (status.totalAssets > 0 && status.indexedAssets >= status.totalAssets) {
    return { statusText: `${prepared}.`, tone: 'completed' };
  }
  const job = status.lastJob;
  if (job && (job.state === 'failed' || job.state === 'interrupted')) {
    // `cancelled by user` is the engine's own wording for a deliberate stop; it is
    // not a fault, so it must not read like one.
    const cancelled = (job.error ?? '').includes('cancelled by user');
    return {
      statusText: cancelled
        ? `${prepared}. Preparation was cancelled — it resumes on the next semantic request.`
        : `${prepared}. Preparation stopped${job.error ? `: ${job.error}` : '.'} It retries on the next semantic request.`,
      tone: cancelled ? 'idle' : 'warning',
    };
  }
  if (job?.state === 'running') {
    return { statusText: `${prepared} · ${Math.round(job.progress * 100)}%.`, tone: 'running' };
  }
  if (status.totalAssets === 0) {
    return { statusText: 'No media to prepare yet.', tone: 'idle' };
  }
  return {
    statusText: `${prepared}. Preparation starts on import or first semantic need.`,
    tone: 'idle',
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
  let tone: 'idle' | 'running' | 'completed' | 'warning' = 'idle';
  if (status === 'loading') {
    statusText = 'Checking media understanding…';
    tone = 'running';
  } else if (status === 'error') {
    statusText =
      'The media engine is currently unreachable. Cached/local editing remains available.';
    tone = 'warning';
  } else if (typeof status === 'object') {
    ({ statusText, tone } = describeCoverage(status));
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
          NVIDIA API key(s) for visual embeddings, comma-separated. Footage is indexed and searched
          on this machine — only the embedding request leaves it, never the media. Used when no
          TwelveLabs key is set, and always for still photos, which the hosted service cannot index.
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
        </div>
        <span className="ai-tone" data-tone={tone}>
          {tone}
        </span>
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
                <i data-tone={activeProvider?.ready ? 'ready' : 'attention'} />
                <span>AI provider</span>
                <strong>{activeProvider?.ready ? activeProvider.label : 'Set up'}</strong>
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
