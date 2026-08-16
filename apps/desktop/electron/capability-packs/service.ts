import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import {
  CapabilityPackInstallApprovalSchema,
  CapabilityPackInstallIdentitySchema,
  CapabilityPackProjectPinSchema,
  CapabilityPackStorageManager,
  artifactForPlatform,
  canonicalJson,
  capabilityPackIdentityKey,
  type CapabilityPackEvictionPlan,
  type CapabilityPackInstallApproval,
  type CapabilityPackRelease,
  type CapabilityPackProjectPin,
} from '@framepilot/capability-packs';
import {
  CapabilityPackInstaller,
  FileCapabilityPackCatalogTrust,
  FileCapabilityPackStore,
  prepareCapabilityPackRelocation,
  removeCommittedPackDirectory,
  type CapabilityPackRelocationProgress,
  type PreparedCapabilityPackRelocation,
  type TrustedCatalogKey,
} from '@framepilot/capability-packs/node';
import type {
  CapabilityPackActionResultWire,
  CapabilityPackEvictionApprovalWire,
  CapabilityPackEvictionPlanResultWire,
  CapabilityPackEvictionPlanWire,
  CapabilityPackIdentityWire,
  CapabilityPackInstallApprovalWire,
  CapabilityPackInstallProposalWire,
  CapabilityPackInstallStartResultWire,
  CapabilityPackProgressWire,
  CapabilityPackProposalResultWire,
  CapabilityPackStorageSnapshotWire,
  CapabilityPackProjectResolutionWire,
} from '@framepilot/shared-types';
import { createLogger } from '@framepilot/shared-types';
import { compareSemver, resolveInside } from './pack-paths.js';
import { CapabilityPackTrackingService } from './tracking.js';

const CATALOG_MAX_BYTES = 10 * 1024 * 1024;
const PROPOSAL_TTL_MS = 15 * 60 * 1_000;
const PLAN_TTL_MS = 15 * 60 * 1_000;
const LOCAL_WHISPER_PACK_ID = 'framepilot.local-whisper';
const LOCAL_WHISPER_CLI = 'bin/whisper-cli';
const LOCAL_WHISPER_MODEL_DIR = 'models';
const log = createLogger('desktop:capability-packs');

interface CachedProposal {
  readonly proposal: CapabilityPackInstallProposalWire;
  readonly release: CapabilityPackRelease;
  readonly catalogDigest: string;
  readonly expiresAt: number;
  readonly projectId?: string;
}

interface CachedEvictionPlan {
  readonly plan: CapabilityPackEvictionPlan;
  readonly wire: CapabilityPackEvictionPlanWire;
  readonly expiresAt: number;
}

interface InstallerAuthority {
  install(request: Parameters<CapabilityPackInstaller['install']>[0]): ReturnType<CapabilityPackInstaller['install']>;
}

export interface CapabilityPackDesktopServiceOptions {
  readonly rootPath: string;
  readonly catalogUrl?: string;
  readonly trustedRootKeys: readonly TrustedCatalogKey[];
  readonly appVersion: string;
  readonly platform?: { readonly os: 'darwin' | 'win32'; readonly arch: 'arm64' | 'x64' };
  readonly fetch?: typeof fetch;
  readonly installer?: InstallerAuthority;
  readonly now?: () => Date;
  readonly onProgress: (progress: CapabilityPackProgressWire) => void;
  readonly onInstalled?: (identity: CapabilityPackIdentityWire) => Promise<void>;
}

