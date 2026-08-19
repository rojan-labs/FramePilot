/**
 * @framepilot/shared-types/ipc — the canonical desktop↔renderer IPC data contract.
 *
 * WHY this lives in shared-types and not in either app: the Electron main process
 * (`apps/desktop`) and the renderer (`apps/web-editor`) are independent deployables
 * and must not import each other. Before, the renderer (`editor/bridge.ts`) restated
 * these shapes by hand with no compile-time cross-check, so the two definitions
 * could silently drift. Hoisting the request/response shapes into a package both
 * apps depend on makes this the single source of truth — a drift now fails to
 * compile on one side (plan/PLAN.md Phase 8 hardening, ADR 0023).
 *
 * Only the *data shapes* live here. The channel-name registry (`IpcChannels`) is
 * a desktop concern and stays in `apps/desktop/electron/ipc/contract.ts`.
 *
 * The `project` field on transport types is `unknown` on purpose: it is validated
 * against the Zod schema at each boundary (AGENTS.md invariant 3), so this package
 * needs no dependency on `@framepilot/timeline-schema`.
 */

/** Lifecycle states of the Python render sidecar (mirrors PRD §9.2 split). */
export type SidecarPhase = 'stopped' | 'starting' | 'ready' | 'failed';

/** Status of the Python render sidecar, surfaced to the renderer for status UI. */
export interface SidecarStatus {
  phase: SidecarPhase;
  /** Base URL the main process uses to reach the engine (renderer never directly). */
  baseUrl: string | null;
  /** Human-readable detail when `phase === 'failed'`. */
  detail: string | null;
}

/** A recently-opened project entry persisted across sessions. */
export interface RecentProject {
  /** Absolute path to the `project.fp.json`. */
  path: string;
  /** Project display name captured at last open (for the recents menu). */
  name: string;
  /** Epoch milliseconds of the last open — caller-supplied (no ambient clock). */
  openedAt: number;
}

/**
 * Discriminated result of opening a project. The caller must handle the failure
 * case explicitly — a project that fails schema validation is never silently
 * coerced (AGENTS.md invariant 3). `project` is `unknown` until validated.
 */
export type ProjectOpenResult =
  | {
      ok: true;
      path: string;
      project: unknown;
      revision?: number;
      capabilityPacks?: CapabilityPackProjectResolutionWire;
    }
  | { ok: false; error: string };

/** Result of saving a project (to a path or the default folder). */
export type ProjectSaveResult =
  | { ok: true; path: string; revision?: number }
  | {
      ok: false;
      error: string;
      code?: 'revision_conflict';
      expectedRevision?: number;
      currentRevision?: number;
    };

export interface ProjectPatchCommitRequest {
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly patch: unknown;
  /** Durable run that proposed the patch; used for lifecycle events and undo grouping. */
  readonly runId?: string;
}

export type ProjectPatchConflictKind =
  | 'disjoint_rebaseable'
  | 'overlapping_replan'
  | 'authority_required';

export type ProjectPatchCommitResult =
  | {
      readonly ok: true;
      readonly project: unknown;
      readonly revision: number;
      readonly rebased: boolean;
      /** The host had already committed this exact patch and returned its current snapshot. */
      readonly replayed?: boolean;
      readonly conflictKind?: Extract<ProjectPatchConflictKind, 'disjoint_rebaseable'>;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly code: 'project_not_open' | 'revision_conflict' | 'invalid_patch';
      readonly conflictKind?: Exclude<ProjectPatchConflictKind, 'disjoint_rebaseable'>;
      readonly currentRevision?: number;
      readonly issues?: readonly unknown[];
    };

/**
 * A main→renderer **push** event fired when the open project's `project.fp.json`
 * changes on disk from *outside* the renderer — most importantly when an external
 * AI agent edits it through the MCP server. The renderer reloads from this so the
 * UI reflects those edits live, without re-opening the project.
 *
 * `project` is `unknown` until the renderer validates it against the Zod schema
 * (AGENTS.md invariant 3) — a malformed on-disk write is never coerced into the UI.
 */
export interface ProjectChangedEvent {
  /** Absolute path of the project file that changed. */
  path: string;
  /** The freshly-read project document (validated by the renderer before use). */
  project: unknown;
  /** Monotonic host-owned revision for optimistic concurrency. */
  revision?: number;
}

/** Result of revealing a file/folder in the OS file manager. */
export type RevealResult = { ok: true } | { ok: false; error: string };

/**
 * Request to export (render) a saved project to a video file. The sidecar loads
 * the project from `projectPath` on disk, so the project MUST be saved first.
 */
export interface ExportRequest {
  /** Absolute path of the saved `project.fp.json` the sidecar should render. */
  projectPath: string;
  /** Export preset id (see `render.presets`); omit for the engine default. */
  preset?: string;
  /** Burn caption-track text into the output (PRD §6.2, plan 3.3). */
  burnCaptions?: boolean;
  /** Master-bus broadband de-noise (ffmpeg afftdn, plan Phase 6). */
  denoise?: boolean;
  /** EQ preset: flat|warm|bright|voice-clarity (chained ffmpeg equalizer bands, plan H1.4). */
  eq?: string;
  /** Compression preset: voice (ffmpeg acompressor, plan H1.4). */
  compression?: string;
  /** Loudness preset: social|podcast|broadcast (ffmpeg loudnorm, plan Phase 6). */
  loudness?: string;
  /** Master-bus brick-wall limiter (ffmpeg alimiter, plan Phase 6). */
  limiter?: boolean;
  /** True for a fast low-res preview render; false (default) for a final export. */
  preview?: boolean;
}

/**
 * Result of an export. `outputPath` is the validated rendered file on success;
 * on failure `error` carries the render-job message (a render that fails
 * validation is reported, never silently returned).
 */
export type ExportResult =
  | { ok: true; outputPath: string; state: string }
  | { ok: false; error: string };

/**
 * Queue-level status of a submitted (non-preview) render job (H1.3a/H1.3b).
 * Mirrors the sidecar's `JobStatus` enum (`render/queue.py`).
 */
