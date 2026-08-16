/**
 * The development-mode context inspector (ADR 0080).
 *
 * ## Why a diff, and not just a dump
 *
 * "Why did context usage change between these two requests?" is the question the old
 * indicator could not answer, and a snapshot of the current request cannot answer it
 * either — you need the one before it. So the inspector's centre of gravity is the
 * comparison: which sections were added, removed, grew or shrank, and what that adds up
 * to. The full snapshot is there underneath, for when the diff points somewhere and you
 * want the detail.
 *
 * Never shipped to creators. `AiSidebar` passes `debug` only under `import.meta.env.DEV`,
 * so the decision lives at one call site and this component stays a pure renderer —
 * which is also what makes it testable without stubbing the build environment.
 */
import { useMemo } from 'react';
import {
  type AiEvent,
  type ContextManifest,
  diffManifests,
  parseWorkingState,
} from '@framepilot/ai-sdk';

export interface ContextDebugInfo {
  readonly conversationId: string;
  /** The request before the latest, when the conversation has had two. */
  readonly previous?: ContextManifest;
  readonly latest: ContextManifest;
  /** Latest machine-authored run ledger from the event stream. */
  readonly working?: unknown;
}

/**
 * The two most recent DISTINCT requests in a conversation, newest last.
 *
 * Distinct by `requestId`, not by event: one call emits its manifest twice — once as a
 * pre-send estimate and again when the provider settles — and comparing a request with
 * itself would report every section as unchanged and explain nothing. The settled
 * manifest wins for each request, because it carries the reported figures.
 */
export function recentManifests(events: readonly AiEvent[] | undefined): {
  previous?: ContextManifest;
  latest?: ContextManifest;
} {
  if (!events) return {};
  const byRequest = new Map<string, ContextManifest>();
  for (const event of events) {
    if (event.type !== 'context_usage' || !event.manifest) continue;
    // Later wins: the settled manifest supersedes the estimate for the same request.
    byRequest.set(event.manifest.requestId, event.manifest);
  }
  const all = [...byRequest.values()];
  const latest = all.at(-1);
  const previous = all.at(-2);
  return {
    ...(previous ? { previous } : {}),
    ...(latest ? { latest } : {}),
  };
}

function compact(value: number): string {
  if (Math.abs(value) < 1_000) return String(Math.round(value));
  return `${Math.round(value / 100) / 10}K`;
}

function signed(value: number): string {
  return value > 0 ? `+${compact(value)}` : compact(value);
}

export function ContextDebugger({ debug }: { readonly debug: ContextDebugInfo }): JSX.Element {
  const { conversationId, previous, latest } = debug;
  const working = useMemo(() => parseWorkingState(debug.working), [debug.working]);
  const diff = useMemo(
    () => (previous ? diffManifests(previous, latest) : undefined),
    [previous, latest],
  );

  return (
    <div className="ai-context-debug">
      <p className="ai-context-panel-title">Context inspector · dev</p>
      <dl className="ai-context-rows">
        <div className="ai-context-row">
          <dt>Conversation</dt>
          <dd>{conversationId}</dd>
        </div>
        <div className="ai-context-row">
          <dt>Request</dt>
          <dd>{latest.requestId}</dd>
        </div>
        <div className="ai-context-row">
          <dt>Run</dt>
          <dd>{latest.memory?.runId ?? '—'}</dd>
        </div>
        <div className="ai-context-row">
          <dt>Revision</dt>
          <dd>{latest.memory ? String(latest.memory.projectRevision) : '—'}</dd>
        </div>
        <div className="ai-context-row">
          <dt>Provider · model</dt>
          <dd>{`${latest.provider} · ${latest.model}`}</dd>
        </div>
        <div className="ai-context-row">
          <dt>Estimated in</dt>
          <dd>{compact(latest.usage.estimatedInputTokensBeforeSend)}</dd>
        </div>
        <div className="ai-context-row">
          <dt>Reported in</dt>
          <dd>
            {latest.usage.providerReportedInputTokens === undefined
              ? 'not reported'
              : compact(latest.usage.providerReportedInputTokens)}
          </dd>
        </div>
        <div className="ai-context-row">
          <dt>Cached in</dt>
          <dd>
            {latest.usage.cachedInputTokens === undefined
              ? '—'
              : compact(latest.usage.cachedInputTokens)}
          </dd>
        </div>
        <div className="ai-context-row">
          <dt>Reserved out</dt>
          <dd>{compact(latest.usage.reservedOutputTokens)}</dd>
        </div>
        <div className="ai-context-row">
          <dt>Compaction</dt>
          <dd>
            {latest.compaction.occurred
              ? `−${compact(latest.compaction.removedTokenEstimate)} (${latest.compaction.removedSections.join(', ')})`
              : 'none'}
          </dd>
        </div>
      </dl>

      <p className="ai-context-panel-title">Run integrity</p>
      <dl className="ai-context-rows">
        <div className="ai-context-row">
          <dt>Stage · version</dt>
          <dd>{working ? `${working.stage} · ${working.version}` : 'unavailable'}</dd>
        </div>
        <div className="ai-context-row">
          <dt>Objective</dt>
          <dd>{working?.objective.outcome ? 'persisted' : 'missing'}</dd>
        </div>
        <div className="ai-context-row">
          <dt>Plan</dt>
          <dd>{working?.plan.status ?? 'unavailable'}</dd>
        </div>
        <div className="ai-context-row">
          <dt>Decisions</dt>
          <dd>{working ? String(working.plan.decisionIds.length) : '—'}</dd>
        </div>
        <div className="ai-context-row">
          <dt>Operations</dt>
          <dd>
            {working
              ? `${working.operations.filter((operation) => operation.status === 'succeeded').length} succeeded`
              : '—'}
          </dd>
        </div>
        <div className="ai-context-row">
          <dt>Orphaned</dt>
          <dd>
            {working
              ? String(
                  working.operations.filter((operation) => operation.status === 'orphaned').length,
                )
              : '—'}
          </dd>
        </div>
        <div className="ai-context-row">
          <dt>Verification</dt>
          <dd>{working ? `${working.verifications.length} recorded` : '—'}</dd>
        </div>
        <div className="ai-context-row">
          <dt>Integrity</dt>
          <dd>{working?.integrity.status ?? 'unavailable'}</dd>
        </div>
        <div className="ai-context-row">
          <dt>Blocking diagnostics</dt>
          <dd>
            {working
              ? String(
                  working.integrity.diagnostics.filter((diagnostic) => diagnostic.blocking).length,
                )
              : '—'}
          </dd>
        </div>
      </dl>

      <p className="ai-context-panel-title">Since previous request</p>
      {diff ? (
        <>
          <p className="ai-context-debug-total">
            {`Input ${signed(diff.inputTokenDelta)}`}
            {diff.modelChanged ? ' · model changed' : ''}
          </p>
          <ul className="ai-context-sections">
            {diff.sections
              .filter((section) => section.change !== 'unchanged')
              .map((section) => (
                <li key={section.label} data-change={section.change}>
                  <span className="ai-context-section-label">{section.label}</span>
                  <span className="ai-context-section-tokens">
                    {`${section.change} · ${signed(section.afterTokens - section.beforeTokens)}`}
                  </span>
                </li>
              ))}
          </ul>
          {diff.sections.every((section) => section.change === 'unchanged') ? (
            <p className="ai-context-debug-total">
              Every section is identical — the change, if any, is outside the itemised breakdown.
            </p>
          ) : null}
        </>
      ) : (
        <p className="ai-context-debug-total">
          First accounted request in this conversation — nothing to compare against yet.
        </p>
      )}
    </div>
  );
}