/** Main-process authority behind the validated Capability Pack IPC surface. */
export class CapabilityPackDesktopService {
  private readonly rootPath: string;
  private readonly catalogUrl: string | undefined;
  private readonly trustedRootKeys: readonly TrustedCatalogKey[];
  private readonly appVersion: string;
  private readonly platform: { readonly os: 'darwin' | 'win32'; readonly arch: 'arm64' | 'x64' };
  private readonly fetchImpl: typeof fetch;
  private readonly installer: InstallerAuthority;
  private readonly now: () => Date;
  private readonly onProgress: (progress: CapabilityPackProgressWire) => void;
  private readonly onInstalled: ((identity: CapabilityPackIdentityWire) => Promise<void>) | undefined;
  private readonly store: FileCapabilityPackStore;
  private readonly storageManager: CapabilityPackStorageManager;
  private readonly trust: FileCapabilityPackCatalogTrust;
  private readonly proposals = new Map<string, CachedProposal>();
  private readonly evictionPlans = new Map<string, CachedEvictionPlan>();
  private readonly installs = new Map<string, AbortController>();
  private relocating = false;
  private trackingService: CapabilityPackTrackingService | undefined;

  constructor(options: CapabilityPackDesktopServiceOptions) {
    this.rootPath = path.resolve(options.rootPath);
    this.catalogUrl = options.catalogUrl;
    this.trustedRootKeys = options.trustedRootKeys;
    this.appVersion = options.appVersion;
    this.platform = options.platform ?? hostPlatform();
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.onProgress = options.onProgress;
    this.onInstalled = options.onInstalled;
    this.store = new FileCapabilityPackStore(this.rootPath);
    this.storageManager = new CapabilityPackStorageManager(
      this.store,
      removeCommittedPackDirectory,
    );
    this.trust = new FileCapabilityPackCatalogTrust(this.rootPath, this.trustedRootKeys);
    this.installer = options.installer ?? new CapabilityPackInstaller(this.rootPath);
  }

  async storage(): Promise<CapabilityPackStorageSnapshotWire> {
    const [summary, records] = await Promise.all([this.storageManager.summary(), this.store.list()]);
    return {
      rootPath: this.rootPath,
      totalBytes: summary.totalBytes,
      installedBytes: summary.installedBytes,
      quarantinedBytes: summary.quarantinedBytes,
      pendingRemovalBytes: summary.pendingRemovalBytes,
      reclaimableBytes: summary.reclaimableBytes,
      projectUsage: summary.projectUsage,
      items: records.map((record) => ({
        identity: record.identity,
        state: record.state,
        installedBytes: record.installedBytes,
        lastUsedAt: record.lastUsedAt,
        pinnedProjectIds: record.pinnedProjectIds,
        activeLeaseCount: record.activeLeaseCount,
        health: record.health.status,
        ...(record.health.detail === undefined ? {} : { healthDetail: record.health.detail }),
      })),
    };
  }

  async reconcileProject(
    projectId: string,
    pins: readonly CapabilityPackProjectPin[],
  ): Promise<CapabilityPackProjectResolutionWire> {
    const dependencies = (await this.store.reconcileProjectPins(projectId, pins)).map(
      (dependency) => ({
        pin: dependency.pin,
        status: dependency.status,
        ...(dependency.identity === undefined ? {} : { identity: dependency.identity }),
        ...(dependency.detail === undefined ? {} : { detail: dependency.detail }),
      }),
    );
    const unavailable = dependencies.filter((dependency) => dependency.status !== 'ready');
    return {
      dependencies,
      renderBlocked: unavailable.some((dependency) => dependency.pin.requiredFor === 'render'),
      editBlocked: unavailable.some((dependency) => dependency.pin.requiredFor === 'edit'),
    };
  }

  /** Main-verified environment consumed by the bundled Python sidecar. */
  async runtimeEnvironment(): Promise<Readonly<Record<string, string>>> {
    const candidates = (await this.store.list())
      .filter((record) =>
        record.identity.id === LOCAL_WHISPER_PACK_ID &&
        record.state === 'installed' &&
        record.health.status === 'healthy'
      )
      .sort((left, right) => compareSemver(right.identity.version, left.identity.version));
    const record = candidates[0];
    if (record === undefined) return {};
    const installRoot = resolveInside(this.rootPath, record.installRelativePath);
    const cli = resolveInside(installRoot, LOCAL_WHISPER_CLI);
    const modelDir = resolveInside(installRoot, LOCAL_WHISPER_MODEL_DIR);
    if (!(await lstat(cli)).isFile() || !(await lstat(modelDir)).isDirectory()) {
      throw new Error('Installed local Whisper pack is missing its signed runtime files.');
    }
    return {
      FRAMEPILOT_WHISPER_CLI: cli,
      FRAMEPILOT_ASR_MODEL_DIR: modelDir,
    };
  }

