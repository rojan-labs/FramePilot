/**
 * The AI composer's context readout (ADR 0080).
 *
 * ## What this shows, and why so little
 *
 * The composer is a writing surface, not a dashboard. The one thing worth a permanent
 * pixel is how full the current request is — `2.1K/1M` — so the readout is that string
 * and nothing else: no ring, no percentage, no expandable ledger competing with the
 * send button.
 *
 * The number still legitimately moves between requests (a large tool result is replaced
 * by a summary; a skill loads for one stage and not the next; the budgeter trims a
 * tier), and a drop from 60K to 12K reads as "my conversation was erased" if nothing
 * explains it. That explanation lives in a hover/focus tooltip: the exact figures, the
 * room left, and the sentence that answers the actual fear — the prompt shrank, the
 * durable memory did not. Hover is enough for a reassurance nobody needs mid-sentence,
 * and keyboard focus opens the same tooltip so it is not mouse-only.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AiEvent, ContextManifest } from '@framepilot/ai-sdk';
import { ContextDebugger, type ContextDebugInfo } from './ContextDebugger.js';

/**
 * What the composer knows about context right now. Kept as a value object (rather than
 * the raw event) so the component stays a pure projection and is trivially testable.
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
 * The first substantive model request of the latest user turn owns the composer meter.
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
    // Any model output since the last context_usage means the request landed.
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
  debug,
}: ContextWindowIndicatorProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const tooltipId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const manifest = value.manifest;

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

  /** The whole permanent surface: used over capacity, e.g. `2.1K/1M`. */
  const readout =
    value.contextWindow > 0
      ? `${compactTokens(value.usedTokens)}/${compactTokens(value.contextWindow)}`
      : '—';

  const figures = useMemo(() => {
    if (value.contextWindow <= 0) return 'No request accounted for yet';
    return `${compactTokens(value.usedTokens)} of ${compactTokens(value.contextWindow)} tokens${
      manifest?.usage.calculationSource === 'provider_reported' ? ', reported' : ', estimated'
    }`;
  }, [manifest, value.contextWindow, value.usedTokens]);

  // Speech gets the phase and the figures spelled out; sight already has the digits.
  const spokenPhase =
    phase === 'assembling' ? 'Preparing context. ' : phase === 'generating' ? 'Generating. ' : '';

  const reserved = manifest?.usage.reservedOutputTokens ?? 0;
  const available = manifest?.usage.estimatedRemainingCapacity ?? 0;
  const compaction = compactionNote(value);

  return (
    <div
      className="ai-context"
      ref={rootRef}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        ref={buttonRef}
        className="ai-context-trigger"
        aria-label={`${spokenPhase}Context: ${figures}.`}
        aria-describedby={open ? tooltipId : undefined}
        data-phase={phase}
        data-estimated={value.estimated}
        // Tap has no hover: a click toggles the same tooltip on touch devices.
        onClick={() => setOpen((v) => !v)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        {readout}
      </button>

      {open ? (
        <div className="ai-context-panel" id={tooltipId} role="tooltip">
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
}
