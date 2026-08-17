/**
 * Compact context-window progress for the AI workspace (ADR 0080).
 *
 * Context is workspace status, not message-composer content. The permanent surface is
 * therefore a small circular progress control in the AI header; exact token figures,
 * capacity and compaction detail remain available on hover/focus. This keeps the composer
 * dedicated to writing while preserving the reassurance that a shrinking prompt is not
 * lost durable memory.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AiEvent, ContextManifest } from '@framepilot/ai-sdk';
import { ContextDebugger, type ContextDebugInfo } from './ContextDebugger.js';

/**
 * What the UI knows about context right now. Kept as a value object (rather than the raw
 * event) so the indicator stays a pure projection and remains trivially testable.
 */
export interface ContextWindowState {
  readonly usedTokens: number;
  readonly contextWindow: number;
  readonly estimated: boolean;
  /** The full account of the latest request, when one has been emitted. */
  readonly manifest?: ContextManifest;
  /**
   * How many requests ago the prompt was last compacted, or `undefined` when it has not
   * been compacted in this conversation. Counted from the event log, so it survives a
   * reload with the conversation.
   */
  readonly requestsSinceCompaction?: number;
}

/** Nothing sent yet: an honest zero against no known model, not a fabricated capacity. */
const EMPTY_CONTEXT: ContextWindowState = { usedTokens: 0, contextWindow: 0, estimated: true };

/**
 * The phase of the current model request. Distinguished because one generic spinner for
 * all of them tells the user nothing, and a spinner shown while nothing is running reads
 * as instability.
 */
export type ContextPhase = 'idle' | 'assembling' | 'generating';

/**
 * The first substantive model request of the latest user turn owns the context meter.
 * Classifier/planner/repair calls are orchestration internals with intentionally different
 * prompts; allowing each one to replace the readout made the number jump throughout one
 * edit even though conversation memory was intact. The selected request may still replace
 * its estimate with provider-reported usage (same `requestId`), then remains stable until
 * the next user turn reaches its own substantive request.
 */