  get storageRoot(): string {
    return this.rootPath;
  }

  async relocateStorage(
    destinationRoot: string,
    commitAuthority: (prepared: PreparedCapabilityPackRelocation) => Promise<void>,
    onProgress?: (progress: CapabilityPackRelocationProgress) => void,
  ): Promise<PreparedCapabilityPackRelocation> {
    if (this.relocating) throw new Error('Capability Pack storage is already moving.');
    if (this.installs.size > 0) throw new Error('Wait for Capability Pack installs to finish before moving storage.');
    this.relocating = true;
    try {
      const prepared = await prepareCapabilityPackRelocation({
        sourceRoot: this.rootPath,
        destinationRoot,
        sourceStore: this.store,
        ...(onProgress === undefined ? {} : { onProgress }),
      });
      await commitAuthority(prepared);
      return prepared;
    } finally {
      this.relocating = false;
    }
  }

  /**
   * The tracking-worker authority, bound to this service's own store and root.
   *
   * Exposed as a method rather than by handing out the store, so pack execution
   * keeps going through one place that holds leases and proposes installs.
   */
  tracking(): CapabilityPackTrackingService {
    this.trackingService ??= new CapabilityPackTrackingService({
      storageRoot: this.rootPath,
      store: this.store,
      platform: this.platform,
      propose: (capabilityId) => this.propose(capabilityId),
    });
    return this.trackingService;
  }

  async propose(capabilityIdInput: unknown): Promise<CapabilityPackProposalResultWire> {
    try {
      if (this.relocating) return failure('relocation_in_progress', 'Wait for Capability Pack storage to finish moving.');
      const capabilityId = boundedIdentifier(capabilityIdInput, 'capability id');
      const catalog = await this.loadCatalog();
      const release = selectRelease(catalog.catalog.releases, capabilityId, this.appVersion);
      if (release === undefined) {
        return failure('platform_unsupported', `No compatible signed pack provides ${capabilityId}.`);
      }
      if (release.dependencies.length > 0) {
        return failure('dependency_missing', 'This pack has unresolved pack dependencies.');
      }
      return this.cacheProposal(
        release,
        createHash('sha256').update(canonicalJson(catalog.catalog)).digest('hex'),
        catalog.catalog.expiresAt,
        capabilityId,
      );
    } catch (error) {
      return failure(errorCode(error), errorMessage(error));
    }
  }

  async proposeProjectDependency(
    projectIdInput: unknown,
    pinInput: unknown,
  ): Promise<CapabilityPackProposalResultWire> {
    try {
      if (this.relocating) return failure('relocation_in_progress', 'Wait for Capability Pack storage to finish moving.');
      const projectId = boundedIdentifier(projectIdInput, 'project id');
      const pin = CapabilityPackProjectPinSchema.parse(pinInput);
      const catalog = await this.loadCatalog();
      const release = catalog.catalog.releases.find((candidate) =>
        candidate.id === pin.id &&
        candidate.version === pin.version &&
        candidate.releaseDigest === pin.releaseDigest
      );
      if (release === undefined) {
        return failure('dependency_missing', `Pinned release ${pin.id} ${pin.version} is not in the signed catalog.`);
      }
      if (
        compareSemver(this.appVersion, release.compatibility.minAppVersion) < 0 ||
        (release.compatibility.maxAppVersionExclusive !== undefined &&
          compareSemver(this.appVersion, release.compatibility.maxAppVersionExclusive) >= 0)
      ) {
        return failure('platform_unsupported', 'The pinned release is incompatible with this FramePilot version.');
      }
      if (!pin.capabilities.every((capability) => release.capabilities.includes(capability))) {
        return failure('catalog_invalid', 'Pinned capabilities do not match the signed release.');
      }
      if (release.dependencies.length > 0) {
        return failure('dependency_missing', 'This pack has unresolved pack dependencies.');
      }
      return this.cacheProposal(
        release,
        createHash('sha256').update(canonicalJson(catalog.catalog)).digest('hex'),
        catalog.catalog.expiresAt,
        `${projectId}/${pin.id}/${pin.releaseDigest}`,
        projectId,
      );
    } catch (error) {
      return failure(errorCode(error), errorMessage(error));
    }
  }

