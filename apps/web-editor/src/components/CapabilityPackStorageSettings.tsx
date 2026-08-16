import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@framepilot/ui';
import type {
  CapabilityPackEvictionPlanWire,
  CapabilityPackProgressWire,
  CapabilityPackRelocationProgressWire,
  CapabilityPackStorageSnapshotWire,
} from '@framepilot/shared-types';
import { getBridge } from '../editor/bridge.js';

const DEFAULT_CLEANUP_BYTES = 1024 * 1024 * 1024;

export function CapabilityPackStorageSettings(): JSX.Element {
  const bridge = getBridge();
  const [storage, setStorage] = useState<CapabilityPackStorageSnapshotWire | null>(null);
  const [plan, setPlan] = useState<CapabilityPackEvictionPlanWire | null>(null);
  const [requestedGiB, setRequestedGiB] = useState(1);
  const [progress, setProgress] = useState<CapabilityPackProgressWire | null>(null);
  const [relocation, setRelocation] = useState<CapabilityPackRelocationProgressWire | null>(null);
  const [previousRoot, setPreviousRoot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!bridge?.capabilityPackStorage) return;
    try {
      setStorage(await bridge.capabilityPackStorage());
      setError(null);
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  }, [bridge]);

  useEffect(() => {
    void load();
    if (!bridge?.onCapabilityPackProgress) return;
    const stopInstall = bridge.onCapabilityPackProgress((message) => {
      setProgress(message);
      if (message.phase === 'installed' || message.phase === 'cancelled' || message.phase === 'failed') {
        void load();
      }
    });
    const stopRelocation = bridge.onCapabilityPackRelocationProgress?.((message) => {
      setRelocation(message);
    });
    return () => {
      stopInstall();
      stopRelocation?.();
    };
  }, [bridge, load]);

  const moveStorage = async (): Promise<void> => {
    if (!bridge?.capabilityPackRelocate) return;
    setBusy(true);
    setError(null);
    setPreviousRoot(null);
    try {
      const result = await bridge.capabilityPackRelocate();
      if (!result.ok) {
        if (result.code !== 'cancelled') setError(result.error);
      } else {
        setStorage(result.storage);
        setPreviousRoot(result.previousRoot);
      }
    } catch (moveError) {
      setError(errorMessage(moveError));
    } finally {
      setRelocation(null);
      setBusy(false);
    }
  };

  const reviewCleanup = async (): Promise<void> => {
    if (!bridge?.capabilityPackPlanEviction) return;
    setBusy(true);
    setError(null);
    try {
      const requestedBytes = Math.max(
        1,
        Number.isFinite(requestedGiB)
          ? Math.round(requestedGiB * DEFAULT_CLEANUP_BYTES)
          : DEFAULT_CLEANUP_BYTES,
      );
      const result = await bridge.capabilityPackPlanEviction(requestedBytes);
      if (!result.ok) setError(result.error);
      else setPlan(result.plan);
    } catch (planError) {
      setError(errorMessage(planError));
    } finally {
      setBusy(false);
    }
  };

  const confirmCleanup = async (): Promise<void> => {
    if (!bridge?.capabilityPackExecuteEviction || plan === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await bridge.capabilityPackExecuteEviction({
        planId: plan.planId,
        approvedIdentityKeys: plan.candidates.map(({ identity }) => identityKey(identity)),
      });
      if (!result.ok) setError(result.error);
      else {
        setStorage(result.storage);
        setPlan(null);
      }
    } catch (executionError) {
      setError(errorMessage(executionError));
    } finally {
      setBusy(false);
    }
  };

  const activeBytes = useMemo(
    () => storage?.items.filter((item) => item.state === 'installed').reduce((sum, item) => sum + item.installedBytes, 0) ?? 0,
    [storage],
  );

  if (!bridge?.capabilityPackStorage) {
    return (
      <div className="settings-empty-state">
        <div>
          <strong>On-demand packs are managed by the desktop app</strong>
          <span>The browser build never downloads native models or workers.</span>
        </div>
      </div>
    );
  }

  return (
    <>
      <section className="settings-group" aria-label="Capability Pack storage">
        <header className="settings-group-head">
          <h4>On-demand capabilities</h4>
          <p>Large models and native workers stay outside the app and download only after approval.</p>
        </header>
        <div className="settings-group-controls">
          <div className="capability-storage-summary" aria-live="polite">
            <div><span>Used</span><strong>{formatBytes(storage?.totalBytes ?? 0)}</strong></div>
            <div><span>Active</span><strong>{formatBytes(activeBytes)}</strong></div>
            <div><span>Reclaimable</span><strong>{formatBytes(storage?.reclaimableBytes ?? 0)}</strong></div>
          </div>
          <div className="setting-row setting-row--stack">
            <span className="setting-field-label">Storage location</span>
            <code className="capability-storage-path">{storage?.rootPath ?? 'Loading…'}</code>
            <span className="setting-note">Moving copies and validates everything first. The old folder is retained for manual recovery.</span>
            <div className="capability-cleanup-actions">
              <Button type="button" variant="ghost" disabled={busy} onClick={() => void moveStorage()}>
                Move storage…
              </Button>
            </div>
          </div>
          {relocation ? (
            <div className="capability-pack-progress" role="status">
              <span>Moving storage</span>
              <strong>{formatBytes(relocation.copiedBytes)} / {formatBytes(relocation.totalBytes)}</strong>
              {relocation.currentRelativePath ? <small>{relocation.currentRelativePath}</small> : null}
            </div>
          ) : null}
          {previousRoot ? (
            <div className="settings-callout" role="status">
              Storage moved successfully. The previous copy remains at <code>{previousRoot}</code> until you remove it manually.
            </div>
          ) : null}
          {progress ? (
            <div className="capability-pack-progress" role="status">
              <span>{progress.phase.replaceAll('_', ' ')}</span>
              <strong>{formatBytes(progress.completedBytes)} / {formatBytes(progress.totalBytes)}</strong>
              {progress.detail ? <small>{progress.detail}</small> : null}
            </div>
          ) : null}
          {error ? <div className="settings-callout" role="alert">{error}</div> : null}
        </div>
      </section>

      <section className="settings-group" aria-label="Installed Capability Packs">
        <header className="settings-group-head">
          <h4>Installed packs</h4>
          <p>Project pins and live worker leases prevent removal.</p>
        </header>
        <div className="settings-group-controls">
          {storage === null ? (
            <div className="settings-empty-state"><div><strong>Reading storage…</strong></div></div>
          ) : storage.items.length === 0 ? (
            <div className="settings-empty-state">
              <div><strong>No packs installed</strong><span>FramePilot will propose one when a requested capability needs it.</span></div>
            </div>
          ) : (
            <ul className="capability-pack-list" aria-label="Installed Capability Packs">
              {storage.items.map((item) => (
                <li key={identityKey(item.identity)}>
                  <div>
                    <strong>{item.identity.id}</strong>
                    <span>v{item.identity.version} · {item.identity.os}/{item.identity.arch}</span>
                    <small>
                      {item.state} · {item.health} · {formatBytes(item.installedBytes)}
                      {item.pinnedProjectIds.length > 0 ? ` · pinned by ${item.pinnedProjectIds.length} project(s)` : ''}
                      {item.activeLeaseCount > 0 ? ` · ${item.activeLeaseCount} active worker(s)` : ''}
                    </small>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="settings-group" aria-label="Review Capability Pack cleanup">
        <header className="settings-group-head">
          <h4>Review cleanup</h4>
          <p>Planning never deletes. Quarantined packs come first, then least recently used versions.</p>
        </header>
        <div className="settings-group-controls">
          <div className="setting-row">
            <div className="setting-text">
              <span className="setting-label">Space to reclaim</span>
              <span className="setting-hint">Pinned and running packs are excluded.</span>
            </div>
            <input
              className="setting-number"
              aria-label="Space to reclaim in GiB"
              type="number"
              min={0.1}
              max={1000}
              step={0.1}
              value={requestedGiB}
              onChange={(event) => setRequestedGiB(Number(event.target.value))}
            />
          </div>
          <div className="capability-cleanup-actions">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => void reviewCleanup()}>
              Review cleanup
            </Button>
          </div>
          {plan ? (
            <div className="capability-cleanup-review" role="region" aria-label="Cleanup confirmation">
              <strong>{formatBytes(plan.reclaimableBytes)} across {plan.candidates.length} pack(s)</strong>
              <span>{plan.sufficient ? 'Requested space is covered.' : 'Not enough unpinned space is available.'}</span>
              <ul>
                {plan.candidates.map((candidate) => (
                  <li key={identityKey(candidate.identity)}>
                    {candidate.identity.id} v{candidate.identity.version} — {formatBytes(candidate.installedBytes)}
                  </li>
                ))}
              </ul>
              <div className="capability-cleanup-actions">
                <Button type="button" variant="ghost" disabled={busy} onClick={() => setPlan(null)}>Cancel</Button>
                <Button type="button" disabled={busy || plan.candidates.length === 0} onClick={() => void confirmCleanup()}>
                  Remove exactly these packs
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </>
  );
}

function identityKey(identity: {
  readonly id: string;
  readonly version: string;
  readonly os: string;
  readonly arch: string;
  readonly artifactDigest: string;
}): string {
  return [identity.id, identity.version, identity.os, identity.arch, identity.artifactDigest].join('/');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