export function latestContextWindow(events: readonly AiEvent[] | undefined): ContextWindowState {
  if (!events) return EMPTY_CONTEXT;
  const contextEvents = events.filter(
    (event): event is Extract<AiEvent, { type: 'context_usage' }> => event.type === 'context_usage',
  );
  if (contextEvents.length === 0) return EMPTY_CONTEXT;

  const substantive = contextEvents.filter(
    (event) => event.manifest && event.manifest.requestId !== 'classify',
  );
  let selected = contextEvents.at(-1)!;
  if (substantive.length > 0) {
    const latestTurnId = substantive.at(-1)!.turnId;
    const latestTurn = substantive.filter((event) => event.turnId === latestTurnId);
    const primaryRequestId = latestTurn[0]!.manifest!.requestId;
    selected = latestTurn.filter((event) => event.manifest?.requestId === primaryRequestId).at(-1)!;
  }

  const distinctRequests: Array<{
    event: (typeof contextEvents)[number];
    key: string;
  }> = [];
  const seen = new Set<string>();
  for (const [index, event] of contextEvents.entries()) {
    const key = event.manifest
      ? `${event.turnId}:${event.manifest.requestId}`
      : `${event.turnId}:legacy:${index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    distinctRequests.push({ event, key });
  }
  const selectedEventIndex = contextEvents.indexOf(selected);
  const selectedKey = selected.manifest
    ? `${selected.turnId}:${selected.manifest.requestId}`
    : `${selected.turnId}:legacy:${selectedEventIndex}`;
  const selectedIndex = distinctRequests.findIndex((entry) => entry.key === selectedKey);
  let requestsSinceCompaction: number | undefined;
  for (let index = selectedIndex; index >= 0; index -= 1) {
    if (distinctRequests[index]?.event.manifest?.compaction.occurred) {
      requestsSinceCompaction = selectedIndex - index;
      break;
    }
  }
  return {
    usedTokens: Math.min(selected.contextWindow, Math.max(0, selected.usedTokens)),
    contextWindow: Math.max(1, selected.contextWindow),
    estimated: selected.estimated,
    ...(selected.manifest ? { manifest: selected.manifest } : {}),
    ...(requestsSinceCompaction !== undefined ? { requestsSinceCompaction } : {}),
  };
}

/**
 * What the request is doing right now, derived from the event log rather than tracked
 * separately — a second source of truth for "is it running" is how a spinner ends up
 * outliving its request.
 */
export function contextPhase(
  events: readonly AiEvent[] | undefined,
  running: boolean,
): ContextPhase {
  if (!running) return 'idle';
  if (!events) return 'assembling';
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index]?.type;
    if (type === 'assistant_delta' || type === 'assistant_message' || type === 'reasoning_delta') {
      return 'generating';
    }
    if (type === 'context_usage') return 'generating';
  }
  return 'assembling';
}

/** `17,004` → `17.0K`; small values stay exact so a tiny prompt is not rounded to "0K". */
function compactTokens(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  const scaled = value / 1_000;
  if (scaled >= 1_000) return `${Math.round(scaled / 100) / 10}M`;
  return `${scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10}K`;
}

/**
 * The compaction line, shown only when there is something to say. Silence is right when
 * the prompt has never been summarized: a "Never" row is a row that explains nothing.
 */
function compactionNote(state: ContextWindowState): string | undefined {
  const compaction = state.manifest?.compaction;
  if (compaction?.occurred) {
    return `Older history was summarized in this request (−${compactTokens(
      compaction.removedTokenEstimate,
    )} tokens).`;
  }
  if (state.requestsSinceCompaction === undefined) return undefined;
  const ago =
    state.requestsSinceCompaction === 1
      ? '1 request ago'
      : `${state.requestsSinceCompaction} requests ago`;
  return `Older history was summarized ${ago}.`;
}

export interface ContextWindowIndicatorProps {
  readonly value: ContextWindowState;
  readonly phase?: ContextPhase;
  /** Render into the AI header while keeping request ownership in the composer shell. */
  readonly placement?: 'inline' | 'header';
  /**
   * Development-mode inspector data. Passed only under `import.meta.env.DEV` by the
   * parent, so the build-environment decision lives at one call site and this component
   * stays a pure projection.
   */
  readonly debug?: ContextDebugInfo;
}

export function ContextWindowIndicator({
  value,
  phase = 'idle',
  placement = 'inline',
  debug,
}: ContextWindowIndicatorProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [headerHost, setHeaderHost] = useState<HTMLElement | null>(null);
  const tooltipId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const manifest = value.manifest;

  useEffect(() => {
    if (placement !== 'header') {
      setHeaderHost(null);
      return;
    }
    // There is one active AI rail. Portalling here avoids threading context-window props
    // through the 77KB sidebar shell solely for presentation, while keeping the indicator
    // semantically in the header and out of the message grid.
    setHeaderHost(document.querySelector<HTMLElement>('.ai-sidebar .ai-sidebar-header-right'));
  }, [placement]);

  // Escape dismisses a tooltip the pointer may be parked on; an outside pointer-down
  // dismisses one opened by tap, where there is no "mouse leave" to end the hover.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        buttonRef.current?.blur();
      }
    };
    const onPointer = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open]);

  const readout =
    value.contextWindow > 0
      ? `${compactTokens(value.usedTokens)}/${compactTokens(value.contextWindow)}`
      : '—';

  const ratio =
    value.contextWindow > 0
      ? Math.min(1, Math.max(0, value.usedTokens / value.contextWindow))
      : 0;
  const percent = Math.round(ratio * 100);

  const figures = useMemo(() => {
    if (value.contextWindow <= 0) return 'No request accounted for yet';
    return `${compactTokens(value.usedTokens)} of ${compactTokens(value.contextWindow)} tokens${
      manifest?.usage.calculationSource === 'provider_reported' ? ', reported' : ', estimated'
    }`;
  }, [manifest, value.contextWindow, value.usedTokens]);

  const spokenPhase =
    phase === 'assembling' ? 'Preparing context. ' : phase === 'generating' ? 'Generating. ' : '';

  const reserved = manifest?.usage.reservedOutputTokens ?? 0;
  const available = manifest?.usage.estimatedRemainingCapacity ?? 0;
  const compaction = compactionNote(value);

  const indicator = (
    <div
      className="ai-context"
      ref={rootRef}
      data-placement={placement}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        ref={buttonRef}
        className="ai-context-trigger"
        aria-label={`${spokenPhase}Context: ${figures}. ${percent}% used.`}
        aria-describedby={open ? tooltipId : undefined}
        data-phase={phase}
        data-estimated={value.estimated}
        data-empty={value.contextWindow <= 0}
        onClick={() => setOpen((v) => !v)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <svg className="ai-context-ring" viewBox="0 0 24 24" aria-hidden="true">
          <circle className="ai-context-ring-track" cx="12" cy="12" r="9" pathLength="100" />
          <circle
            className="ai-context-ring-value"
            cx="12"
            cy="12"
            r="9"
            pathLength="100"
            strokeDasharray={`${ratio * 100} ${100 - ratio * 100}`}
          />
        </svg>
        <span className="sr-only">{readout}</span>
      </button>

      {open ? (
        <div className="ai-context-panel" id={tooltipId} role="tooltip">
          <div className="ai-context-panel-head">
            <span className="ai-context-panel-title">Context</span>
            <span className="ai-context-percent tabular">{percent}%</span>
          </div>
          <p className="ai-context-figure">{figures}</p>
          {available > 0 || reserved > 0 ? (
            <p className="ai-context-line">
              {`${compactTokens(available)} still available · ${compactTokens(
                reserved,
              )} reserved for the reply`}
            </p>
          ) : null}
          {compaction ? <p className="ai-context-line">{compaction}</p> : null}
          <p className="ai-context-explain">
            This is the primary context request for your latest message. Internal planning and tool
            calls do not replace it; your project memory and committed decisions stay saved.
          </p>
          {debug ? <ContextDebugger debug={debug} /> : null}
        </div>
      ) : null}
    </div>
  );

  if (placement === 'header') return headerHost ? createPortal(indicator, headerHost) : null;
  return indicator;
}