  private cacheProposal(
    release: CapabilityPackRelease,
    catalogDigest: string,
    catalogExpiresAt: string,
    proposalScope: string,
    projectId?: string,
  ): CapabilityPackProposalResultWire {
      const artifact = artifactForPlatform(release, this.platform);
      if (artifact === undefined) {
        return failure(
          'platform_unsupported',
          `No ${this.platform.os}/${this.platform.arch} artifact is published.`,
        );
      }
      const identity = CapabilityPackInstallIdentitySchema.parse({
        id: release.id,
        version: release.version,
        releaseDigest: release.releaseDigest,
        artifactDigest: artifact.sha256,
        os: artifact.os,
        arch: artifact.arch,
      });
      const proposalId = createHash('sha256')
        .update(`${catalogDigest}/${proposalScope}/${capabilityPackIdentityKey(identity)}`)
        .digest('hex');
      const proposal: CapabilityPackInstallProposalWire = {
        proposalId,
        identity,
        capabilities: release.capabilities,
        displayName: release.displayName,
        description: release.description,
        downloadBytes: artifact.sizeBytes,
        installedBytes: artifact.unpackedSizeBytes,
        licenses: release.licenses.map((license) => ({
          spdx: license.spdx,
          name: license.name,
          noticeUrl: license.noticeUrl,
        })),
        privacy: release.privacy,
      };
      this.proposals.set(proposalId, {
        proposal,
        release,
        catalogDigest,
        expiresAt: Math.min(
          this.now().getTime() + PROPOSAL_TTL_MS,
          Date.parse(catalogExpiresAt),
        ),
        ...(projectId === undefined ? {} : { projectId }),
      });
      return { ok: true, proposal };
  }

  startInstall(approvalInput: unknown): CapabilityPackInstallStartResultWire {
    try {
      if (this.relocating) return failure('relocation_in_progress', 'Wait for Capability Pack storage to finish moving.');
      const approval = validateWireApproval(approvalInput);
      const cached = this.proposals.get(approval.proposalId);
      if (cached === undefined || cached.expiresAt <= this.now().getTime()) {
        return failure('approval_required', 'Install proposal is missing or expired; review it again.');
      }
      const proposal = cached.proposal;
      if (
        identityKeyWire(approval.identity) !== identityKeyWire(proposal.identity) ||
        approval.approvedSizeBytes !== proposal.downloadBytes ||
        approval.approvedMediaEgress !== proposal.privacy.mediaLeavesDevice ||
        !sameStrings(
          approval.approvedLicenseSpdx,
          proposal.licenses.map((license) => license.spdx),
        )
      ) {
        return failure('approval_required', 'Approval no longer matches the displayed signed proposal.');
      }
      const artifact = artifactForPlatform(cached.release, this.platform);
      if (artifact === undefined) return failure('platform_unsupported', 'Platform artifact disappeared.');
      const parsedApproval: CapabilityPackInstallApproval = CapabilityPackInstallApprovalSchema.parse({
        identity: approval.identity,
        approvedSizeBytes: approval.approvedSizeBytes,
        approvedLicenseSpdx: approval.approvedLicenseSpdx,
        approvedMediaEgress: approval.approvedMediaEgress,
        approvedAt: approval.approvedAt,
      });
      const operationId = randomUUID();
      const controller = new AbortController();
      this.installs.set(operationId, controller);
      this.proposals.delete(approval.proposalId);
      void this.installer
        .install({
          operationId,
          identity: parsedApproval.identity,
          release: cached.release,
          artifact,
          catalogDigest: cached.catalogDigest,
          approval: parsedApproval,
          signal: controller.signal,
          onProgress: (progress) => {
            if (progress.phase === 'installed' && cached.projectId !== undefined) return;
            this.onProgress({
              operationId: progress.operationId,
              identity: progress.identity,
              phase: progress.phase,
              completedBytes: progress.completedBytes,
              totalBytes: progress.totalBytes,
              ...(progress.detail === undefined ? {} : { detail: progress.detail }),
              ...(progress.errorCode === undefined ? {} : { errorCode: progress.errorCode }),
            });
          },
        })
        .then(async (installed) => {
          if (cached.projectId !== undefined) {
            await this.store.pin(installed.identity, cached.projectId);
            this.onProgress({
              operationId,
              identity: installed.identity,
              phase: 'installed',
              completedBytes: artifact.sizeBytes,
              totalBytes: artifact.sizeBytes,
            });
          }
          try {
            await this.onInstalled?.(installed.identity);
          } catch (error) {
            log.error('post-install runtime refresh failed', {
              packId: installed.identity.id,
              error: errorMessage(error),
            });
          }
        })
        .catch((error: unknown) => {
          const cancelled = controller.signal.aborted || errorCode(error) === 'download_cancelled';
          this.onProgress({
            operationId,
            identity: parsedApproval.identity,
            phase: cancelled ? 'cancelled' : 'failed',
            completedBytes: 0,
            totalBytes: artifact.sizeBytes,
            errorCode: errorCode(error),
            detail: errorMessage(error).slice(0, 1_000),
          });
        })
        .finally(() => this.installs.delete(operationId));
      return { ok: true, operationId };
    } catch (error) {
      return failure(errorCode(error), errorMessage(error));
    }
  }

