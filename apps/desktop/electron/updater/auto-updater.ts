/**
 * electron-updater–backed {@link UpdateProvider} (plan/PLAN.md Phase 8 —
 * "Signed desktop builds … auto-update").
 *
 * The concrete `autoUpdater` from `electron-updater` is **injected** rather than
 * imported at module load, so this logic is unit-testable without the dependency
 * (and the test graph never resolves an Electron-only module). `main.ts` performs
 * the real dynamic `import('electron-updater')` in packaged builds and passes its
 * `autoUpdater` here. The update feed + signing are configured in
 * `electron-builder.yml`; see docs/guides/release-checklist-v1.md for the secrets.
 */
import type { UpdateChannel, UpdateCheckResult, UpdateProvider } from './channel.js';

/** The slice of electron-updater's `autoUpdater` we depend on (keeps it mockable). */
export interface AutoUpdaterLike {
  channel: string | null;
  autoDownload: boolean;
  checkForUpdates(): Promise<{ updateInfo?: { version?: string } } | null>;
}

/**
 * Wrap an electron-updater `autoUpdater` as an {@link UpdateProvider}. Sets the
 * release channel and disables silent auto-download (the user approves installs).
 */
export function createAutoUpdaterProvider(updater: AutoUpdaterLike): UpdateProvider {
  updater.autoDownload = false;
  return {
    async checkForUpdates(channel: UpdateChannel): Promise<UpdateCheckResult> {
      updater.channel = channel;
      const result = await updater.checkForUpdates();
      const version = result?.updateInfo?.version ?? null;
      return { channel, updateAvailable: version !== null, version };
    },
  };
}
