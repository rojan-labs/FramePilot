/** Compatibility projection from legacy UI events into the canonical EditorRun lifecycle. */
import { isTerminalStatus, type AiEvent } from '../events.js';
import {
  EDITOR_RUN_LIFECYCLE_VERSION,
  EDITOR_RUN_ROUTE_POLICY,
  EDITOR_RUN_STAGES,
  createEditorRunLifecycle,
  reduceEditorRunStageEvent,
  type EditorRunLifecycleState,
  type EditorRunRoute,
  type EditorRunStage,
  type EditorRunStageEvent,
} from './editor-run-lifecycle.js';

export interface EditorRunProjectionOptions {
  readonly runId: string;
  readonly route: EditorRunRoute;
  readonly now: () => number;
  readonly emit: (event: EditorRunStageEvent) => void;
}

function projectedStage(event: AiEvent): EditorRunStage | undefined {
  switch (event.type) {
    case 'reasoning':
    case 'reasoning_delta':
    case 'assistant_delta':
    case 'assistant_message':
      return 'understand';
    case 'reference':
    case 'context_usage':
      return 'inspect';
    case 'plan':
      return 'plan';
    case 'tool_call':
    case 'tool_result':
    case 'timeline_action':
      return 'compile';
    case 'diff':
      return 'verify';
    default:
      return undefined;
  }
}

/**
 * Emits an append-only lifecycle side channel while preserving the legacy AiEvent stream.
 * Intervening stages are closed with explicit route-policy evidence, never silently skipped.
 */
export class EditorRunLifecycleProjector {
  private state: EditorRunLifecycleState;

  public constructor(private readonly options: EditorRunProjectionOptions) {
    this.state = createEditorRunLifecycle(options.runId, options.route);
    this.enter('understand', ['adapter:accepted']);
  }

  public observe(event: AiEvent): void {
    if (this.state.terminal) return;
    if (event.type === 'error') {
      this.settleActive('failed', event.message);
      return;
    }
    if (event.type === 'status' && isTerminalStatus(event.status)) {
      if (event.status === 'completed') {
        this.advanceThrough('review', [`legacy-status:${event.status}`]);
        this.enter('finalize', [`legacy-status:${event.status}`]);
        this.settleActive('completed');
      } else {
        this.settleActive(event.status === 'cancelled' ? 'cancelled' : 'failed', event.status);
      }
      return;
    }
    const stage = projectedStage(event);
    if (stage !== undefined) this.advanceThrough(stage, [`legacy-event:${event.type}`]);
  }

  public finishWithoutTerminal(reason: string): void {
    if (!this.state.terminal) this.settleActive('failed', reason);
  }

  public snapshot(): EditorRunLifecycleState {
    return this.state;
  }

  /** Close the canonical review stage with host-produced evidence lineage. */
  public recordReview(evidence: readonly string[]): void {
    if (!this.state.terminal) this.advanceThrough('review', evidence);
  }

  /** Enter the single bounded repair attempt after a completed failed review. */
  public beginRepair(evidence: readonly string[]): void {
    if (!this.state.terminal) this.enter('repair', evidence);
  }

  /** Close repair and re-enter compilation through the lifecycle's legal repair edge. */
  public completeRepair(evidence: readonly string[]): void {
    if (this.state.terminal || this.state.activeStage !== 'repair') return;
    this.settleActive('completed', undefined, evidence);
    this.enter('compile', evidence);
    this.settleActive('completed', undefined, evidence);
  }

  /** Settle an attempted repair that could not produce an acceptable patch. */
  public failRepair(
    reason: string,
    evidence: readonly string[],
    state: 'failed' | 'cancelled' = 'failed',
  ): void {
    if (this.state.terminal || this.state.activeStage !== 'repair') return;
    this.settleActive(state, reason, evidence);
  }

  /** Fail the canonical review stage; no later compatibility status may overwrite it. */
  public failReview(
    reason: string,
    evidence: readonly string[],
    state: 'failed' | 'cancelled' = 'failed',
  ): void {
    if (this.state.terminal) return;
    this.advanceThrough('verify', ['temporal-review:entered']);
    this.enter('review', evidence);
    this.settleActive(state, reason, evidence);
  }

  private event(
    stage: EditorRunStage,
    state: EditorRunStageEvent['state'],
    evidence: readonly string[],
    reason?: string,
  ): EditorRunStageEvent {
    return {
      schemaVersion: EDITOR_RUN_LIFECYCLE_VERSION,
      runId: this.options.runId,
      route: this.options.route,
      sequence: this.state.sequence + 1,
      stage,
      state,
      occurredAt: this.options.now(),
      attempt: Math.max(
        1,
        this.state.activeStage === 'repair'
          ? this.state.repairAttempt
          : this.state.repairAttempt + 1,
      ),
      evidence: [...evidence],
      ...(reason === undefined ? {} : { reason }),
    };
  }

  private apply(event: EditorRunStageEvent): void {
    this.state = reduceEditorRunStageEvent(this.state, event);
    this.options.emit(event);
  }

  private enter(stage: EditorRunStage, evidence: readonly string[]): void {
    this.apply(this.event(stage, 'entered', evidence));
  }

  private settleActive(
    state: 'completed' | 'failed' | 'cancelled',
    reason?: string,
    evidence: readonly string[] = [],
  ): void {
    const stage = this.state.activeStage;
    if (stage === undefined) return;
    this.apply(this.event(stage, state, evidence, reason));
  }

  private advanceThrough(target: EditorRunStage, evidence: readonly string[]): void {
    const targetIndex = EDITOR_RUN_STAGES.indexOf(target);
    const active = this.state.activeStage;
    if (active !== undefined) {
      if (EDITOR_RUN_STAGES.indexOf(active) > targetIndex) return;
      this.settleActive('completed', undefined, evidence);
    }
    const last = this.state.completedStages.at(-1);
    let index = last === undefined ? 0 : EDITOR_RUN_STAGES.indexOf(last) + 1;
    for (; index <= targetIndex; index += 1) {
      const stage = EDITOR_RUN_STAGES[index]!;
      if (stage === 'repair') continue;
      const disposition = EDITOR_RUN_ROUTE_POLICY[this.options.route][stage];
      this.enter(stage, [`route-policy:${disposition}`]);
      this.settleActive('completed', undefined, index === targetIndex ? evidence : []);
    }
  }
}
