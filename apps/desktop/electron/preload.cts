/** FramePilot Electron preload — secure sandboxed CommonJS bridge. */
import electron = require('electron');
import type {
  AiEditResult,
  AiProviderInfo,
  AiConfig,
  AiConfigUpdate,
  VisualIndexRequest,
  VisualIndexResult,
  AiRequest,
  AiTextResult,
  LicenseStatus,
  LicenseActivateRequest,
  ExportRequest,
  ExportResult,
  ExportProgressMessage,
  ExportSaveAsRequest,
  ExportSaveAsResult,
  MediaImportRequest,
  MediaImportResult,
  StockSearchRequest,
  StockSearchResult,
  StockBytesResult,
  StockDownloadRequest,
  StockDownloadResult,
  StockDownloadProgressWire,
  StockQuotaSnapshot,
  ImportAssetRequest,
  ImportAssetResult,
  TranscriptionRequest,
  TranscriptionResult,
  ConversationRecord,
  ConversationSaveResult,
  ConversationSummary,
  AiStreamRequest,
  AiStreamEventMessage,
  AiStreamAnswerMessage,
  DurableRunStartRequest,
  DurableRunCommandRequest,
  DurableRunAccepted,
  DurableRunSnapshotRequest,
  DurableRunSnapshot,
  DurableRunSubscribeRequest,
  DurableRunSubscription,
  DurableRunEventMessage,
  DurableRunAckRequest,
  FramePilotBridge,
  ProjectChangedEvent,
  ProjectOpenResult,
  ProjectSaveResult,
  ProjectPatchCommitRequest,
  ProjectPatchCommitResult,
  RecentProject,
  RevealResult,
  SidecarStatus,
  CapabilityPackStorageSnapshotWire,
  CapabilityPackProposalResultWire,
  CapabilityPackInstallStartResultWire,
  CapabilityPackInstallApprovalWire,
  CapabilityPackActionResultWire,
  CapabilityPackEvictionPlanResultWire,
  CapabilityPackEvictionApprovalWire,
  CapabilityPackProgressWire,
  MusicSearchResult,
  MusicPreviewResult,
  MusicDownloadRequest,
  MusicDownloadResult,
  MusicDownloadProgressWire,
  CapabilityPackRelocationProgressWire,
  TrackingProgressWire,
  TrackingRequestIntentWire,
  TrackingRunResultWire,
  CapabilityPackRelocationResultWire,
  CapabilityPackProjectResolutionWire,
} from './ipc/contract.js';
import type {
  MediaImportChunkBridge,
  MediaImportChunkRequest,
  MediaImportChunkResult,
  ProjectSnapshotBridge,
  AnalyzeReferenceRequest,
  AnalyzeReferenceResult,
} from '@framepilot/shared-types';
import type { IpcRendererEvent } from 'electron';

const { contextBridge, ipcRenderer } = electron;

