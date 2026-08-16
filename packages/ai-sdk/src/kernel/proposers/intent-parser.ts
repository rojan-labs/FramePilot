/**
 * @framepilot/ai-sdk/kernel/proposers/intent-parser — the IntentParser proposer
 * (plan/AI-ORCHESTRATION-REDESIGN.md §6, §8.1, Phase K3.3).
 *
 * The first proposer on the plan (LLM) path (§20.2): when the deterministic router can't
 * match a recipe, the kernel emits one IntentParse effect to turn free-form user text
 * into a structured {@link Intent} the Planner can compile. Bounded input per the §6
 * roster — user text + a *tiny* project header + the current selection — and a small/fast
 * model tier, because classifying intent is cheap.
 *
 * Pure and stateless: {@link intentParser.buildRequest} describes the model call as inert
 * data; {@link intentParser.parseResponse} validates the reply against {@link IntentSchema}.
 */
import { z } from 'zod/v4';
import { createLogger } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import type { TargetPlatform } from '../../context-builder.js';
import { intentParserSystemPrompt } from '../../prompts.js';
import type { TimeRange } from '../semantic-index/semantic-index.js';
import {
  type ModelProposer,
  type ProposerResult,
  parseJsonResponse,
  proposerModelEffect,
} from './types.js';

const log = createLogger('ai-sdk:kernel:proposers:intent-parser');

/** The target platforms an {@link Intent} may carry (mirrors `context-builder`). */
export const TARGET_PLATFORMS = ['reels', 'tiktok', 'shorts', 'linkedin', 'x'] as const;

/**
 * A **tiny** project header — the only project context IntentParser sees (§6). Never the
 * timeline itself: intent classification needs the shape of the project (how long, what
 * aspect, how many layers, which platform), not its clip JSON.
 */
export interface ProjectHeader {
  readonly durationSeconds: number;
  readonly resolution: { readonly width: number; readonly height: number };
  readonly layerCount: number;
  readonly platform?: TargetPlatform;
}

/** Derive the tiny {@link ProjectHeader} from a project (pure). */
export function projectHeaderOf(project: Project, platform?: TargetPlatform): ProjectHeader {
  let end = 0;
  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.end > end) end = clip.end;
    }
  }
  return {
    durationSeconds: end,
    resolution: { width: project.resolution.width, height: project.resolution.height },
    layerCount: project.timeline.tracks.length,
    ...(platform !== undefined ? { platform } : {}),
  };
}

/** Bounded input to the IntentParser (§6 roster). */
export interface IntentParserInput {
  readonly userText: string;
  readonly header: ProjectHeader;
  readonly selection?: TimeRange;
}

/**
 * The structured intent (`Intent { goal, targets[], constraints, platform }`, §6). `goal`
 * is the normalized editing objective; `targets` are the entities/ranges it acts on;
 * `constraints` are the hard requirements (duration, style, platform rules); `platform`
 * is the deliverable surface when the request implies one.
 */
export const IntentSchema = z.object({
  goal: z.string().min(1),
  targets: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  platform: z.enum(TARGET_PLATFORMS).optional(),
});

/** A validated {@link IntentSchema} value — the Planner's bounded input. */
export type Intent = z.infer<typeof IntentSchema>;

// The prompt text lives in prompts.ts; rendered here with this module's platform enum
// so the contract and the schema can never drift.
const SYSTEM = intentParserSystemPrompt(TARGET_PLATFORMS);

/** Render the bounded input as the user turn (tiny header + selection + request). */
function renderInput(input: IntentParserInput): string {
  const { header, selection, userText } = input;
  const lines = [
    `Project: ${String(header.resolution.width)}x${String(header.resolution.height)}, ` +
      `${header.durationSeconds.toFixed(2)}s, ${String(header.layerCount)} layer(s)` +
      (header.platform ? `, platform ${header.platform}` : ''),
  ];
  if (selection) {
    lines.push(`Selection: ${selection.start.toFixed(2)}s–${selection.end.toFixed(2)}s`);
  }
  lines.push(`Request: ${userText}`);
  return lines.join('\n');
}

/** The IntentParser proposer (small/fast tier). */
export const intentParser: ModelProposer<IntentParserInput, Intent> = {
  name: 'intent_parser',
  tier: 'small',
  buildRequest(input) {
    log.action('buildRequest → intent_parser', {
      userTextChars: input.userText.length,
      hasSelection: Boolean(input.selection),
      tier: 'small',
    });
    return proposerModelEffect(SYSTEM, renderInput(input), { tier: 'small' });
  },
  parseResponse(raw): ProposerResult<Intent> {
    const result = parseJsonResponse(raw, IntentSchema);
    if (result.ok) {
      log.action('parseResponse ← intent_parser parsed', {
        goal: result.value.goal,
        targets: result.value.targets.length,
        constraints: result.value.constraints.length,
        platform: result.value.platform,
      });
    } else {
      log.warn('parseResponse ← intent_parser rejected', { error: result.error });
    }
    return result;
  },
};
