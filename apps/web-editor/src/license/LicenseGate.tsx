/**
 * License gate — the 100%-paid app requires a valid subscription to run.
 *
 * Wraps the editor. On mount it asks the desktop bridge for the current license
 * status:
 *  - **No bridge** (plain browser / Vite dev / tests) → render children. The gate
 *    is an Electron-only concern; the browser build and the whole test suite are
 *    unaffected.
 *  - **valid** → render children (the editor).
 *  - **needs_activation** → the activation card: paste a key, activate against
 *    Freemius (in main), with a link to subscribe.
 *  - **invalid with a previously-stored key** (expired / cancelled subscription) →
 *    a "renew" card showing the masked key + expiry and a Renew CTA, while still
 *    allowing a different key to be entered.
 *
 * The license key is entered here and sent to main write-only; the key/token never
 * come back across the bridge — only a {@link LicenseStatus} projection does.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Film, KeyRound, RefreshCw } from 'lucide-react';
import type { LicenseStatus } from '@framepilot/shared-types';
import { getBridge, type RendererBridge } from '../editor/bridge.js';

/** Where to send users to purchase or renew a subscription. */
export const PRICING_URL = 'https://framepilot.app/pricing';

type GateState =
  | { phase: 'loading' }
  | { phase: 'bypass' }
  | { phase: 'gated'; status: LicenseStatus };

/** Format a Freemius/ISO date for display, tolerating parse failures. */
function formatExpiry(value: string | null): string | null {
  if (!value) return null;
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function LicenseGate({
  children,
  bridge = getBridge(),
}: {
  children: ReactNode;
  /** Injectable for tests; defaults to the real desktop bridge (or null). */
  bridge?: RendererBridge | null;
}) {
  const [state, setState] = useState<GateState>(() =>
    bridge ? { phase: 'loading' } : { phase: 'bypass' },
  );
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge
      .licenseStatus()
      .then((status) => {
        if (active) setState({ phase: 'gated', status });
      })
      .catch(() => {
        // If the status check itself fails, fail closed to the activation card.
        if (active) {
          setState({
            phase: 'gated',
            status: { status: 'needs_activation', licensed: false, expiresAt: null },
          });
        }
      });
    return () => {
      active = false;
    };
  }, [bridge]);

  const activate = useCallback(async () => {
    if (!bridge || !key.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const status = await bridge.licenseActivate({ licenseKey: key.trim() });
      if (status.licensed) {
        setState({ phase: 'gated', status });
      } else {
        setError(status.message ?? 'That license key could not be activated.');
      }
    } catch {
      setError('Could not reach the license server. Check your connection.');
    } finally {
      setBusy(false);
    }
  }, [bridge, key]);

  if (state.phase === 'bypass') return <>{children}</>;
  if (state.phase === 'gated' && state.status.licensed) return <>{children}</>;

  if (state.phase === 'loading') {
    // Branded splash while the license check runs: the same canvas background as
    // the app (no blank/white frame), the product mark, and a quiet progress
    // indicator — startup reads as intentional, never as a flash of broken UI.
    return (
      <div className="license-gate license-gate--splash">
        <div className="license-gate__splash" role="status" aria-label="Starting FramePilot">
          <span className="license-gate__splash-mark" aria-hidden>
            <Film size={26} />
          </span>
          <span className="license-gate__splash-name">FramePilot</span>
          <span className="license-gate__splash-bar" aria-hidden>
            <span className="license-gate__splash-fill" />
          </span>
        </div>
      </div>
    );
  }

  const status = state.phase === 'gated' ? state.status : undefined;
  const message = status?.message;
  // A stored (masked) key that is no longer valid means an expired/cancelled
  // subscription — show the "renew" variant rather than a cold activation card.
  const isRenew = status?.status === 'invalid' && Boolean(status.maskedKey);
  const expiry = formatExpiry(status?.expiresAt ?? null);

  return (
    <div className="license-gate">
      <div className="license-gate__card">
        <span className="license-gate__mark" aria-hidden>
          {isRenew ? <RefreshCw size={22} /> : <KeyRound size={22} />}
        </span>
        <h1 className="license-gate__title">
          {isRenew ? 'Your subscription has lapsed' : 'Activate FramePilot'}
        </h1>
        <p className="license-gate__subtitle">
          {isRenew
            ? 'Renew your subscription to keep editing, or enter a different license key below.'
            : 'Enter your license key to unlock the editor. You received it by email after subscribing.'}
        </p>

        {isRenew && (status.maskedKey || expiry) && (
          <dl className="license-gate__meta">
            {status.maskedKey && (
              <div className="license-gate__meta-row">
                <dt>License</dt>
                <dd>{status.maskedKey}</dd>
              </div>
            )}
            {expiry && (
              <div className="license-gate__meta-row">
                <dt>Ended</dt>
                <dd>{expiry}</dd>
              </div>
            )}
          </dl>
        )}

        {isRenew && (
          <a
            className="license-gate__button license-gate__button--link"
            href={PRICING_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Renew subscription
          </a>
        )}

        <form
          className="license-gate__form"
          onSubmit={(e) => {
            e.preventDefault();
            void activate();
          }}
        >
          <input
            className="license-gate__input"
            type="text"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="XXXX-XXXX-XXXX-XXXX"
            aria-label="License key"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
          {(error ?? (isRenew ? undefined : message)) && (
            <p className="license-gate__error" role="alert">
              {error ?? message}
            </p>
          )}
          <button
            type="submit"
            className={
              isRenew ? 'license-gate__button license-gate__button--ghost' : 'license-gate__button'
            }
            disabled={busy || key.trim().length === 0}
          >
            {busy ? 'Activating…' : isRenew ? 'Use a different key' : 'Activate license'}
          </button>
        </form>

        {!isRenew && (
          <p className="license-gate__hint">
            Don&rsquo;t have a license?{' '}
            <a
              className="license-gate__link"
              href={PRICING_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Get one here
            </a>
            .
          </p>
        )}
      </div>
    </div>
  );
}