// Sandboxed CJS cannot import the ESM channel registry at runtime. The parity test pins this
// literal exactly to ipc/contract.ts.
const Channels = {
  ping: 'framepilot:ping',
  licenseStatus: 'framepilot:license:status',
  licenseActivate: 'framepilot:license:activate',
  licenseDeactivate: 'framepilot:license:deactivate',
  sidecarStatus: 'framepilot:sidecar:status',
  projectOpen: 'framepilot:project:open',
  projectSnapshot: 'framepilot:project:snapshot',
  projectOpenDialog: 'framepilot:project:open-dialog',
  projectSave: 'framepilot:project:save',
  projectSaveDefault: 'framepilot:project:save-default',
  projectCommitPatch: 'framepilot:project:commit-patch',
  projectsDir: 'framepilot:project:dir',
  projectReveal: 'framepilot:project:reveal',
  projectRecent: 'framepilot:project:recent',
  renderExport: 'framepilot:render:export',
  renderExportStart: 'framepilot:render:export-start',
  renderExportCancel: 'framepilot:render:export-cancel',
  renderExportProgress: 'framepilot:render:export-progress',
  exportSaveAs: 'framepilot:export:save-as',
  mediaImport: 'framepilot:media:import',
  mediaImportChunk: 'framepilot:media:import-chunk',
  mediaImportAsset: 'framepilot:media:import-asset',
  referencesAnalyze: 'framepilot:references:analyze',
  transcribe: 'framepilot:ai:transcribe',
  aiChat: 'framepilot:ai:chat',
  aiPlan: 'framepilot:ai:plan',
  aiEdit: 'framepilot:ai:edit',
  aiProviders: 'framepilot:ai:providers',
  aiConfigGet: 'framepilot:ai:config-get',
  aiConfigSet: 'framepilot:ai:config-set',
  visualIndex: 'framepilot:visual-index',
  projectChanged: 'framepilot:project:changed',
  conversationsList: 'framepilot:conversations:list',
  conversationsLoad: 'framepilot:conversations:load',
  conversationsSave: 'framepilot:conversations:save',
  conversationsDelete: 'framepilot:conversations:delete',
  aiStreamStart: 'framepilot:ai:stream-start',
  aiStreamAbort: 'framepilot:ai:stream-abort',
  aiStreamAnswer: 'framepilot:ai:stream-answer',
  aiStreamEvent: 'framepilot:ai:stream-event',
  runStart: 'framepilot:run:start',
  runCommand: 'framepilot:run:command',
  runSnapshot: 'framepilot:run:snapshot',
  runSubscribe: 'framepilot:run:subscribe',
  runUnsubscribe: 'framepilot:run:unsubscribe',
  runAck: 'framepilot:run:ack',
  runEvent: 'framepilot:run:event',
  capabilityPackStorage: 'framepilot:capability-pack:storage',
  capabilityPackRelocate: 'framepilot:capability-pack:relocate',
  capabilityPackRelocationProgress: 'framepilot:capability-pack:relocation-progress',
  capabilityPackPropose: 'framepilot:capability-pack:propose',
  capabilityPackProposeProjectDependency: 'framepilot:capability-pack:propose-project-dependency',
  capabilityPackProjectStatus: 'framepilot:capability-pack:project-status',
  capabilityPackInstall: 'framepilot:capability-pack:install',
  capabilityPackCancel: 'framepilot:capability-pack:cancel',
  capabilityPackPlanEviction: 'framepilot:capability-pack:plan-eviction',
  capabilityPackExecuteEviction: 'framepilot:capability-pack:execute-eviction',
  capabilityPackProgress: 'framepilot:capability-pack:progress',
  capabilityPackTrack: 'framepilot:capability-pack:track',
  capabilityPackCancelTrack: 'framepilot:capability-pack:cancel-track',
  capabilityPackTrackProgress: 'framepilot:capability-pack:track-progress',
  musicSearch: 'framepilot:music:search',
  musicPreview: 'framepilot:music:preview',
  musicDownload: 'framepilot:music:download',
  musicDownloadCancel: 'framepilot:music:download-cancel',
  musicDownloadProgress: 'framepilot:music:download-progress',
  stockSearch: 'framepilot:stock:search',
  stockThumbnail: 'framepilot:stock:thumbnail',
  stockPreview: 'framepilot:stock:preview',
  stockDownload: 'framepilot:stock:download',
  stockDownloadCancel: 'framepilot:stock:download-cancel',
  stockDownloadProgress: 'framepilot:stock:download-progress',
  stockQuota: 'framepilot:stock:quota',
  stockQuotaChanged: 'framepilot:stock:quota-changed',
} as const;