  cancel(operationIdInput: unknown): void {
    if (typeof operationIdInput !== 'string') return;
    this.installs.get(operationIdInput)?.abort();
  }

  async planEviction(requestedBytesInput: unknown): Promise<CapabilityPackEvictionPlanResultWire> {
    try {
      if (this.relocating) return failure('relocation_in_progress', 'Wait for Capability Pack storage to finish moving.');
      if (!Number.isSafeInteger(requestedBytesInput) || (requestedBytesInput as number) <= 0) {
        return failure('catalog_invalid', 'Requested cleanup bytes must be a positive safe integer.');
      }
      const plan = await this.storageManager.planEviction(requestedBytesInput as number);
      const planId = randomUUID();
      const wire: CapabilityPackEvictionPlanWire = {
        planId,
        requestedBytes: plan.requestedBytes,
        reclaimableBytes: plan.reclaimableBytes,
        sufficient: plan.sufficient,
        candidates: plan.candidates,
      };
      this.evictionPlans.set(planId, {
        plan,
        wire,
        expiresAt: this.now().getTime() + PLAN_TTL_MS,
      });
      return { ok: true, plan: wire };
    } catch (error) {
      return failure(errorCode(error), errorMessage(error));
    }
  }

  async executeEviction(approvalInput: unknown): Promise<CapabilityPackActionResultWire> {
    try {
      if (this.relocating) return failure('relocation_in_progress', 'Wait for Capability Pack storage to finish moving.');
      const approval = validateEvictionApproval(approvalInput);
      const cached = this.evictionPlans.get(approval.planId);
      if (cached === undefined || cached.expiresAt <= this.now().getTime()) {
        return failure('approval_required', 'Cleanup plan is missing or expired; review it again.');
      }
      this.evictionPlans.delete(approval.planId);
      await this.storageManager.executeEviction(cached.plan, approval.approvedIdentityKeys);
      return { ok: true, storage: await this.storage() };
    } catch (error) {
      return failure(errorCode(error), errorMessage(error));
    }
  }

