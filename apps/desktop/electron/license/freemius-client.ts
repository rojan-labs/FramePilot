/**
 * Freemius license API client (main process).
 *
 * These two endpoints are public (they authenticate with the license key + device
 * uid, not the product secret), so the desktop app needs only the product id — no
 * secret key ships in the app. `fetch` is injectable (defaults to the global) so
 * the client is unit-testable offline, exactly like `render/export-client.ts`;
 * `main.ts` passes Electron's `net.fetch` (proxy/cert aware).
 *
 * Activate:  POST /v1/products/{productId}/licenses/activate.json?uid&license_key
 * Validate:  GET  /v1/products/{productId}/installs/{installId}/license.json?uid&license_key
 */

const FREEMIUS_API = 'https://api.freemius.com';

export interface FreemiusActivateResult {
  ok: true;
  installId: string;
  installApiToken?: string | undefined;
  isValid: boolean;
  expiration: string | null;
}
export interface FreemiusValidateResult {
  ok: true;
  isValid: boolean;
  expiration: string | null;
}
export interface FreemiusError {
  ok: false;
  error: string;
  /** True when the failure was a network/transport error (enables offline grace). */
  network?: boolean;
}

type FetchFn = typeof globalThis.fetch;

function q(uid: string, licenseKey: string): string {
  return `uid=${encodeURIComponent(uid)}&license_key=${encodeURIComponent(licenseKey)}`;
}

/** Best-effort extraction of a human error message from a Freemius error body. */
function errorFrom(body: unknown, fallback: string): string {
  const err = (body as { error?: { message?: string } } | null)?.error;
  return err?.message ?? fallback;
}

/** Activate a license key on this device, creating a Freemius install. */
export async function activateLicense(
  opts: { productId: string; uid: string; licenseKey: string },
  fetchFn: FetchFn = fetch,
): Promise<FreemiusActivateResult | FreemiusError> {
  const { productId, uid, licenseKey } = opts;
  const url = `${FREEMIUS_API}/v1/products/${encodeURIComponent(productId)}/licenses/activate.json?${q(uid, licenseKey)}`;
  let res: Response;
  try {
    res = await fetchFn(url, { method: 'POST' });
  } catch (error) {
    return { ok: false, error: (error as Error).message, network: true };
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body) {
    return { ok: false, error: errorFrom(body, `Activation failed (HTTP ${res.status}).`) };
  }
  const installId = String(body['install_id'] ?? body['id'] ?? '');
  if (!installId) {
    return { ok: false, error: 'Activation succeeded but no install id was returned.' };
  }
  const token = body['install_api_token'] ?? body['api_token'];
  return {
    ok: true,
    installId,
    installApiToken: typeof token === 'string' ? token : undefined,
    isValid: body['is_cancelled'] !== true,
    expiration: normalizeExpiration(body['expiration']),
  };
}

/** Validate the current license state for an existing install. */
export async function validateLicense(
  opts: { productId: string; installId: string; uid: string; licenseKey: string },
  fetchFn: FetchFn = fetch,
): Promise<FreemiusValidateResult | FreemiusError> {
  const { productId, installId, uid, licenseKey } = opts;
  const url = `${FREEMIUS_API}/v1/products/${encodeURIComponent(productId)}/installs/${encodeURIComponent(installId)}/license.json?${q(uid, licenseKey)}`;
  let res: Response;
  try {
    res = await fetchFn(url);
  } catch (error) {
    return { ok: false, error: (error as Error).message, network: true };
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body) {
    return { ok: false, error: errorFrom(body, `Validation failed (HTTP ${res.status}).`) };
  }
  return {
    ok: true,
    isValid: body['is_cancelled'] !== true,
    expiration: normalizeExpiration(body['expiration']),
  };
}

function normalizeExpiration(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