export type ExportJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * One main→renderer push for an in-flight full (non-preview) export, scoped by
 * `requestId` (H1.3b). Mirrors the `aiStreamEvent` pattern: `exportVideoStart`
 * (invoke) returns the id immediately since the sidecar's `POST /render` is
 * itself now async (submit + poll, ADR 0050) — this event stream is how the
 * caller learns about `queued`/`running`/terminal transitions instead of
 * blocking on one opaque promise. `status` is set on every push; `result` is
 * set exactly once, on the terminal push, carrying the same `ExportResult`
 * shape the old synchronous `exportVideo` returned directly.
 */
export interface ExportProgressMessage {
  readonly requestId: string;
  readonly jobId?: string;
  readonly status?: ExportJobStatus;
  readonly result?: ExportResult;
}

/**
 * Request to save an already-exported video to a user-chosen location via a
 * native "Save As" dialog.
 *
 * WHY this exists: the render engine only ever writes inside the sandboxed
 * projects folder (`exports/<id>.<ext>`, PathTraversalError otherwise) — it can
 * never write directly to an arbitrary user-chosen path. `sourcePath` is that
 * sandboxed render output (`ExportResult.outputPath`); the main process shows
 * the dialog and copies the file to wherever the user picks.
 */
export interface ExportSaveAsRequest {
  /** The sandboxed render output to copy (`ExportResult.outputPath`). */
  sourcePath: string;
  /** Suggested file name shown in the dialog (e.g. `"my-clip.mp4"`). */
  suggestedName?: string;
}

/**
 * Result of a Save As. `error` is the literal `'cancelled'` when the user
 * dismisses the dialog without choosing a location — the original render is
 * untouched in the sandboxed exports folder either way.
 */
