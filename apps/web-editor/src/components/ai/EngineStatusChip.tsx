/**
 * Analysis-engine reachability chip (plan P5.3).
 *
 * `analyze_silence`/`detect_scenes`/`detect_beats` need the Python sidecar; an
 * unreachable engine used to surface only as a post-run "no analysis engine is
 * connected" notice (`effect-runtime.ts`'s honest-fail branch, plan P5.1/P5.2).
 * This chip probes the sidecar on mount (and again when the tab regains focus,
 * in case a dev server was started/stopped meanwhile) so the user knows
 * *before* asking for a beat-sync montage whether it can run here — pairing
 * with the "model not ready" banner (`AiSidebar`'s `.ai-apikey`) that already
 * covers the model side of the same idea.
 *
 * Three states only; no polling loop (a focus re-check is enough to avoid a
 * stale "unreachable" chip without a background timer running forever).
 */
import { useEffect, useState } from 'react';
import { Wifi, WifiOff, ICON_SIZE } from '../icons.js';
import { probeEngineReachable, resolveEngineBaseUrl } from '../../editor/ai.js';

export type EngineStatus = 'unknown' | 'reachable' | 'unreachable';

export interface EngineStatusChipProps {
  /** Overridable for tests; defaults to {@link resolveEngineBaseUrl}. */
  readonly baseUrl?: string;
}

const STATUS_TONE: Record<EngineStatus, 'completed' | 'warning' | 'idle'> = {
  unknown: 'idle',
  reachable: 'completed',
  unreachable: 'warning',
};

const STATUS_LABEL: Record<EngineStatus, string> = {
  unknown: 'Checking analysis engine…',
  reachable: 'Analysis engine connected',
  unreachable: 'Analysis engine unreachable — silence/scene/beat detection will report honestly',
};

/** Status chip for the analysis-engine sidecar; probes `baseUrl` on mount + focus. */
export function EngineStatusChip({ baseUrl }: EngineStatusChipProps): JSX.Element {
  const resolvedBaseUrl = baseUrl ?? resolveEngineBaseUrl();
  const [status, setStatus] = useState<EngineStatus>('unknown');

  useEffect(() => {
    let cancelled = false;
    const check = (): void => {
      setStatus('unknown');
      void probeEngineReachable(resolvedBaseUrl).then((reachable) => {
        if (!cancelled) setStatus(reachable ? 'reachable' : 'unreachable');
      });
    };
    check();
    window.addEventListener('focus', check);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', check);
    };
  }, [resolvedBaseUrl]);

  const Icon = status === 'unreachable' ? WifiOff : Wifi;
  return (
    <div className="ai-engine-status" role="status">
      <span className="ai-tone" data-tone={STATUS_TONE[status]}>
        <Icon size={ICON_SIZE.sm} aria-hidden="true" />
        {STATUS_LABEL[status]}
      </span>
    </div>
  );
}