const bridge: FramePilotBridge & ProjectSnapshotBridge & MediaImportChunkBridge = {
  ping: () => ipcRenderer.invoke(Channels.ping) as Promise<'pong'>,
  licenseStatus: () => ipcRenderer.invoke(Channels.licenseStatus) as Promise<LicenseStatus>,
  licenseActivate: (req: LicenseActivateRequest) =>
    ipcRenderer.invoke(Channels.licenseActivate, req) as Promise<LicenseStatus>,
  licenseDeactivate: () => ipcRenderer.invoke(Channels.licenseDeactivate) as Promise<LicenseStatus>,
  sidecarStatus: () => ipcRenderer.invoke(Channels.sidecarStatus) as Promise<SidecarStatus>,
  capabilityPackStorage: () =>
    ipcRenderer.invoke(
      Channels.capabilityPackStorage,
    ) as Promise<CapabilityPackStorageSnapshotWire>,
  capabilityPackRelocate: () =>
    ipcRenderer.invoke(
      Channels.capabilityPackRelocate,
    ) as Promise<CapabilityPackRelocationResultWire>,
  capabilityPackPropose: (capabilityId: string) =>
    ipcRenderer.invoke(
      Channels.capabilityPackPropose,
      capabilityId,
    ) as Promise<CapabilityPackProposalResultWire>,
  capabilityPackProposeProjectDependency: (projectId: string, packId: string) =>
    ipcRenderer.invoke(
      Channels.capabilityPackProposeProjectDependency,
      projectId,
      packId,
    ) as Promise<CapabilityPackProposalResultWire>,
  capabilityPackProjectStatus: (projectId: string) =>
    ipcRenderer.invoke(
      Channels.capabilityPackProjectStatus,
      projectId,
    ) as Promise<CapabilityPackProjectResolutionWire>,
  capabilityPackInstall: (approval: CapabilityPackInstallApprovalWire) =>
    ipcRenderer.invoke(
      Channels.capabilityPackInstall,
      approval,
    ) as Promise<CapabilityPackInstallStartResultWire>,
  capabilityPackCancel: (operationId: string) =>
    ipcRenderer.send(Channels.capabilityPackCancel, operationId),
  capabilityPackPlanEviction: (requestedBytes: number) =>
    ipcRenderer.invoke(
      Channels.capabilityPackPlanEviction,
      requestedBytes,
    ) as Promise<CapabilityPackEvictionPlanResultWire>,
  capabilityPackExecuteEviction: (approval: CapabilityPackEvictionApprovalWire) =>
    ipcRenderer.invoke(
      Channels.capabilityPackExecuteEviction,
      approval,
    ) as Promise<CapabilityPackActionResultWire>,
  onCapabilityPackProgress: (listener: (message: CapabilityPackProgressWire) => void) => {
    const handler = (_event: IpcRendererEvent, payload: CapabilityPackProgressWire): void =>
      listener(payload);
    ipcRenderer.on(Channels.capabilityPackProgress, handler);
    return () => ipcRenderer.removeListener(Channels.capabilityPackProgress, handler);
  },
  capabilityPackTrack: (intent: TrackingRequestIntentWire) =>
    ipcRenderer.invoke(Channels.capabilityPackTrack, intent) as Promise<TrackingRunResultWire>,
  capabilityPackCancelTrack: (requestId: string) => {
    ipcRenderer.send(Channels.capabilityPackCancelTrack, requestId);
  },
  onCapabilityPackTrackProgress: (listener: (progress: TrackingProgressWire) => void) => {
    const handler = (_event: IpcRendererEvent, payload: TrackingProgressWire): void =>
      listener(payload);
    ipcRenderer.on(Channels.capabilityPackTrackProgress, handler);
    return () => ipcRenderer.removeListener(Channels.capabilityPackTrackProgress, handler);
  },
  onCapabilityPackRelocationProgress: (
    listener: (message: CapabilityPackRelocationProgressWire) => void,
  ) => {
    const handler = (
      _event: IpcRendererEvent,
      payload: CapabilityPackRelocationProgressWire,
    ): void => listener(payload);
    ipcRenderer.on(Channels.capabilityPackRelocationProgress, handler);
    return () => ipcRenderer.removeListener(Channels.capabilityPackRelocationProgress, handler);
  },
  // Music sourcing. Note what does NOT cross this bridge: no provider URL, in
  // either direction. The renderer asks by `remoteId` and main does the network,
  // so there is no provider origin the renderer could be made to reach.
  musicSearch: (query: string, limit?: number) =>
    ipcRenderer.invoke(Channels.musicSearch, query, limit) as Promise<MusicSearchResult>,
  musicPreview: (remoteId: string) =>
    ipcRenderer.invoke(Channels.musicPreview, remoteId) as Promise<MusicPreviewResult>,
  musicDownload: (request: MusicDownloadRequest) =>
    ipcRenderer.invoke(Channels.musicDownload, request) as Promise<MusicDownloadResult>,
  musicDownloadCancel: (operationId: string) => {
    ipcRenderer.send(Channels.musicDownloadCancel, operationId);
  },
  onMusicDownloadProgress: (listener: (message: MusicDownloadProgressWire) => void) => {
    const handler = (_event: IpcRendererEvent, payload: MusicDownloadProgressWire): void =>
      listener(payload);
    ipcRenderer.on(Channels.musicDownloadProgress, handler);
    return () => ipcRenderer.removeListener(Channels.musicDownloadProgress, handler);
  },
  // Stock sourcing. Same property as music, and worth restating because it is
  // the one thing that must not erode: no provider URL crosses this bridge in
  // either direction, and neither does the API key.
  stockSearch: (request: StockSearchRequest) =>
    ipcRenderer.invoke(Channels.stockSearch, request) as Promise<StockSearchResult>,
  stockThumbnail: (remoteId: string) =>
    ipcRenderer.invoke(Channels.stockThumbnail, remoteId) as Promise<StockBytesResult>,
  stockPreview: (remoteId: string) =>
    ipcRenderer.invoke(Channels.stockPreview, remoteId) as Promise<StockBytesResult>,
  stockDownload: (request: StockDownloadRequest) =>
    ipcRenderer.invoke(Channels.stockDownload, request) as Promise<StockDownloadResult>,
  stockDownloadCancel: (operationId: string) => {
    ipcRenderer.send(Channels.stockDownloadCancel, operationId);
  },
  onStockDownloadProgress: (listener: (message: StockDownloadProgressWire) => void) => {
    const handler = (_event: IpcRendererEvent, payload: StockDownloadProgressWire): void =>
      listener(payload);
    ipcRenderer.on(Channels.stockDownloadProgress, handler);
    return () => ipcRenderer.removeListener(Channels.stockDownloadProgress, handler);
  },
  stockQuota: () => ipcRenderer.invoke(Channels.stockQuota) as Promise<StockQuotaSnapshot>,
  onStockQuotaChanged: (listener: (snapshot: StockQuotaSnapshot) => void) => {
    const handler = (_event: IpcRendererEvent, payload: StockQuotaSnapshot): void =>
      listener(payload);
    ipcRenderer.on(Channels.stockQuotaChanged, handler);
    return () => ipcRenderer.removeListener(Channels.stockQuotaChanged, handler);
  },
  openProject: (path: string) =>
    ipcRenderer.invoke(Channels.projectOpen, path) as Promise<ProjectOpenResult>,
  projectSnapshot: (projectId: string) =>
    ipcRenderer.invoke(Channels.projectSnapshot, projectId) as Promise<ProjectOpenResult>,
  openProjectDialog: () =>
    ipcRenderer.invoke(Channels.projectOpenDialog) as Promise<ProjectOpenResult>,
  saveProject: (path: string, project: unknown, expectedRevision?: number) =>
    ipcRenderer.invoke(
      Channels.projectSave,
      path,
      project,
      expectedRevision,
    ) as Promise<ProjectSaveResult>,
  saveProjectDefault: (project: unknown, expectedRevision?: number) =>
    ipcRenderer.invoke(
      Channels.projectSaveDefault,
      project,
      expectedRevision,
    ) as Promise<ProjectSaveResult>,
  commitProjectPatch: (request: ProjectPatchCommitRequest) =>
    ipcRenderer.invoke(Channels.projectCommitPatch, request) as Promise<ProjectPatchCommitResult>,
  projectsDir: () => ipcRenderer.invoke(Channels.projectsDir) as Promise<string>,
  revealProject: (path: string) =>
    ipcRenderer.invoke(Channels.projectReveal, path) as Promise<RevealResult>,
  recentProjects: () => ipcRenderer.invoke(Channels.projectRecent) as Promise<RecentProject[]>,
  exportVideo: (req: ExportRequest) =>
    ipcRenderer.invoke(Channels.renderExport, req) as Promise<ExportResult>,
  exportVideoStart: (req: ExportRequest) =>
    ipcRenderer.invoke(Channels.renderExportStart, req) as Promise<string>,
  exportVideoCancel: (requestId: string) =>
    ipcRenderer.send(Channels.renderExportCancel, requestId),
  onExportProgress: (listener: (message: ExportProgressMessage) => void) => {
    const handler = (_event: IpcRendererEvent, payload: ExportProgressMessage): void =>
      listener(payload);
    ipcRenderer.on(Channels.renderExportProgress, handler);
    return () => ipcRenderer.removeListener(Channels.renderExportProgress, handler);
  },
  exportSaveAs: (req: ExportSaveAsRequest) =>
    ipcRenderer.invoke(Channels.exportSaveAs, req) as Promise<ExportSaveAsResult>,
  importMedia: (req: MediaImportRequest) =>
    ipcRenderer.invoke(Channels.mediaImport, req) as Promise<MediaImportResult>,
  importMediaChunk: (req: MediaImportChunkRequest) =>
    ipcRenderer.invoke(Channels.mediaImportChunk, req) as Promise<MediaImportChunkResult>,
  importAsset: (req: ImportAssetRequest) =>
    ipcRenderer.invoke(Channels.mediaImportAsset, req) as Promise<ImportAssetResult>,
  analyzeReference: (req: AnalyzeReferenceRequest) =>
    ipcRenderer.invoke(Channels.referencesAnalyze, req) as Promise<AnalyzeReferenceResult>,
  transcribe: (req: TranscriptionRequest) =>
    ipcRenderer.invoke(Channels.transcribe, req) as Promise<TranscriptionResult>,
  aiChat: (req: AiRequest) => ipcRenderer.invoke(Channels.aiChat, req) as Promise<AiTextResult>,
  aiPlan: (req: AiRequest) => ipcRenderer.invoke(Channels.aiPlan, req) as Promise<AiTextResult>,
  aiEdit: (req: AiRequest) => ipcRenderer.invoke(Channels.aiEdit, req) as Promise<AiEditResult>,
  aiProviders: () => ipcRenderer.invoke(Channels.aiProviders) as Promise<AiProviderInfo[]>,
  aiConfigGet: () => ipcRenderer.invoke(Channels.aiConfigGet) as Promise<AiConfig>,
  aiConfigSet: (update: AiConfigUpdate) =>
    ipcRenderer.invoke(Channels.aiConfigSet, update) as Promise<AiConfig>,
  visualIndex: (request: VisualIndexRequest) =>
    ipcRenderer.invoke(Channels.visualIndex, request) as Promise<VisualIndexResult | undefined>,
  onProjectChanged: (listener: (event: ProjectChangedEvent) => void) => {
    const handler = (_event: IpcRendererEvent, payload: ProjectChangedEvent): void =>
      listener(payload);
    ipcRenderer.on(Channels.projectChanged, handler);
    return () => ipcRenderer.removeListener(Channels.projectChanged, handler);
  },
  conversationsList: () =>
    ipcRenderer.invoke(Channels.conversationsList) as Promise<ConversationSummary[]>,
  conversationsLoad: (id: string) =>
    ipcRenderer.invoke(Channels.conversationsLoad, id) as Promise<unknown | null>,
  conversationsSave: (record: ConversationRecord) =>
    ipcRenderer.invoke(Channels.conversationsSave, record) as Promise<ConversationSaveResult>,
  conversationsDelete: (id: string) =>
    ipcRenderer.invoke(Channels.conversationsDelete, id) as Promise<ConversationSaveResult>,
  aiStreamStart: (request: AiStreamRequest) =>
    ipcRenderer.invoke(Channels.aiStreamStart, request) as Promise<string>,
  aiStreamAbort: (requestId: string) => ipcRenderer.send(Channels.aiStreamAbort, requestId),
  aiStreamAnswer: (requestId: string, answer: AiStreamAnswerMessage) =>
    ipcRenderer.send(Channels.aiStreamAnswer, requestId, answer),
  onAiStreamEvent: (listener: (message: AiStreamEventMessage) => void) => {
    const handler = (_event: IpcRendererEvent, payload: AiStreamEventMessage): void =>
      listener(payload);
    ipcRenderer.on(Channels.aiStreamEvent, handler);
    return () => ipcRenderer.removeListener(Channels.aiStreamEvent, handler);
  },
  runStart: (request: DurableRunStartRequest) =>
    ipcRenderer.invoke(Channels.runStart, request) as Promise<DurableRunAccepted>,
  runCommand: (request: DurableRunCommandRequest) =>
    ipcRenderer.invoke(Channels.runCommand, request) as Promise<DurableRunAccepted>,
  runSnapshot: (request: DurableRunSnapshotRequest) =>
    ipcRenderer.invoke(Channels.runSnapshot, request) as Promise<DurableRunSnapshot | null>,
  runSubscribe: (request: DurableRunSubscribeRequest) =>
    ipcRenderer.invoke(Channels.runSubscribe, request) as Promise<DurableRunSubscription>,
  runUnsubscribe: (subscriptionId: string) =>
    ipcRenderer.send(Channels.runUnsubscribe, subscriptionId),
  runAck: (request: DurableRunAckRequest) => ipcRenderer.send(Channels.runAck, request),
  onRunEvent: (listener: (message: DurableRunEventMessage) => void) => {
    const handler = (_event: IpcRendererEvent, payload: DurableRunEventMessage): void =>
      listener(payload);
    ipcRenderer.on(Channels.runEvent, handler);
    return () => ipcRenderer.removeListener(Channels.runEvent, handler);
  },
};

interface PreloadLocation {
  readonly protocol: string;
  readonly hostname: string;
  readonly port: string;
  readonly pathname: string;
}

/**
 * The preload executes for every navigation in this webContents. Never hand the
 * privileged IPC bridge to a page that is not FramePilot's packaged renderer or
 * the fixed local Vite development origin. This closes the trust-boundary gap where
 * a same-window navigation could otherwise retain a fresh preload bridge on an
 * attacker-controlled page.
 */
function isTrustedRendererLocation(location: PreloadLocation): boolean {
  if (location.protocol === 'file:') {
    const normalizedPath = decodeURIComponent(location.pathname).replace(/\\/g, '/');
    return normalizedPath.endsWith('/renderer/index.html');
  }
  return (
    location.protocol === 'http:' && location.hostname === 'localhost' && location.port === '5173'
  );
}

const currentLocation = (globalThis as typeof globalThis & { readonly location: PreloadLocation })
  .location;
if (isTrustedRendererLocation(currentLocation)) {
  contextBridge.exposeInMainWorld('framepilot', bridge);
}
