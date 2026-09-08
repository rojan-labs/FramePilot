/**
 * Dodo Payments license API client (main process).
 *
 * The three license endpoints we use are **public** — they authenticate with the
 * license key itself, not with a merchant API key — so nothing secret ships in
 * the desktop app:
 *
 *   Activate:   POST /licenses/activate    { license_key, name }
 *   Validate:   POST /licenses/validate    { license_key, license_key_instance_id? }
 *   Deactivate: POST /licenses/deactivate  { license_key, license_key_instance_id }
 *
 * `fetch` is injectable (defaults to the global) so the client is unit-testable
 * offline, exactly like `render/export-client.ts`; `main.ts` passes Electron's
 * `net.fetch` (proxy/cert aware).
 *
 * WHY the network flag on errors: a transport failure must NOT read as "this
 * license is bad" — the service keeps the cached record and lets the offline
 * grace window decide (see `license-gate.ts`).
 */

/** Which Dodo Payments environment the build sells against. */
export type DodoEnvironment = 'live' | 'test';

const API_BASE: Record<DodoEnvironment, string> = {
  live: 'https://live.dodopayments.com',
  test: 'https://test.dodopayments.com',
};

export interface DodoActivateResult {
  ok: true;
  /** License key instance id — required later to validate/deactivate this device. */
  instanceId: string;
}
export interface DodoValidateResult {
  ok: true;
  /** Authoritative answer from Dodo. `false` means revoked/expired/unknown. */
  valid: boolean;
}
export interface DodoDeactivateResult {
  ok: true;
}
export interface DodoError {
  ok: false;
  error: string;
  /** HTTP status when the API answered; absent for transport failures. */
  status?: number;
  /** True when the failure was a network/transport error (enables offline grace). */
  network?: boolean;
}

type FetchFn = typeof globalThis.fetch;

interface RequestOptions {
  environment: DodoEnvironment;
}

/**
 * Human-readable messages for the documented failure statuses. These are shown
 * verbatim in the activation card, so they say what to DO, not what broke.
 */
function messageForStatus(status: number, body: unknown): string {
  const fromBody = (body as { message?: string } | null)?.message;
  switch (status) {
    case 403:
      return 'This license key is no longer active. Check your subscription, or contact support.';
    case 404:
      return 'We could not find that license key. Check it for typos and try again.';
    case 422:
      return 'This license key has reached its activation limit. Deactivate FramePilot on another device first.';
    default:
      return fromBody ?? `Dodo Payments returned an error (HTTP ${status}).`;
  }
}

/** POST JSON to a public license endpoint, classifying transport vs. API errors. */
async function post(
  path: string,
  payload: Record<string, unknown>,
  { environment }: RequestOptions,
  fetchFn: FetchFn,
): Promise<{ ok: true; status: number; body: unknown } | DodoError> {
  let res: Response;
  try {
    res = await fetchFn(`${API_BASE[environment]}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    return { ok: false, error: (error as Error).message, network: true };
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    return { ok: false, error: messageForStatus(res.status, body), status: res.status };
  }
  return { ok: true, status: res.status, body };
}

/**
 * Activate a license key on this device, creating a license key instance.
 * `deviceName` is what the customer sees in their Dodo activation list, so make
 * it recognisable (hostname + platform).
 */
export async function activateLicense(
  opts: { environment: DodoEnvironment; licenseKey: string; deviceName: string },
  fetchFn: FetchFn = fetch,
): Promise<DodoActivateResult | DodoError> {
  const res = await post(
    '/licenses/activate',
    { license_key: opts.licenseKey, name: opts.deviceName },
    { environment: opts.environment },
    fetchFn,
  );
  if (!res.ok) return res;
  const instanceId = (res.body as { id?: unknown } | null)?.id;
  if (typeof instanceId !== 'string' || instanceId.length === 0) {
    return { ok: false, error: 'Activation succeeded but no instance id was returned.' };
  }
  return { ok: true, instanceId };
}

/**
 * Validate the license key (optionally scoped to this device's instance).
 *
 * A 403/404 is an AUTHORITATIVE "not valid" — the key was revoked, the
 * subscription lapsed, or the instance was deactivated elsewhere — so it maps to
 * `{ ok: true, valid: false }` rather than an error, and the gate closes.
 */
export async function validateLicense(
  opts: { environment: DodoEnvironment; licenseKey: string; instanceId?: string | undefined },
  fetchFn: FetchFn = fetch,
): Promise<DodoValidateResult | DodoError> {
  const res = await post(
    '/licenses/validate',
    {
      license_key: opts.licenseKey,
      ...(opts.instanceId ? { license_key_instance_id: opts.instanceId } : {}),
    },
    { environment: opts.environment },
    fetchFn,
  );
  if (!res.ok) {
    // 403 (inactive) / 404 (unknown key or instance) are authoritative answers.
    if (res.status === 403 || res.status === 404) return { ok: true, valid: false };
    return res;
  }
  return { ok: true, valid: (res.body as { valid?: unknown } | null)?.valid === true };
}

/**
 * Release this device's activation slot. Best-effort: the caller clears local
 * state either way, but succeeding here is what lets the customer re-activate on
 * a new machine without hitting the activation limit.
 */
export async function deactivateLicense(
  opts: { environment: DodoEnvironment; licenseKey: string; instanceId: string },
  fetchFn: FetchFn = fetch,
): Promise<DodoDeactivateResult | DodoError> {
  const res = await post(
    '/licenses/deactivate',
    { license_key: opts.licenseKey, license_key_instance_id: opts.instanceId },
    { environment: opts.environment },
    fetchFn,
  );
  if (!res.ok) return res;
  return { ok: true };
}