export type ExportSaveAsResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * Request to copy an imported media file into the project's media folder.
 *
 * WHY this exists: the renderer imports media via a browser `blob:` object URL,
 * which does not resolve to a disk file — so the Python render engine (which
 * resolves each `asset.path` relative to the project file's folder) reports the
 * assets as unusable. The main process copies the bytes to a per-project
 * subfolder so BOTH the render engine and the `fp-media://` preview protocol
 * resolve the same on-disk file. `data` is the raw file bytes (an `ArrayBuffer`
 * survives structured-clone across the IPC boundary).
 */
export interface MediaImportRequest {
  /** The owning project's id; used to namespace the media subfolder. */
  projectId: string;
  /** Original file name (used, after sanitisation, as the on-disk name). */
  fileName: string;
  /** Raw file bytes to write to disk. */
  data: ArrayBuffer;
}

/**
 * Result of importing a media file. On success, `path` is the **relative** POSIX
 * path (`media/<projectId>/<file>`) to store in `asset.path`; it resolves under
 * the projects root for both the render engine and the preview protocol.
 */
export type MediaImportResult = { ok: true; path: string } | { ok: false; error: string };

/** Speech-to-text engines selectable in Settings → AI → Speech-to-text. */
export type AsrProviderName = 'whisper-cli' | 'twelvelabs' | 'groq' | 'nvidia';

/**
 * Request a real transcription from the trusted desktop host.
 *
 * The renderer supplies only project/asset identity and the non-secret provider
 * choice. The host resolves the media path inside the project sandbox and owns
 * provider credentials and audio bytes.
 */
export interface TranscriptionRequest {
  readonly projectPath: string;
  readonly assetId: string;
  readonly provider: AsrProviderName;
}

/** One validated word timestamp returned by the configured ASR provider. */
export interface TranscriptionWord {
  readonly word: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Result of trusted-host transcription. An empty provider result is a failure,
 * never a successful transcript that can erase existing project words.
 */
export type TranscriptionResult =
  | {
      readonly ok: true;
      readonly assetId: string;
      readonly words: readonly TranscriptionWord[];
    }
  | { readonly ok: false; readonly error: string; readonly unavailable?: boolean };

/**
 * Request to derive engine media (waveform peaks + thumbnails) for an
 * already-on-disk media file, so the timeline can draw real waveforms and the
 * filmstrip can draw real frames instead of skeletons.
 *
 * WHY separate from {@link MediaImportRequest}: that one copies *bytes* onto disk
 * and returns a path; this one takes the resulting on-disk path and asks the
 * Python engine (via the sidecar `/asset-media` route) to derive read-only media
 * for it. Splitting the two keeps the byte-copy fast and lets media derivation
 * fail (engine down) without blocking the import.
 */
export interface ImportAssetRequest {
  /**
   * On-disk media path to derive media for. Resolved and sandboxed under the
   * projects root in the main process before it ever reaches the sidecar
   * (defense in depth — the engine sandboxes too).
   */
  inputPath: string;
  /** How many thumbnail frames to sample across the asset; engine default if omitted. */
  thumbnails?: number;
  /** Also derive a low-res preview proxy for video (H3); engine skips over-long sources. */
  proxy?: boolean;
  /**
   * Project whose brain should record this import (plan B0.4). With `assetId`,
   * the sidecar persists the probe (+ content hash) into the project's derived
   * `brain.sqlite`; omitted → no brain write. Best-effort either way: a brain
   * failure never blocks the import.
   */
  projectId?: string;
  /** The project asset id the imported media belongs to (see `projectId`). */
  assetId?: string;
}

/**
 * Result of deriving engine media for an imported asset. On success `media`
 * carries the read-only, engine-produced handles to attach to the `Asset`
 * (the same shape as `AssetMedia` in `@framepilot/timeline-schema`, restated as
 * a plain inline type so this package stays schema-dependency-free). Failure
 * (engine down, unreadable file) is non-fatal to import — the caller keeps the
 * asset without media (skeleton) and surfaces a non-blocking status.
 */
export type ImportAssetResult =
  | {
      ok: true;
      durationSeconds: number | null;
      kind: 'video' | 'audio' | 'image';
      media: {
        peaks?: number[];
        peaksPerSecond?: number;
        thumbnailPaths?: string[];
        proxyPath?: string;
      };
    }
  | { ok: false; error: string };

/** Input sent from renderer to the AI IPC handlers. */
export interface AiRequest {
  /** Serialised `Project` — validated in the main process before use. */
  project: unknown;
  userPrompt: string;
}

/** Result of an AI chat / plan request (free-form text). */
export type AiTextResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * Result of an AI edit request. The `patch`, `validation`, and `diff` fields are
 * plain JSON — the renderer casts them to the ai-sdk `EditResult` type (the same
 * Zod-validated schema).
 */
export type AiEditResult =
  | { ok: true; patch: unknown; validation: unknown; diff?: unknown; text: string }
  | { ok: false; error: string };

/**
 * The full API surface bridged into the renderer as `window.framepilot`.
 *
 * This is the single source of truth for the bridge shape: the desktop preload
 * implements it and the renderer consumes it, both via `@framepilot/shared-types`,
 * so the implementation and the renderer's view of it cannot drift.
 */
/**
 * Lightweight metadata for one AI-sidebar conversation (Phase 11 M2, ADR 0033) —
 * enough to render the history list without loading the (possibly 20k-event) log.
 */
export interface ConversationSummary {
  readonly id: string;
  /** Project that owns this conversation; histories never cross this boundary. */
  readonly projectId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly model: string;
  readonly mode: string;
  readonly pinned: boolean;
  readonly favorite: boolean;
  readonly unread: boolean;
  readonly eventCount: number;
}

/**
 * The persisted unit for one conversation: its summary (kept in a cheap index for
 * `list`) plus the full conversation document as opaque JSON `data`. The main
 * process never parses `data` — it stores the summary in the index and the data in
 * the conversation's own JSON file.
 */
export interface ConversationRecord {
  readonly summary: ConversationSummary;
  readonly data: unknown;
}

/** Result of a conversation save/delete (a reason on failure). */
export interface ConversationSaveResult {
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * The streaming orchestrator modes the AI sidebar drives (Phase 11 M3, ADR 0033).
 * `auto` (ADR 0055) is the model-routed entry point: the main-process orchestrator
 * classifies the command and delegates to chat/agent internally.
 */
export type AiStreamMode = 'auto' | 'chat' | 'plan' | 'edit' | 'agent' | 'planned-edit';

/**
 * AI provider names the desktop can drive. Mirrors `ProviderName` in
 * `@framepilot/ai-sdk` (that package depends on this one, so the name list is
 * duplicated here rather than imported — the dependency must not invert).
 */
export type AiProviderName =
  | 'mock'
  | 'anthropic'
  | 'nvidia'
  | 'openrouter'
  | 'vercel-gateway'
  | 'groq'
  | 'google'
  | 'ollama'
  | 'deepseek'
  | 'openai-compatible';

/**
 * A provider the user can select in the sidebar model picker (Phase 11 clarity
 * pass). `ready` is whether the provider is usable now (its API key is configured);
 * **the key itself never crosses the bridge** — only this boolean and display text.
 */
export interface AiProviderInfo {
  readonly name: AiProviderName;
  /** Human label, e.g. "Claude (Anthropic)". */
  readonly label: string;
  /** The model id that will be used, e.g. "claude-opus-4-8". */
  readonly model: string;
  /** True when the provider can run now (mock is always ready; others need a key). */
  readonly ready: boolean;
  /**
   * The configured OpenAI-compatible base URL, for providers that expose one (Ollama,
   * NVIDIA). Non-secret, so — unlike keys — it IS read back to the UI so the field can
   * show the current value. Absent for providers with a fixed endpoint.
   */
  readonly baseUrl?: string;
}

/**
 * The renderer-visible AI configuration (Settings → AI). Carries **no secrets** —
 * only which provider is active and, per provider, the model id and a `ready` flag
 * (whether an API key is saved). Keys are written via {@link AiConfigUpdate} but
 * never read back across the bridge. On desktop this is persisted to a plaintext
 * `ai-config.json` in the app data dir; in the browser it lives in localStorage.
 */
export interface AiConfig {
  /** The provider AI runs use when the sidebar doesn't override it. */
  readonly activeProvider: AiProviderName;
  /** Every selectable provider with its model + ready (key-present) state. */
  readonly providers: readonly AiProviderInfo[];
  /**
   * NVIDIA API key(s) for **visual embeddings** (media intelligence), comma-separated.
   * NOT a chat provider slot — different product, different rotation semantics.
   *
   * Unlike chat keys, this value IS readable by the renderer (explicit user
   * requirement, plan MEDIA-INTELLIGENCE D5): the Settings input shows it in plain
   * text and the renderer/ai-sdk forwards it to the Python sidecar in request
   * bodies on the `/brain/visual/*` routes. Absent when no key is configured.
   */
  readonly nvidiaEmbeddings?: string;
  /**
   * TwelveLabs API key for **media understanding** (twelvelabs.io). When set, the
   * `/brain/visual/*` routes delegate video/image/audio understanding to
   * TwelveLabs' hosted index instead of the built-in NVIDIA-embed pipeline; unset
   * keeps the built-in one. Its own slot — NOT a chat provider key.
   *
   * Like {@link nvidiaEmbeddings} (and unlike chat keys), this value IS readable by
   * the renderer: the Settings input shows it and the renderer/ai-sdk forwards it to
   * the sidecar in `/brain/visual/*` request bodies. Absent when no key is configured.
   */
  readonly twelveLabs?: string;
  /**
   * Auto-index media on import when an embeddings key exists (plan
   * MEDIA-INTELLIGENCE D3). Defaults to `true` when never set.
   */
  readonly embeddingsAutoIndex?: boolean;
  /** Provider used to write per-scene visual descriptions during media indexing. */
  readonly visualCaptionProvider?: AiProviderName;
  /**
   * Dedicated API key for **hosted speech-to-text** (Settings → AI → Speech-to-text),
   * used by the hosted ASR providers (groq/nvidia). Its own slot — NOT a chat provider
   * key: a hosted-ASR account is separate from the chat account (plan H0.1).
   *
   * Like {@link nvidiaEmbeddings} (and unlike chat keys), this value IS readable by
   * the renderer: the Settings input shows it and the renderer forwards it to the
   * transcription path. Absent when no key is configured.
   */
  readonly asrApiKey?: string;
  /**
   * Which speech-to-text provider `transcribe` uses (Settings → AI → Speech-to-text).
   * `whisper-cli` (local) is the default. Persisted here — not just in renderer
   * localStorage — so the desktop main process can honor the selection when the AI
   * agent transcribes, routing hosted providers (groq/nvidia) off-device instead of
   * always falling back to the local engine. Absent ⇒ `whisper-cli`.
   */
  readonly asrProvider?: AsrProviderName;
  /**
   * Model id passed to the hosted ASR provider (Settings → AI → Speech-to-text).
   * Applies to whichever hosted provider is active (groq/nvidia) — its own slot, like
   * {@link asrApiKey}. Absent ⇒ the provider's built-in default (e.g.
   * `nemotron-asr-streaming` for NVIDIA). Round-trips to the UI (non-secret).
   */
  readonly asrModel?: string;
}

/**
 * A write to the AI configuration. Any subset may be provided. Setting a key to
 * `null` clears it; a string saves it. Keys flow renderer→main only (write-only).
 */
export interface AiConfigUpdate {
  /** Switch the active provider. */
  readonly activeProvider?: AiProviderName;
  /** Per-provider API key: a string saves it, `null` clears it. */
  readonly keys?: Partial<Record<AiProviderName, string | null>>;
  /** Per-provider model id override. */
  readonly models?: Partial<Record<AiProviderName, string>>;
  /**
   * Per-provider OpenAI-compatible base URL (Ollama, NVIDIA): a string saves it, `null`
   * clears it (revert to the provider default). Non-secret, so it round-trips to the UI.
   */
  readonly baseUrls?: Partial<Record<AiProviderName, string | null>>;
  /**
   * Comma-separated NVIDIA API key(s) for visual embeddings: a string saves it,
   * `null` (or empty) clears it. Unlike chat keys this slot round-trips to the UI —
   * see {@link AiConfig.nvidiaEmbeddings} for WHY.
   */
  readonly nvidiaEmbeddings?: string | null;
  /**
   * TwelveLabs media-understanding API key: a string saves it, `null` (or empty)
   * clears it. Unlike chat keys this slot round-trips to the UI — see
   * {@link AiConfig.twelveLabs} for WHY.
   */
  readonly twelveLabs?: string | null;
  /** Toggle background auto-indexing of imported media (default on). */
  readonly embeddingsAutoIndex?: boolean;
  /** Select the saved AI provider that captions indexed scenes. */
  readonly visualCaptionProvider?: AiProviderName;
  /**
   * Dedicated hosted speech-to-text API key: a string saves it, `null` (or empty)
   * clears it. Unlike chat keys this slot round-trips to the UI — see
   * {@link AiConfig.asrApiKey} for WHY.
   */
  readonly asrApiKey?: string | null;
  /** Select the speech-to-text provider `transcribe` uses (see {@link AiConfig.asrProvider}). */
  readonly asrProvider?: AsrProviderName;
  /**
   * Model id for the hosted ASR provider: a non-empty string saves it, `null`/empty
   * clears it (revert to the provider default). See {@link AiConfig.asrModel}.
   */
  readonly asrModel?: string | null;
}

/** A renderer-safe visual-index slice; caption credentials stay in desktop main. */
export interface VisualIndexRequest {
  readonly projectId: string;
  readonly projectPath?: string;
  readonly project?: Record<string, unknown>;
  readonly assetIds?: readonly string[];
  readonly nvidiaKeys?: string;
  /** TwelveLabs API key; when set, indexing is delegated to TwelveLabs. Never logged. */
  readonly twelveLabsKey?: string;
  readonly jobId?: string;
  readonly maxAssets?: number;
}

export interface VisualIndexItemResult {
  readonly assetId: string;
  readonly ok: boolean;
  readonly indexed: number;
  readonly captioned: number;
  readonly reason?: string | null | undefined;
}

export interface VisualIndexResult {
  readonly available: boolean;
  readonly reason?: string | null | undefined;
  readonly jobId?: string | null | undefined;
  readonly cursor: number;
  readonly total: number;
  readonly done: boolean;
  readonly indexed: number;
  readonly captioned: number;
  readonly captionsReason?: string | null | undefined;
  readonly items: VisualIndexItemResult[];
}

/**
 * A prior conversation turn threaded into the model context for multi-turn coherence
 * (reliability R2 B1). Structurally matches `AiMessage` in `@framepilot/ai-sdk` but is
 * declared here to keep the dependency from inverting. Only user/assistant turns are
 * sent; main re-validates and bounds the window.
 */
export interface AiStreamHistoryMessage {
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly content: string;
}

/** A timeline selection range in seconds that scopes the model context (R2 B3). */
export interface AiStreamSelection {
  readonly start: number;
  readonly end: number;
}

/** Versioned, ephemeral editor state captured when a streaming turn starts. */
export interface AiStreamInteractionContext {
  readonly schemaVersion: 2;
  readonly projectRevision: number;
  readonly timelineRevision: number;
  readonly sequenceId: string;
  readonly playhead: { readonly seconds: number; readonly frame: number };
  readonly selection: {
    readonly primaryClipId?: string;
    readonly clipIds: readonly string[];
    readonly trackIds: readonly string[];
    readonly effectLayerIds?: readonly string[];
    readonly keyframes?: readonly {
      readonly clipId: string;
      readonly property: string;
      readonly time: number;
    }[];
    readonly timeRange?: AiStreamSelection;
  };
  readonly visibleTimelineRange?: AiStreamSelection;
  readonly sourceMonitor?: {
    readonly assetId: string;
    /** Rational source-monitor timebase used to interpret its frame positions. */
    readonly rate: { readonly numerator: number; readonly denominator: number };
    readonly playhead: { readonly seconds: number; readonly frame: number };
    readonly markedRange?: { readonly startFrame: number; readonly endFrame: number };
  };
}

/**
 * Agent-run tuning forwarded to the agent loop (agent mode only). Mirrors the safe,
 * serialisable subset of `AgentOptions` in `@framepilot/ai-sdk`; `render` is
 * intentionally omitted (the in-loop preview render is a separate, gated surface).
 * Every field is bounded/allowlist-checked in main before use.
 */
export interface AiStreamAgentOptions {
  readonly maxSteps?: number;
  readonly maxOpsPerTurn?: number;
  readonly maxOpsPerRun?: number;
  readonly autoRepair?: boolean;
  readonly planFirst?: boolean;
  readonly durationTargetSeconds?: number;
  readonly targetPlatform?: 'reels' | 'tiktok' | 'shorts' | 'linkedin' | 'x';
}

/**
 * The user's cross-project editorial defaults (K5.1b/K6.1), threaded into the model
 * context in main so the desktop path inherits them like the browser path. Every field
 * is sanitised/bounded in main before use. Holds no secrets.
 */
export interface AiStreamUserMemory {
  readonly targetAudience?: string;
  readonly brandStyle?: string;
  readonly captionStyle?: string;
  readonly preferredPacing?: string;
  readonly favoriteExportPlatforms?: readonly string[];
}

/**
 * A request to start a streaming AI run in the main process. `project` is the
 * opaque project JSON (re-validated in main); the conversation/turn ids stamp the
 * emitted events. Carries no secrets — the API key stays in the main process.
 */
export interface AiStreamRequest {
  readonly mode: AiStreamMode;
  /** Legacy/browser compatibility document; desktop resolves authoritative state by id. */
  readonly project?: unknown;
  readonly projectId?: string;
  readonly projectRevision?: number;
  readonly userPrompt: string;
  readonly conversationId: string;
  readonly turnId: string;
  /** Durable run id when the desktop stream is attached to protocol-v1 authority. */
  readonly durableRunId?: string;
  /**
   * The provider to run this request with. When omitted, main uses its configured
   * default (`FRAMEPILOT_AI_PROVIDER`). Validated against an allowlist in main.
   */
  readonly provider?: AiProviderName;
  /**
   * Prior conversation turns for multi-turn coherence (R2 B1). Threaded into the
   * model context in main; bounded to the most-recent window. Validated in main.
   */
  readonly history?: readonly AiStreamHistoryMessage[];
  /** The current timeline selection, so context is scoped on a large project (R2 B3). */
  readonly selection?: AiStreamSelection;
  /** Live editor referents used by the deterministic target resolver. */
  readonly interaction?: AiStreamInteractionContext;
  /** The user's cross-project editorial defaults (K5.1b/K6.1). Sanitised in main. */
  readonly userMemory?: AiStreamUserMemory;
  /** Agent-mode tuning (plan/caps/auto-repair/duration). Ignored for non-agent modes. */
  readonly agentOptions?: AiStreamAgentOptions;
}

/**
 * One main→renderer push for a streaming run, scoped by `requestId` so the
 * renderer only consumes its own run's events. Exactly one of `event` (an opaque
 * `AiEvent` JSON), `done`, or `error` is set. `event` is `unknown` because the
 * `AiEvent` type lives in `@framepilot/ai-sdk`, which depends on this package
 * (the dependency must not invert).
 */
export interface AiStreamEventMessage {
  readonly requestId: string;
  readonly event?: unknown;
  /** WAL sequence assigned before this event was published. */
  readonly durableSequence?: number;
  readonly done?: boolean;
  readonly error?: string;
}

/**
 * Durable orchestration protocol v1 transport projection. The validating Zod
 * schemas live in `@framepilot/ai-sdk`; these dependency-free shapes keep the
 * Electron preload and renderer statically synchronized with that boundary.
 */
export type DurableRunCommandKind =
  | 'approve_plan'
  | 'reject_plan'
  | 'answer'
  | 'steer'
  | 'cancel'
  | 'resume'
  | 'accept_patch'
  | 'reject_patch';

export interface DurableRunStartRequest {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly userPrompt: string;
  readonly mode: 'auto' | 'chat' | 'plan' | 'edit' | 'agent' | 'planned-edit' | 'review';
  readonly selection?: unknown;
  readonly agentOptions?: unknown;
  readonly contextHandles?: readonly string[];
  readonly patchPolicy?: 'review' | 'auto_commit';
}

export interface DurableRunCommandRequest {
  readonly runId: string;
  readonly projectId: string;
  readonly expectedProjectRevision?: number | undefined;
  readonly kind: DurableRunCommandKind;
  readonly payload: unknown;
}

export interface DurableRunCommandEnvelope {
  readonly schemaVersion: 1;
  readonly commandId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly expectedProjectRevision?: number | undefined;
  readonly issuedAt: number;
  readonly kind: 'start' | DurableRunCommandKind;
  readonly payload: unknown;
}

export interface DurableRunEvent {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly sequence: number;
  readonly causedByCommandId?: string | undefined;
  readonly causedByEffectId?: string | undefined;
  readonly projectRevision?: number | undefined;
  readonly occurredAt: number;
  readonly kind: string;
  readonly payload: unknown;
}

export type DurableRunStatus =
  | 'idle'
  | 'accepted'
  | 'thinking'
  | 'searching'
  | 'reading'
  | 'planning'
  | 'awaiting_approval'
  | 'awaiting_answer'
  | 'awaiting_input'
  | 'editing'
  | 'executing'
  | 'generating'
  | 'running_tool'
  | 'rendering'
  | 'reconciling'
  | 'verifying'
  | 'awaiting_review'
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface DurableRunSnapshot {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly projectId: string;
  readonly status: DurableRunStatus;
  readonly outcome?: unknown | undefined;
  readonly baseProjectRevision: number;
  readonly currentProjectRevision: number;
  readonly lastSequence: number;
  readonly graphVersion: number;
  readonly tasks: readonly unknown[];
  readonly effects: readonly unknown[];
  readonly patchDecisions: readonly unknown[];
  /** Canonical causal ledger for recovery and development diagnostics. */
  readonly workingState?: unknown | undefined;
  readonly pendingGate?: unknown | undefined;
  readonly budgets: Readonly<Record<string, unknown>>;
  readonly contextHandles: readonly string[];
  readonly patchPolicy: 'review' | 'auto_commit';
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface DurableRunAccepted {
  readonly command: DurableRunCommandEnvelope;
  readonly event: DurableRunEvent;
  readonly snapshot: DurableRunSnapshot;
}

export interface DurableRunSnapshotRequest {
  readonly runId: string;
  readonly projectId: string;
}

export interface DurableRunSubscribeRequest extends DurableRunSnapshotRequest {
  readonly afterSequence: number;
}

export interface DurableRunSubscription {
  readonly subscriptionId: string;
  readonly snapshot: DurableRunSnapshot | null;
  readonly events: readonly DurableRunEvent[];
  readonly hasMore: boolean;
}

export interface DurableRunEventMessage {
  readonly subscriptionId: string;
  readonly event?: DurableRunEvent;
  readonly resyncRequired?: { readonly afterSequence: number };
}

export interface DurableRunAckRequest {
  readonly subscriptionId: string;
  readonly sequence: number;
}

/**
 * The editor's reply to a question the MODEL asked mid-run (P12, `ask_user`).
 *
 * `toolCallId` addresses the exact `ask` event being answered, so a late reply to an
 * abandoned question can never satisfy a different one. `cancelled` means the editor
 * dismissed the question rather than answering — the run stops; it is never reported to
 * the model as if they had said something.
 */
export type AiStreamAnswerMessage =
  | { readonly toolCallId: string; readonly kind: 'answered'; readonly answer: string }
  | { readonly toolCallId: string; readonly kind: 'cancelled' };

/**
 * License gate (100%-paid app). The desktop requires a valid Freemius license to
 * run. `licensed` is the convenience boolean the renderer gate reads; the license
 * key + install token NEVER cross the bridge — only this projection does.
 */
export type LicenseStatusKind = 'valid' | 'invalid' | 'needs_activation';

export interface LicenseStatus {
  readonly status: LicenseStatusKind;
  /** True only when the app should unlock (status === 'valid'). */
  readonly licensed: boolean;
  /** Subscription expiration (Freemius date/ISO string) or null for lifetime/none. */
  readonly expiresAt: string | null;
  /** Masked key for display (e.g. "••••-••••-AB12"); never the full key. */
  readonly maskedKey?: string;
  /** Human message for the activation UI (error reason / info). */
  readonly message?: string;
  /** True when validity is being honoured from the offline-grace window. */
  readonly offlineGrace?: boolean;
}

/** A request to activate a license key. */
export interface LicenseActivateRequest {
  readonly licenseKey: string;
}

/** Renderer-safe immutable identity of one platform Capability Pack artifact. */
export interface CapabilityPackIdentityWire {
  readonly id: string;
  readonly version: string;
  readonly releaseDigest: string;
  readonly artifactDigest: string;
  readonly os: 'darwin' | 'win32';
  readonly arch: 'arm64' | 'x64';
}

export interface CapabilityPackStorageItemWire {
  readonly identity: CapabilityPackIdentityWire;
  readonly state: 'installed' | 'quarantined' | 'pending_removal';
  readonly installedBytes: number;
  readonly lastUsedAt: string;
  readonly pinnedProjectIds: readonly string[];
  readonly activeLeaseCount: number;
  readonly health: 'healthy' | 'unhealthy';
  readonly healthDetail?: string;
}

export interface CapabilityPackStorageSnapshotWire {
  readonly rootPath: string;
  readonly totalBytes: number;
  readonly installedBytes: number;
  readonly quarantinedBytes: number;
  readonly pendingRemovalBytes: number;
  readonly reclaimableBytes: number;
  readonly projectUsage: Readonly<Record<string, number>>;
  readonly items: readonly CapabilityPackStorageItemWire[];
}

/** Facts main verified from the signed catalog and the renderer must show before approval. */
export interface CapabilityPackInstallProposalWire {
  readonly proposalId: string;
  readonly identity: CapabilityPackIdentityWire;
  readonly capabilities: readonly string[];
  readonly displayName: string;
  readonly description: string;
  readonly downloadBytes: number;
  readonly installedBytes: number;
  readonly licenses: readonly {
    readonly spdx: string;
    readonly name: string;
    readonly noticeUrl: string;
  }[];
  readonly privacy: {
    readonly execution: 'local' | 'cloud' | 'hybrid';
    readonly mediaLeavesDevice: boolean;
    readonly disclosure: string;
  };
}

export interface CapabilityPackInstallApprovalWire {
  readonly proposalId: string;
  readonly identity: CapabilityPackIdentityWire;
  readonly approvedSizeBytes: number;
  readonly approvedLicenseSpdx: readonly string[];
  readonly approvedMediaEgress: boolean;
  readonly approvedAt: string;
}

export type CapabilityPackActionResultWire =
  | { readonly ok: true; readonly storage: CapabilityPackStorageSnapshotWire }
  | { readonly ok: false; readonly code: string; readonly error: string };

export type CapabilityPackProposalResultWire =
  | { readonly ok: true; readonly proposal: CapabilityPackInstallProposalWire }
  | { readonly ok: false; readonly code: string; readonly error: string };

export type CapabilityPackInstallStartResultWire =
  | { readonly ok: true; readonly operationId: string }
  | { readonly ok: false; readonly code: string; readonly error: string };

/**
 * Renderer intent for one tracking job.
 *
 * There is deliberately no media path and no project revision here: main
 * resolves the asset against the project it reads from disk, and stamps its own
 * authoritative revision, so the renderer cannot aim a worker at another file or
 * claim a project state that is no longer current.
 */
export interface TrackingRequestIntentWire {
  readonly requestId: string;
  readonly assetId: string;
  readonly capability: 'tracking.point' | 'tracking.region' | 'tracking.planar';
  readonly firstFrame: number;
  readonly lastFrameExclusive: number;
  readonly fps: number;
  /** Normalized point, box, or four corners, matching the capability. */
  readonly parameters: unknown;
}

export interface TrackingSampleWire {
  readonly frame: number;
  readonly box: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly confidence: number;
  readonly occluded: boolean;
}

export type TrackingRunResultWire =
  | {
      readonly ok: true;
      readonly samples: readonly TrackingSampleWire[];
      /** Exact pack identity that measured this track, for edit provenance. */
      readonly engine: string;
      readonly backend: string;
      readonly projectRevision: number;
    }
  /** No healthy pack is installed. The user is offered the exact signed install. */
  | { readonly ok: false; readonly code: 'pack_missing'; readonly proposal: CapabilityPackProposalResultWire }
  | { readonly ok: false; readonly code: string; readonly error: string; readonly retryable: boolean };

export interface TrackingProgressWire {
  readonly requestId: string;
  readonly phase: string;
  readonly completed: number;
  readonly total: number;
}

export interface CapabilityPackEvictionPlanWire {
  readonly planId: string;
  readonly requestedBytes: number;
  readonly reclaimableBytes: number;
  readonly sufficient: boolean;
  readonly candidates: readonly {
    readonly identity: CapabilityPackIdentityWire;
    readonly installedBytes: number;
    readonly affectedProjectIds: readonly string[];
    readonly activeLeaseCount: number;
  }[];
}

export type CapabilityPackEvictionPlanResultWire =
  | { readonly ok: true; readonly plan: CapabilityPackEvictionPlanWire }
  | { readonly ok: false; readonly code: string; readonly error: string };

export interface CapabilityPackEvictionApprovalWire {
  readonly planId: string;
  readonly approvedIdentityKeys: readonly string[];
}

export interface CapabilityPackProgressWire {
  readonly operationId: string;
  readonly identity: CapabilityPackIdentityWire;
  readonly phase:
    | 'awaiting_approval'
    | 'reserving_space'
    | 'downloading'
    | 'verifying'
    | 'extracting'
    | 'checking_executable'
    | 'health_checking'
    | 'committing'
    | 'installed'
    | 'cancelled'
    | 'failed';
  readonly completedBytes: number;
  readonly totalBytes: number;
  readonly detail?: string;
  readonly errorCode?: string;
}

export interface CapabilityPackRelocationProgressWire {
  readonly copiedBytes: number;
  readonly totalBytes: number;
  readonly currentRelativePath?: string;
}

export interface CapabilityPackProjectPinWire {
  readonly id: string;
  readonly version: string;
  readonly releaseDigest: string;
  readonly capabilities: readonly string[];
  readonly requiredFor: 'render' | 'edit' | 'analysis';
}

export interface CapabilityPackProjectDependencyWire {
  readonly pin: CapabilityPackProjectPinWire;
  readonly status: 'ready' | 'missing' | 'unhealthy';
  readonly identity?: CapabilityPackIdentityWire;
  readonly detail?: string;
}

export interface CapabilityPackProjectResolutionWire {
  readonly dependencies: readonly CapabilityPackProjectDependencyWire[];
  readonly renderBlocked: boolean;
  readonly editBlocked: boolean;
}

export type CapabilityPackRelocationResultWire =
  | {
      readonly ok: true;
      readonly storage: CapabilityPackStorageSnapshotWire;
      readonly previousRoot: string;
    }
  | { readonly ok: false; readonly code: string; readonly error: string };

export interface FramePilotBridge {
  ping(): Promise<'pong'>;
  /**
   * Current license status (safe projection — no key/token). The gate calls this
   * on mount; it may revalidate against Freemius in the main process.
   */
  licenseStatus(): Promise<LicenseStatus>;
  /** Activate a license key on this device; returns the new status. */
  licenseActivate(req: LicenseActivateRequest): Promise<LicenseStatus>;
  /** Remove the local license (deactivate); returns the new status. */
  licenseDeactivate(): Promise<LicenseStatus>;
  sidecarStatus(): Promise<SidecarStatus>;
  /** Read installed/quarantined pack state from the main-process storage authority. */
  capabilityPackStorage?(): Promise<CapabilityPackStorageSnapshotWire>;
  /** Choose an empty folder in a native dialog and transactionally move pack storage. */
  capabilityPackRelocate?(): Promise<CapabilityPackRelocationResultWire>;
  /** Resolve one capability through the root-verified catalog; never accepts a renderer URL. */
  capabilityPackPropose?(capabilityId: string): Promise<CapabilityPackProposalResultWire>;
  /** Resolve the active project's exact immutable dependency; main rereads the project authority. */
  capabilityPackProposeProjectDependency?(projectId: string, packId: string): Promise<CapabilityPackProposalResultWire>;
  /** Reconcile and report the active project's authoritative dependency state. */
  capabilityPackProjectStatus?(projectId: string): Promise<CapabilityPackProjectResolutionWire>;
  /** Run one tracking job in an isolated signed pack worker; main resolves the media. */
  capabilityPackTrack?(intent: TrackingRequestIntentWire): Promise<TrackingRunResultWire>;
  /** Cancel an in-flight tracking job by request id. */
  capabilityPackCancelTrack?(requestId: string): void;
  /** Bounded progress for an in-flight tracking job. */
  onCapabilityPackTrackProgress?(handler: (progress: TrackingProgressWire) => void): () => void;
  /** Install only the exact signed proposal the user explicitly approved. */
  capabilityPackInstall?(approval: CapabilityPackInstallApprovalWire): Promise<CapabilityPackInstallStartResultWire>;
  /** Cancel one main-owned install operation. */
  capabilityPackCancel?(operationId: string): void;
  /** Build a non-mutating explicit cleanup proposal. */
  capabilityPackPlanEviction?(requestedBytes: number): Promise<CapabilityPackEvictionPlanResultWire>;
  /** Execute only an unexpired plan and exact identity list previously displayed. */
  capabilityPackExecuteEviction?(approval: CapabilityPackEvictionApprovalWire): Promise<CapabilityPackActionResultWire>;
  /** Subscribe to install progress; the returned function unsubscribes. */
  onCapabilityPackProgress?(listener: (message: CapabilityPackProgressWire) => void): () => void;
  /** Subscribe to storage-copy progress; the returned function unsubscribes. */
  onCapabilityPackRelocationProgress?(listener: (message: CapabilityPackRelocationProgressWire) => void): () => void;
  openProject(path: string): Promise<ProjectOpenResult>;
  /** Show a native OS file picker and open the selected project. */
  openProjectDialog(): Promise<ProjectOpenResult>;
  saveProject(
    path: string,
    project: unknown,
    expectedRevision?: number,
  ): Promise<ProjectSaveResult>;
  /** Save a path-less project under the default projects folder (autosave). */
  saveProjectDefault(project: unknown, expectedRevision?: number): Promise<ProjectSaveResult>;
  /** Validate and commit one typed patch against the authoritative project revision. */
  commitProjectPatch?(request: ProjectPatchCommitRequest): Promise<ProjectPatchCommitResult>;
  /** Absolute path of the default projects folder (for surfacing in the UI). */
  projectsDir(): Promise<string>;
  /** Reveal `path` (or the projects folder when empty) in the OS file manager. */
  revealProject(path: string): Promise<RevealResult>;
  recentProjects(): Promise<RecentProject[]>;
  /**
   * Render/export a saved project to a video file (delegates to the sidecar).
   * Used for preview renders (`req.preview`), which stay synchronous — for a
   * full export, prefer {@link exportVideoStart} so the UI can show live
   * progress and cancel (H1.3b).
   */
  exportVideo(req: ExportRequest): Promise<ExportResult>;
  /**
   * Start a full (non-preview) export asynchronously; resolves to a
   * `requestId` immediately (the sidecar's `/render` is itself async — submit
   * + poll, H1.3a). Progress (`queued` → `running` → terminal) arrives as
   * main→renderer pushes via {@link onExportProgress}, scoped to that id.
   */
  exportVideoStart(req: ExportRequest): Promise<string>;
  /** Cancel an in-flight export by id (fire-and-forget; tells the sidecar job to cancel). */
  exportVideoCancel(requestId: string): void;
  /** Subscribe to export progress pushes; the returned function unsubscribes. */
  onExportProgress(listener: (message: ExportProgressMessage) => void): () => void;
  /**
   * Save an already-exported video (the sandboxed render output) to a
   * user-chosen location via a native "Save As" dialog.
   */
  exportSaveAs(req: ExportSaveAsRequest): Promise<ExportSaveAsResult>;
  /** Copy an imported media file into the project's media folder, returning its
   * relative on-disk path (so render + preview share the same file). */
  importMedia(req: MediaImportRequest): Promise<MediaImportResult>;
  /** Derive engine media (waveform peaks + thumbnails) for an on-disk media file,
   * so the timeline draws real waveforms/frames. Non-fatal on engine failure. */
  importAsset(req: ImportAssetRequest): Promise<ImportAssetResult>;
  /** Run configured speech-to-text in the trusted host for one saved media asset. */
  transcribe(req: TranscriptionRequest): Promise<TranscriptionResult>;
  aiChat(req: AiRequest): Promise<AiTextResult>;
  aiPlan(req: AiRequest): Promise<AiTextResult>;
  aiEdit(req: AiRequest): Promise<AiEditResult>;
  /**
   * List the AI providers the desktop can run, with the model each would use and
   * whether it is ready (its key is configured). Drives the sidebar model picker.
   * No secret crosses the bridge — only names, labels, models, and a `ready` flag.
   */
  aiProviders(): Promise<AiProviderInfo[]>;
  /**
   * Read the AI configuration (active provider + per-provider model/ready state).
   * No secret crosses the bridge — API keys are write-only via {@link aiConfigSet}.
   */
  aiConfigGet(): Promise<AiConfig>;
  /**
   * Update the AI configuration (active provider, per-provider API key/model) and
   * return the new config. Keys flow renderer→main only; the file stays in main.
   */
  aiConfigSet(update: AiConfigUpdate): Promise<AiConfig>;
  /** Index through desktop so caption-provider credentials never enter the renderer. */
  visualIndex?(request: VisualIndexRequest): Promise<VisualIndexResult | undefined>;
  /**
   * Subscribe to live external changes to the open project file (e.g. an MCP
   * agent editing it). The listener receives the validated-on-disk project; the
   * returned function unsubscribes. A no-op returning a no-op outside Electron.
   */
  onProjectChanged(listener: (event: ProjectChangedEvent) => void): () => void;
  /** List AI-sidebar conversation summaries (most-recent-first is the caller's job). */
  conversationsList(): Promise<ConversationSummary[]>;
  /** Load one conversation's full JSON document by id, or `null` if absent/corrupt. */
  conversationsLoad(id: string): Promise<unknown | null>;
  /** Insert or replace one conversation (writes a sandboxed JSON file). */
  conversationsSave(record: ConversationRecord): Promise<ConversationSaveResult>;
  /** Delete one conversation by id. */
  conversationsDelete(id: string): Promise<ConversationSaveResult>;
  /**
   * Start a streaming AI run in the main process; resolves to a `requestId`. Events
   * arrive as main→renderer pushes via {@link FramePilotBridge.onAiStreamEvent},
   * scoped to that id. Fetch runs in main (no sandbox); no secret crosses the bridge.
   */
  aiStreamStart(request: AiStreamRequest): Promise<string>;
  /** Abort an in-flight streaming run by id — cancels the upstream fetch in main. */
  aiStreamAbort(requestId: string): void;
  /** Answer the model's pending question for `requestId` (P12). */
  aiStreamAnswer(requestId: string, answer: AiStreamAnswerMessage): void;
  /** Subscribe to streaming AI pushes; the returned function unsubscribes. */
  onAiStreamEvent(listener: (message: AiStreamEventMessage) => void): () => void;
  /** Start a protocol-v1 durable run in Electron main. */
  runStart?(request: DurableRunStartRequest): Promise<DurableRunAccepted>;
  /** Send a durable approval, answer, steering, cancellation, resume, or patch decision. */
  runCommand?(request: DurableRunCommandRequest): Promise<DurableRunAccepted>;
  /** Read the latest authoritative snapshot for a run/project pair. */
  runSnapshot?(request: DurableRunSnapshotRequest): Promise<DurableRunSnapshot | null>;
  /** Subscribe from an acknowledged sequence and receive snapshot + replay immediately. */
  runSubscribe?(request: DurableRunSubscribeRequest): Promise<DurableRunSubscription>;
  /** Release one sender-scoped durable-run subscription. */
  runUnsubscribe?(subscriptionId: string): void;
  /** Acknowledge the highest contiguous sequence; also renews the subscription lease. */
  runAck?(request: DurableRunAckRequest): void;
  /** Subscribe to future durable events; the returned function removes the listener. */
  onRunEvent?(listener: (message: DurableRunEventMessage) => void): () => void;
}
