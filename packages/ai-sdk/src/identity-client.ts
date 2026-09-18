/**
 * Face-recognition consent and identity deletion, per project (P15, MD-7).
 *
 * Recognising the same person across shots is biometric processing, so it is off until the
 * editor turns it on for THIS project, it happens locally, and one action deletes everything
 * it stored. The state lives in the project brain (`/brain/identity*` on the engine sidecar);
 * this is the typed door to it for the desktop executor and the sidebar.
 *
 * The one rule this client exists to keep: **an unreadable answer is NO consent.** A timeout,
 * a sidecar that is down, a malformed body — all of them return `consent: false`, never a
 * cached or assumed `true`. Consent the app failed to disprove is not consent.
 */
import { z } from 'zod/v4';
import { createLogger } from '@framepilot/shared-types';

const log = createLogger('ai-sdk:identity-client');

/** A consent read blocks a tool call, so it fails fast rather than hanging the run. */
export const IDENTITY_TIMEOUT_MS = 5_000;

export const identityStateSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullish(),
  consent: z.boolean(),
  people: z.number().int().nonnegative(),
  deletedPeople: z.number().int().nonnegative().nullish(),
  deletedShots: z.number().int().nonnegative().nullish(),
});

export interface IdentityState {
  /** False when the brain could not be read; `consent` is then always false. */
  readonly available: boolean;
  readonly consent: boolean;
  /** How many people the project's brain can currently tell apart. */
  readonly people: number;
  /** Set by {@link IdentityClient.deleteAll}: how many people were removed. */
  readonly deletedPeople?: number;
  readonly reason?: string;
}

export interface IdentityClientOptions {
  readonly baseUrl: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}

const unavailable = (reason: string): IdentityState => ({
  available: false,
  consent: false,
  people: 0,
  reason,
});

export class IdentityClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(options: IdentityClientOptions) {
    this.baseUrl = options.baseUrl;
    this.fetchFn = options.fetchFn ?? (globalThis.fetch.bind(globalThis) as typeof fetch);
    this.timeoutMs = options.timeoutMs ?? IDENTITY_TIMEOUT_MS;
  }

  /** The project's current state. Never throws; unreadable is `consent: false`. */
  public state(projectId: string): Promise<IdentityState> {
    return this.call(`/brain/identity?projectId=${encodeURIComponent(projectId)}`);
  }

  /** Record the editor's opt-in or opt-out. */
  public setConsent(projectId: string, consent: boolean): Promise<IdentityState> {
    return this.call('/brain/identity/consent', { projectId, consent });
  }

  /** Delete every stored identity in one action. Consent is withdrawn with it. */
  public deleteAll(projectId: string): Promise<IdentityState> {
    return this.call('/brain/identity/delete', { projectId });
  }

  private async call(path: string, body?: Record<string, unknown>): Promise<IdentityState> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return unavailable(`The engine answered ${String(response.status)}.`);
      const parsed = identityStateSchema.safeParse(await response.json());
      if (!parsed.success)
        return unavailable('The engine sent an identity state FramePilot could not read.');
      if (!parsed.data.available)
        return unavailable(parsed.data.reason ?? 'The project brain is unavailable.');
      log.action('identityState', {
        path: path.split('?')[0],
        consent: parsed.data.consent,
        people: parsed.data.people,
      });
      return {
        available: true,
        consent: parsed.data.consent,
        people: parsed.data.people,
        ...(typeof parsed.data.deletedPeople === 'number'
          ? { deletedPeople: parsed.data.deletedPeople }
          : {}),
      };
    } catch (cause) {
      log.warn('identity state unreadable — treated as no consent', {
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return unavailable('The engine could not be reached.');
    }
  }
}
