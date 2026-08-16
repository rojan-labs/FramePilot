/**
 * Adapts durable run commands to the orchestrator's temporary execution hooks.
 *
 * The Promise/queue objects live only inside Electron main. Their authoritative
 * inputs and wait state are durable events/snapshots, so renderer reload does not
 * own or erase a decision.
 */
import { randomUUID } from 'node:crypto';
import {
  parseRunCommand,
  type AgentRunControls,
  type AskUserAnswer,
  type PlanApprovalDecision,
  type SteeringQueue,
} from '@framepilot/ai-sdk';
import { createLogger } from '@framepilot/shared-types';
import { RunCoordinator, type RunSubscription } from './run-coordinator.js';

const log = createLogger('desktop:ai:durable-run-controls');

function commandFromEvent(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const command = (value as Record<string, unknown>)['command'];
  if (command === undefined) return null;
  try {
    return parseRunCommand(command);
  } catch {
    return null;
  }
}

export class DurableRunControls {
  private readonly steeringMessages: string[] = [];
  private planWaiter: ((decision: PlanApprovalDecision) => void) | null = null;
  private questionWaiter:
    | { readonly toolCallId: string; readonly resolve: (answer: AskUserAnswer) => void }
    | null = null;
  private subscription: RunSubscription | null = null;

  private constructor(
    private readonly coordinator: RunCoordinator,
    private readonly runId: string,
    private readonly projectId: string,
    private readonly onCancel: () => void,
  ) {}

  public static async create(
    coordinator: RunCoordinator,
    runId: string,
    projectId: string,
    onCancel: () => void,
  ): Promise<DurableRunControls> {
    const controls = new DurableRunControls(coordinator, runId, projectId, onCancel);
    controls.subscription = await coordinator.subscribe(runId, 0, (event) => {
      if (event.kind !== 'run.command_accepted') return;
      const command = commandFromEvent(event.payload);
      if (command === null) return;
      switch (command.kind) {
        case 'approve_plan':
          controls.planWaiter?.('approved');
          controls.planWaiter = null;
          return;
        case 'reject_plan':
          controls.planWaiter?.('cancelled');
          controls.planWaiter = null;
          return;
        case 'answer':
          if (controls.questionWaiter?.toolCallId === command.payload.toolCallId) {
            controls.questionWaiter.resolve({
              kind: 'answered',
              answer: command.payload.answer,
            });
            controls.questionWaiter = null;
          }
          return;
        case 'steer':
          controls.steeringMessages.push(command.payload.message);
          return;
        case 'cancel':
          controls.planWaiter?.('cancelled');
          controls.planWaiter = null;
          controls.questionWaiter?.resolve({ kind: 'cancelled' });
          controls.questionWaiter = null;
          controls.onCancel();
          return;
        default:
          return;
      }
    });
    return controls;
  }

  public readonly controls: AgentRunControls = {
    planApproval: {
      requestApproval: async (planSteps) => {
        const gateId = `plan-${randomUUID()}`;
        let resolveDecision: (decision: PlanApprovalDecision) => void = () => undefined;
        const pending = new Promise<PlanApprovalDecision>((resolve) => {
          resolveDecision = resolve;
        });
        this.planWaiter = resolveDecision;
        try {
          await this.coordinator.openGate({
            runId: this.runId,
            projectId: this.projectId,
            gateId,
            kind: 'plan_approval',
            payload: { steps: [...planSteps] },
          });
        } catch (error) {
          this.planWaiter = null;
          throw error;
        }
        log.action('durable plan gate opened', { runId: this.runId, gateId });
        return pending;
      },
    },
    askUser: {
      requestAnswer: async (toolCallId, question, options) => {
        let resolveAnswer: (answer: AskUserAnswer) => void = () => undefined;
        const pending = new Promise<AskUserAnswer>((resolve) => {
          resolveAnswer = resolve;
        });
        this.questionWaiter = { toolCallId, resolve: resolveAnswer };
        try {
          await this.coordinator.openGate({
            runId: this.runId,
            projectId: this.projectId,
            gateId: toolCallId,
            kind: 'question',
            payload: {
              question,
              options:
                options?.map((option) => ({
                  label: option.label,
                  ...(option.description === undefined
                    ? {}
                    : { description: option.description }),
                })) ?? [],
            },
          });
        } catch (error) {
          this.questionWaiter = null;
          throw error;
        }
        log.action('durable question gate opened', { runId: this.runId, toolCallId });
        return pending;
      },
    },
    steering: {
      push: (message) => {
        const trimmed = message.trim();
        if (trimmed.length > 0) this.steeringMessages.push(trimmed);
      },
      take: () => this.steeringMessages.shift(),
    } satisfies SteeringQueue,
  };

  public close(): void {
    this.subscription?.unsubscribe();
    this.subscription = null;
    this.planWaiter?.('cancelled');
    this.planWaiter = null;
    this.questionWaiter?.resolve({ kind: 'cancelled' });
    this.questionWaiter = null;
  }
}