  private async loadCatalog() {
    if (this.catalogUrl === undefined || this.trustedRootKeys.length === 0) {
      throw new Error('Capability Pack catalog is not configured in this build.');
    }
    const url = new URL(this.catalogUrl);
    if (url.protocol !== 'https:') throw new Error('Capability Pack catalog URL must use HTTPS.');
    const response = await this.fetchImpl(url, { redirect: 'error' });
    if (!response.ok) throw new Error(`Capability Pack catalog returned HTTP ${response.status}.`);
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > CATALOG_MAX_BYTES) {
      throw new Error('Capability Pack catalog exceeds its size limit.');
    }
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > CATALOG_MAX_BYTES) throw new Error('Capability Pack catalog exceeds its size limit.');
    let input: unknown;
    try {
      input = JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new Error('Capability Pack catalog is not valid JSON.');
    }
    return await this.trust.verifyAndAdvance(input, this.now());
  }
}

function selectRelease(
  releases: readonly CapabilityPackRelease[],
  capabilityId: string,
  appVersion: string,
): CapabilityPackRelease | undefined {
  return releases
    .filter(
      (release) =>
        release.capabilities.includes(capabilityId) &&
        compareSemver(appVersion, release.compatibility.minAppVersion) >= 0 &&
        (release.compatibility.maxAppVersionExclusive === undefined ||
          compareSemver(appVersion, release.compatibility.maxAppVersionExclusive) < 0),
    )
    .sort((left, right) => {
      const channelOrder = { stable: 0, beta: 1, nightly: 2 } as const;
      return channelOrder[left.channel] - channelOrder[right.channel] || compareSemver(right.version, left.version);
    })[0];
}

function hostPlatform(): { os: 'darwin' | 'win32'; arch: 'arm64' | 'x64' } {
  if ((process.platform !== 'darwin' && process.platform !== 'win32') ||
      (process.arch !== 'arm64' && process.arch !== 'x64')) {
    throw new Error(`Capability Packs do not support ${process.platform}/${process.arch}.`);
  }
  return { os: process.platform, arch: process.arch };
}

function validateWireApproval(input: unknown): CapabilityPackInstallApprovalWire {
  if (typeof input !== 'object' || input === null) throw new Error('Install approval is invalid.');
  const candidate = input as Partial<CapabilityPackInstallApprovalWire>;
  const identity = CapabilityPackInstallIdentitySchema.parse(candidate.identity);
  if (
    typeof candidate.proposalId !== 'string' || !/^[0-9a-f]{64}$/u.test(candidate.proposalId) ||
    !Number.isSafeInteger(candidate.approvedSizeBytes) || (candidate.approvedSizeBytes ?? 0) <= 0 ||
    !Array.isArray(candidate.approvedLicenseSpdx) ||
    typeof candidate.approvedMediaEgress !== 'boolean' ||
    typeof candidate.approvedAt !== 'string'
  ) {
    throw new Error('Install approval fields are invalid.');
  }
  const parsed = CapabilityPackInstallApprovalSchema.parse({ ...candidate, identity });
  return { proposalId: candidate.proposalId, ...parsed };
}

function validateEvictionApproval(input: unknown): CapabilityPackEvictionApprovalWire {
  if (typeof input !== 'object' || input === null) throw new Error('Cleanup approval is invalid.');
  const candidate = input as Partial<CapabilityPackEvictionApprovalWire>;
  if (
    typeof candidate.planId !== 'string' ||
    !Array.isArray(candidate.approvedIdentityKeys) ||
    candidate.approvedIdentityKeys.some((key) => typeof key !== 'string' || key.length > 512)
  ) {
    throw new Error('Cleanup approval fields are invalid.');
  }
  return { planId: candidate.planId, approvedIdentityKeys: candidate.approvedIdentityKeys as string[] };
}

function boundedIdentifier(input: unknown, label: string): string {
  if (
    typeof input !== 'string' ||
    input.length === 0 ||
    input.length > 128 ||
    !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(input)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return input;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return new Set(left).size === left.length &&
    JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function identityKeyWire(identity: CapabilityPackIdentityWire): string {
  return [identity.id, identity.version, identity.os, identity.arch, identity.artifactDigest].join('/');
}

function failure(code: string, error: string): { ok: false; code: string; error: string } {
  return { ok: false, code, error };
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'catalog_invalid';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
