/**
 * Auto-update channel scaffold (plan Phase 3.1 — "Auto-update channel scaffold").
 *
 * This is intentionally a *scaffold*: it defines the release channels and how
 * one is selected, plus a provider seam to wire a real updater (e.g.
 * electron-updater) behind later — without pulling in that dependency now
 * (adding it requires a license review per AGENTS.md §8). The pure channel
 * resolution is unit-tested so the wiring contract is stable.
 */

/** Release channels the desktop app can follow. */
export const UPDATE_CHANNELS = ['stable', 'beta'] as const;

/** A single valid release channel. */
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

/** Environment variable that overrides the default channel. */
export const UPDATE_CHANNEL_ENV = 'FRAMEPILOT_UPDATE_CHANNEL';

/** The channel used when none is configured. */
export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = 'stable';

/** True if `value` is a recognised {@link UpdateChannel}. */
export function isUpdateChannel(value: string | undefined): value is UpdateChannel {
  return value !== undefined && (UPDATE_CHANNELS as readonly string[]).includes(value);
}

/**
 * Resolve the active update channel from an environment map.
 *
 * @param env - Environment variables (e.g. `process.env`). An unset or
 *   unrecognised {@link UPDATE_CHANNEL_ENV} falls back to
 *   {@link DEFAULT_UPDATE_CHANNEL} rather than erroring — a typo must never wedge
 *   the app onto a non-existent channel.
 * @returns The channel to follow for updates.
 */
export function resolveUpdateChannel(env: Record<string, string | undefined>): UpdateChannel {
  const configured = env[UPDATE_CHANNEL_ENV];
  return isUpdateChannel(configured) ? configured : DEFAULT_UPDATE_CHANNEL;
}

/** Outcome of an update check. */
export interface UpdateCheckResult {
  channel: UpdateChannel;
  updateAvailable: boolean;
  /** Version string when an update is available, else null. */
  version: string | null;
}

/**
 * Seam for a concrete updater. The default scaffold reports "no update"; a real
 * provider (electron-updater) is injected once the dependency is approved.
 */
export interface UpdateProvider {
  checkForUpdates(channel: UpdateChannel): Promise<UpdateCheckResult>;
}

/** No-op provider used until a real auto-updater is wired in. */
export const noopUpdateProvider: UpdateProvider = {
  checkForUpdates: (channel) => Promise.resolve({ channel, updateAvailable: false, version: null }),
};
