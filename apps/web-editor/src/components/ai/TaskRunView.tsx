/**
 * Parallel "what's running" view (P8.2, plan/AGENT-NATIVE-COMPLETION-PLAN.md P8.2;
 * plan/AI-ORCHESTRATION-REDESIGN.md §12, K0.2).
 *
 * `ConversationView.tasks` already folds `task_started`/`task_finished`/
 * `effect_progress` into a per-task view (see `@framepilot/ai-sdk`'s `events.ts`) —
 * this is purely the rendering the pipeline was missing. Cards are grouped by
 * running vs settled rather than laid out in arrival order, so two tasks that are
 * BOTH mid-flight (e.g. `detect_beats ∥ detect_scenes`) read as visibly concurrent
 * instead of a sequential list — the whole point of surfacing `tasks` separately
 * from the linear `nodes` stream. `label` is already human text set by the caller
 * (e.g. "Analyze silence · A-roll") — no tool-name humanizing needed here.
 *
 * Pure presentational component: the parent (`AiSidebar`) owns fetching
 * `view.tasks` and renders nothing extra when there are none (additive — every
 * existing sidebar affordance is untouched by mounting this).
 */
import { useId, useState } from 'react';
import type { TaskView } from '@framepilot/ai-sdk';
import { AlertTriangle, Ban, Check, ChevronDown, ICON_SIZE, X } from '../icons.js';
import { toolStatusTone } from './statusTone.js';

/** Human runtime: sub-second in ms, then one-decimal seconds (mirrors EventNode.tsx). */
function formatRuntime(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Human label for a settled/running task status shown as its trailing meta text. */
const TASK_STATUS_LABEL: Record<TaskView['status'], string> = {
  running: 'Running…',
  completed: 'Done',
  warning: 'Warning',
  failed: 'Failed',
  cancelled: 'Stopped',
};

function TaskStatusIcon({ status }: { status: TaskView['status'] }): JSX.Element {
  const tone = toolStatusTone(status);
  return (
    <span
      className="ai-task-status"
      data-tone={tone}
      role="img"
      aria-label={TASK_STATUS_LABEL[status]}
    >
      {status === 'running' ? (
        <span className="ai-spinner" aria-hidden="true" />
      ) : status === 'completed' ? (
        <Check size={ICON_SIZE.sm} aria-hidden="true" />
      ) : status === 'warning' ? (
        <AlertTriangle size={ICON_SIZE.sm} aria-hidden="true" />
      ) : status === 'cancelled' ? (
        <Ban size={ICON_SIZE.sm} aria-hidden="true" />
      ) : (
        <X size={ICON_SIZE.sm} aria-hidden="true" />
      )}
    </span>
  );
}

function TaskCard({ task }: { task: TaskView }): JSX.Element {
  const running = task.status === 'running';
  return (
    <div className="ai-task-card" data-tone={toolStatusTone(task.status)}>
      <TaskStatusIcon status={task.status} />
      <span className={running ? 'ai-task-label ai-shimmer-text' : 'ai-task-label'}>
        {task.label}
      </span>
      <span className="ai-task-meta">
        {task.runtimeMs !== undefined
          ? formatRuntime(task.runtimeMs)
          : TASK_STATUS_LABEL[task.status]}
      </span>
    </div>
  );
}

export interface TaskRunViewProps {
  /** `ConversationView.tasks` — omitted/empty renders nothing. */
  readonly tasks: readonly TaskView[];
}

/**
 * Renders the live DAG task set as simultaneous cards: every task still
 * `running` groups together (so concurrent work reads as concurrent), settled
 * tasks fold into a quieter trailing row once they finish. Renders nothing when
 * `tasks` is empty, so mounting this is a no-op for every run that never emits a
 * `task_started` event (today: the DAG scheduler, and the temporal review — which
 * announces itself precisely because it is the longest phase of an editing run).
 */
export function TaskRunView({ tasks }: TaskRunViewProps): JSX.Element | null {
  const bodyId = useId();
  const runKey = tasks[0]?.turnId ?? 'empty';
  const [disclosure, setDisclosure] = useState({ runKey, expanded: false });
  const expanded = disclosure.runKey === runKey && disclosure.expanded;
  if (tasks.length === 0) return null;
  const running = tasks.filter((task) => task.status === 'running');
  const settled = tasks.filter((task) => task.status !== 'running');
  const recent = running.at(-1) ?? tasks.at(-1);
  return (
    <section className="ai-tasks" data-expanded={expanded} aria-label="Run activity">
      <button
        type="button"
        className="ai-tasks-toggle"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setDisclosure({ runKey, expanded: !expanded })}
      >
        {/* "Activity", not "Plan": the plan accordion below is also headed "Plan"
            and shows the model's own steps, and two panels with one label read as
            the same thing rendered twice. This is what is running right now —
            including the phases that exist before any plan does. */}
        <span className="ai-plan-title">Activity</span>
        <span className="ai-plan-progress tabular">
          {settled.length}/{tasks.length}
        </span>
        <ChevronDown size={ICON_SIZE.sm} aria-hidden="true" />
      </button>
      <div id={bodyId} className="ai-tasks-body">
        {expanded ? (
          <>
            {running.length > 0 && (
              <div className="ai-tasks-grid" data-testid="ai-tasks-running">
                {running.map((task) => (
                  <TaskCard key={task.taskId} task={task} />
                ))}
              </div>
            )}
            {settled.length > 0 && (
              <div className="ai-tasks-settled" data-testid="ai-tasks-settled">
                {settled.map((task) => (
                  <TaskCard key={task.taskId} task={task} />
                ))}
              </div>
            )}
          </>
        ) : (
          recent && (
            <div className="ai-tasks-preview" aria-label="Most recent plan task">
              <TaskCard task={recent} />
            </div>
          )
        )}
      </div>
    </section>
  );
}
