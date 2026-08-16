/**
 * @framepilot/ai-sdk/kernel/gateway — the SessionGateway seam
 * (plan/AI-ORCHESTRATION-REDESIGN.md §4/§5, Phase K0.1).
 *
 * The gateway is the per-project boundary between a host surface and the
 * orchestration engine: it *accepts {@link Command}s* and *streams {@link AiEvent}s*.
 * It is transport-agnostic — the same interface is satisfied in-process (web
 * editor/dev), over Electron IPC (desktop main), or over HTTP/SSE (MCP). No
 * orchestration logic forks per host (design tenet 8).
 *
 * K0.1 ships the interface plus the in-process implementation, which is a thin,
 * behavior-preserving wrapper: it compiles the command to an {@link AgentEffect}
 * (via `compileCommand`) and dispatches that effect by delegating to the existing
 * `Orchestrator.stream*` methods. The event stream is byte-for-byte what callers
 * get today — this only proves the Command → Effect → Events spine end to end.
 */
import { createLogger } from '@framepilot/shared-types';
import type { AiEvent } from '../events.js';
import type { Orchestrator } from '../orchestrator.js';
import type { Command } from './commands.js';
import type { AgentEffect, EffectDescription } from './effects.js';
import { compileCommand } from './effects.js';

const log = createLogger('ai-sdk:kernel:gateway');

/**
 * A per-project session boundary. Hosts issue commands and consume the resulting
 * event stream; they never touch the {@link Orchestrator} or effect runtime
 * directly. One gateway instance per open project.
 */
export interface SessionGateway {
  /**
   * Submit one command and stream the {@link AiEvent}s it produces, in order,
   * until the run reaches a terminal status or its {@link AbortSignal} fires.
   */
  submit(command: Command): AsyncGenerator<AiEvent>;
}

/**
 * Run one {@link AgentEffect} against the orchestrator, yielding its events.
 *
 * This is the entire K0 "effect runtime" for the coarse agent effect: a switch
 * over the streaming mode that mirrors the host session's existing dispatch
 * (apps/web-editor `BrowserAiSession.run`). K0.3 replaces this with a real
 * {@link EffectRuntime} that also handles model/host/patch effects.
 */
async function* runAgentEffect(
  orchestrator: Orchestrator,
  effect: AgentEffect,
): AsyncGenerator<AiEvent> {
  const { mode, input, stream, agentOptions } = effect;
  log.action('runAgentEffect → dispatching', { mode });
  switch (mode) {
    case 'chat':
      yield* orchestrator.streamChat(input, stream);
      return;
    case 'plan':
      yield* orchestrator.streamPlan(input, stream);
      return;
    case 'edit':
      yield* orchestrator.streamEdit(input, stream);
      return;
    case 'agent':
      yield* orchestrator.streamAgent(input, stream, agentOptions ?? {});
      return;
    /* v8 ignore start -- `autocomplete`/`review` have no streaming entry point today;
       the host never submits them as turns, so this branch is unreachable from the
       gateway. Kept exhaustive so a future streaming mode is a compile error here. */
    default:
      return;
    /* v8 ignore stop */
  }
}

/** Dispatch one compiled effect. K0 has a single effect kind; the switch is the seam. */
async function* dispatchEffect(
  orchestrator: Orchestrator,
  effect: EffectDescription,
): AsyncGenerator<AiEvent> {
  switch (effect.kind) {
    case 'agent':
      yield* runAgentEffect(orchestrator, effect);
      return;
  }
}

/**
 * Create the in-process {@link SessionGateway} backing a project. Wraps an
 * existing {@link Orchestrator}; introduces no new behavior, only the command/event
 * boundary the kernel is built around.
 */
export function createInProcessGateway(orchestrator: Orchestrator): SessionGateway {
  return {
    async *submit(command: Command): AsyncGenerator<AiEvent> {
      const effects = compileCommand(command);
      log.action('gateway → submit', { mode: command.mode, effects: effects.length });
      for (const effect of effects) {
        yield* dispatchEffect(orchestrator, effect);
      }
    },
  };
}
