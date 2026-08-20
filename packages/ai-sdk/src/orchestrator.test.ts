/**
 * Tests for the orchestrator (PRD §8.2): the only place tool calls become a
 * validated patch. Covers chat/plan/edit/autocomplete and the tool-boundary
 * gate (unknown / unavailable / invalid-args).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  Orchestrator,
  ToolInvocationError,
  callNoveltyKey,
  AGENT_LOG_CLEAR_THRESHOLD_TOKENS,
  AGENT_LOG_PAYLOAD_FRESH,
  CLEARED_RESULT_MARKER,
  clearNotePayloads,
  compactAgentLog,
  parseAgentPlan,
  parsePlanLines,
  summarizeReadResult,
} from './orchestrator.js';
import { MockProvider } from './providers/mock.js';
import type { AiCompletionRequest, AiProvider, AiResponse, ToolCall } from './providers/types.js';
import { type ContextInput, estimateTokens } from './context-builder.js';
import { TOOL_REGISTRY, getTool } from './tool-registry.js';
import { classifyTool } from './tool-classification.js';
import { makeProject } from './__fixtures__/project.js';
import { DIMINISHING_RETURNS_TURNS, STALL_CONFIRM_TURNS } from './kernel/conductor.js';

/** A provider that replays a scripted response and records the last request. */
class FakeProvider implements AiProvider {
  public readonly name = 'mock' as const;
  public lastRequest?: AiCompletionRequest;
  public constructor(private readonly response: AiResponse) {}
  public async complete(request: AiCompletionRequest): Promise<AiResponse> {
    this.lastRequest = request;
    return this.response;
  }
}

/** A provider that replays a queue of responses, one per turn (last one repeats). */
class ScriptedProvider implements AiProvider {
  public readonly name = 'mock' as const;
  private turn = 0;
  /** Every request the loop sent, in order — lets a test assert the prompt it built. */
  public readonly requests: AiCompletionRequest[] = [];
  public constructor(private readonly responses: readonly AiResponse[]) {}
  public async complete(request: AiCompletionRequest): Promise<AiResponse> {
    this.requests.push(request);
    const response = this.responses[Math.min(this.turn, this.responses.length - 1)];
    this.turn += 1;
    return response!;
  }
}

const input: ContextInput = { project: makeProject(), userPrompt: 'tighten the intro' };
const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  id: 'c1',
  name,
  arguments: args,
});

describe('chat / plan', () => {
  it('chat returns text without offering tools', async () => {
    const provider = new FakeProvider({ text: 'hello' });
    const res = await new Orchestrator(provider).chat(input);
    expect(res.text).toBe('hello');
    expect(provider.lastRequest?.tools).toBeUndefined();
  });

  it('plan sends no tools (plan-only turn) and appends a plan instruction', async () => {
    const provider = new FakeProvider({ text: '1. trim intro' });
    await new Orchestrator(provider).plan(input);
    // A plan turn forbids tool calls, so no tool schemas are advertised — avoids ~541
    // tokens of wasted read-tool descriptors and contradictory prompting.
    expect(provider.lastRequest?.tools).toBeUndefined();
    const lastMessage = provider.lastRequest?.messages.at(-1);
    expect(lastMessage?.content).toContain('plan only');
  });
});

describe('edit', () => {
  it('turns a mock tool call into a validated, diffable patch', async () => {
    const result = await new Orchestrator(new MockProvider()).edit(input);
    expect(result.patch.operations[0]?.type).toBe('delete_range');
    expect(result.validation.valid).toBe(true);
    expect(result.diff).toBeDefined();
    expect(result.patch.patchId).toMatch(/^patch_/);
  });

  it('returns an invalid result (no diff) when the patch fails validation', async () => {
    const provider = new FakeProvider({
      text: 'delete a ghost track',
      toolCalls: [call('delete_range', { trackId: 'ghost', start: 0, end: 1 })],
    });
    const result = await new Orchestrator(provider).edit(input);
    expect(result.validation.valid).toBe(false);
    expect(result.diff).toBeUndefined();
  });

  it('ignores read/action tool calls and falls back to a default reason', async () => {
    const provider = new FakeProvider({ text: '', toolCalls: [call('get_timeline', {})] });
    const result = await new Orchestrator(provider).edit(input);
    expect(result.patch.operations).toHaveLength(0);
    expect(result.text).toBe('AI edit');
  });

  it('produces an empty-but-valid patch when the model returns no tool calls', async () => {
    const result = await new Orchestrator(new FakeProvider({ text: 'nothing to do' })).edit(input);
    expect(result.patch.operations).toHaveLength(0);
    expect(result.validation.valid).toBe(true);
  });

  it('rejects an unknown tool', async () => {
    const provider = new FakeProvider({ text: '', toolCalls: [call('frobnicate', {})] });
    await expect(new Orchestrator(provider).edit(input)).rejects.toMatchObject({
      code: 'unknown_tool',
    });
  });

  it('rejects a tool whose engine is not available yet', async () => {
    const provider = new FakeProvider({ text: '', toolCalls: [call('generate_mask', {})] });
    await expect(new Orchestrator(provider).edit(input)).rejects.toBeInstanceOf(
      ToolInvocationError,
    );
  });

  it('rejects invalid tool arguments', async () => {
    const provider = new FakeProvider({
      text: '',
      toolCalls: [call('trim_clip', { clipId: 'clip_a' })],
    });
    await expect(new Orchestrator(provider).edit(input)).rejects.toMatchObject({
      code: 'invalid_args',
    });
  });

  it('surfaces the field-level detail of an invalid-args failure', async () => {
    // add_transition is missing every required field except trackId — the message
    // must name the offending fields so the model/user can correct the call, not
    // just say "Invalid arguments".
    const provider = new FakeProvider({
      text: '',
      toolCalls: [call('add_transition', { trackId: 'video_1' })],
    });
    await expect(new Orchestrator(provider).edit(input)).rejects.toMatchObject({
      code: 'invalid_args',
      message: expect.stringMatching(/Invalid arguments for "add_transition": .*fromClipId/),
    });
  });

  it('rejects an unrecognized key a model hallucinated instead of silently dropping it', async () => {
    // Stripping an unknown key used to "rescue" the edit, but it also silently discarded
    // meaning-bearing arguments — a model asking to scope a call by an unsupported field
    // was told its request succeeded. Naming the bad key lets the model self-correct;
    // guessing on its behalf cannot be recovered from. See ADR 0107.
    const provider = new FakeProvider({
      text: '',
      toolCalls: [call('adjust_audio', { clipId: 'clip_a', gainDb: -2, bogus: 1 })],
    });
    await expect(new Orchestrator(provider).edit(input)).rejects.toThrow(
      /Unrecognized key: "bogus"/,
    );
  });

  it('threads the selection into the tool context', async () => {
    const provider = new FakeProvider({
      text: 'lower the gain on the selected clip',
      toolCalls: [call('adjust_audio', { clipId: 'clip_a', gainDb: -4 })],
    });
    const result = await new Orchestrator(provider).edit({
      ...input,
      selection: { start: 1, end: 2 },
    });
    expect(result.validation.valid).toBe(true);
  });
});

describe('autocomplete', () => {
  it('returns one small patch per usable tool call', async () => {
    const provider = new FakeProvider({
      text: 'suggestions',
      toolCalls: [
        call('adjust_audio', { clipId: 'clip_a', gainDb: -2 }),
        call('get_timeline', {}), // read call → filtered out
        call('trim_clip', { clipId: 'clip_b', start: 6, end: 9 }),
      ],
    });
    const results = await new Orchestrator(provider).autocomplete(input);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.validation.valid)).toBe(true);
  });

  it('returns no suggestions when the model proposes none', async () => {
    const results = await new Orchestrator(new FakeProvider({ text: 'n/a' })).autocomplete(input);
    expect(results).toEqual([]);
  });

  it('falls back to a default reason when the model gives no text', async () => {
    const provider = new FakeProvider({
      text: '',
      toolCalls: [call('adjust_audio', { clipId: 'clip_a', gainDb: -1 })],
    });
    const [first] = await new Orchestrator(provider).autocomplete(input);
    expect(first?.text).toBe('Suggested edit');
  });
});

describe('agent mode', () => {
  it('runs a multi-step loop, applies a novel edit, and stops on no-progress', async () => {
    // The mock proposes the same delete_range every turn; the loop applies it once
    // then halts when the repeated patch makes no progress.
    const run = await new Orchestrator(new MockProvider()).agent(input);
    expect(run.goal).toBe(input.userPrompt);
    expect(run.result.validation.valid).toBe(true);
    expect(run.result.patch.operations[0]?.type).toBe('delete_range');
    expect(run.result.patch.createdBy).toBe('agent');
    // One applied step, then a step that detects the repeat (no progress).
    expect(run.steps.filter((s) => s.applied)).toHaveLength(1);
    expect(run.steps.some((s) => /no progress/.test(s.note))).toBe(true);
    expect(run.log.length).toBeGreaterThan(0);
    expect(run.critique.checks.length).toBe(8);
  });

  it('interleaves asset management and timeline editing in one project-scoped run', async () => {
    // "manage my assets and edit the video": one turn folds the bin into kind
    // folders AND places a new clip — both must land in the same validated patch.
    const provider = new FakeProvider({
      text: 'organize then edit',
      toolCalls: [
        call('manage_assets', { strategy: 'by-kind' }),
        call('add_clip', {
          trackId: 'video_1',
          assetId: 'asset_1',
          start: 10,
          end: 14,
          sourceStart: 0,
          sourceEnd: 4,
        }),
      ],
    });
    const run = await new Orchestrator(provider).agent(
      { project: makeProject(), userPrompt: 'manage my assets and edit the video' },
      { maxSteps: 1 },
    );
    expect(run.result.validation.valid).toBe(true);
    const types = run.result.patch.operations.map((o) => o.type);
    expect(types).toContain('create_folder'); // bin organized
    expect(types).toContain('move_asset');
    expect(types).toContain('add_clip'); // timeline edited
    expect(run.result.diff?.summary.some((l) => l.includes('folder folder_video added'))).toBe(
      true,
    );
    expect(run.result.diff?.summary.some((l) => l.startsWith('[video_1] + clip'))).toBe(true);
  });

  it('does not halt on a no-op organize step; proceeds to the real edit next turn', async () => {
    // Reproduces the reported bug: the bin is already organized, so manage_assets
    // yields zero operations. The old loop treated that no-op mutating turn as "no
    // progress" and stopped before ANY edit happened. Now the run continues and the
    // follow-up add_clip actually lands in the patch.
    const organized = makeProject({
      folders: [{ id: 'folder_video', name: 'Video', parentId: null }],
      assets: [
        {
          id: 'asset_1',
          path: 'media/a.mp4',
          kind: 'video',
          durationSeconds: 30,
          folderId: 'folder_video',
        },
      ],
    });
    const provider = new ScriptedProvider([
      { text: 'organize first', toolCalls: [call('manage_assets', { strategy: 'by-kind' })] },
      {
        text: 'now edit',
        toolCalls: [
          call('add_clip', {
            trackId: 'video_1',
            assetId: 'asset_1',
            start: 10,
            end: 14,
            sourceStart: 0,
            sourceEnd: 4,
          }),
        ],
      },
    ]);
    const run = await new Orchestrator(provider).agent(
      { project: organized, userPrompt: 'organize and edit' },
      { maxSteps: 4 },
    );
    // The no-op organize is surfaced truthfully, then the edit lands.
    expect(run.steps[0]?.note).toMatch(/nothing to change/);
    expect(run.steps[0]?.applied).toBe(false);
    expect(run.result.patch.operations.map((o) => o.type)).toContain('add_clip');
    expect(run.steps.some((s) => s.applied)).toBe(true);
  });

  it('fails an analysis tool call HONESTLY when no host executor is connected', async () => {
    // analyze_silence/detect_scenes run ffmpeg on the engine sidecar, not in the
    // in-process orchestrator (render-vs-preview rule). Without an injected
    // executor the loop must not fabricate a success — the call fails with an
    // actionable note and zero operations.
    const provider = new ScriptedProvider([
      { text: 'inspect gaps', toolCalls: [call('analyze_silence', { assetId: 'asset_1' })] },
      { text: 'done', toolCalls: [] },
    ]);
    const run = await new Orchestrator(provider).agent(input, { maxSteps: 3 });
    expect(run.steps[0]?.note).toMatch(/no analysis engine is connected/);
    expect(run.steps[0]?.applied).toBe(false);
    expect(run.result.patch.operations).toHaveLength(0);
  });

  it('awaits the injected executor for analysis calls and feeds its data to the model', async () => {
    const provider = new ScriptedProvider([
      { text: 'analyze', toolCalls: [call('analyze_silence', { assetId: 'asset_1' })] },
      { text: 'done', toolCalls: [] },
    ]);
    const seen: string[] = [];
    const executor = {
      run: async (toolCall: ToolCall) => {
        seen.push(toolCall.name);
        return {
          status: 'completed' as const,
          summary: 'Found 2 silent ranges',
          data: { silences: [{ start: 1, end: 2 }] },
        };
      },
    };
    const run = await new Orchestrator(provider, { executor }).agent(input, { maxSteps: 3 });
    expect(seen).toEqual(['analyze_silence']);
    // The model-facing note carries the real result (bounded preview), so the next
    // turn can actually use the analysis.
    expect(run.steps[0]?.note).toMatch(/Found 2 silent ranges/);
    expect(run.steps[0]?.note).toMatch(/silences/);
  });

  it('converges and stops when the model re-analyzes the same asset without editing (arg-varying spin)', async () => {
    // Replaces the old "edit nudge": there is no prompt forcing function anymore. Instead
    // the run converges deterministically. detect_beats on the SAME asset with a different
    // sensitivity each turn dodges the exact-repeat guard (novel signature) yet reveals
    // nothing new about the track (the coarse novelty key is `detect_beats:<asset>`), so
    // after the first (novel) turn each further turn is non-progress. STALL_CONFIRM_TURNS
    // such turns converge → the run stops honestly WITHOUT editing, long before it could
    // exhaust the generous step budget.
    const executor = {
      run: async () => ({
        status: 'completed' as const,
        summary: 'Found 400 beats',
        data: { beats: [1] },
      }),
    };
    // Turn 1 is novel (progress); every turn after that repeats the same coarse novelty
    // key and learns nothing new. STALL_CONFIRM_TURNS such non-progress turns confirm the
    // stall, so the script needs 1 (novel) + STALL_CONFIRM_TURNS (non-progress) scripted
    // calls, plus one trailing turn the run must never reach.
    const scriptedTurns = 1 + STALL_CONFIRM_TURNS;
    const provider = new ScriptedProvider([
      ...Array.from({ length: scriptedTurns }, (_, i) => ({
        text: `turn-${i}`,
        toolCalls: [call('detect_beats', { assetId: 'asset_1', sensitivity: i + 1 })],
      })),
      { text: 'done', toolCalls: [] },
    ]);
    const run = await new Orchestrator(provider, { executor }).agent(input, { maxSteps: 50 });
    // Convergence happens right after the last non-progress turn — the run stops there
    // and never reaches the trailing scripted turn or the step budget.
    expect(provider.requests).toHaveLength(scriptedTurns);
    expect(run.steps.some((s) => s.applied)).toBe(false);
  });

  it('serves an identical re-requested analysis from the per-run cache (T5)', async () => {
    const provider = new ScriptedProvider([
      { text: 'analyze', toolCalls: [call('analyze_silence', { assetId: 'asset_1' })] },
      { text: 'analyze again', toolCalls: [call('analyze_silence', { assetId: 'asset_1' })] },
      { text: 'done', toolCalls: [] },
    ]);
    let executions = 0;
    const executor = {
      run: async () => {
        executions += 1;
        return { status: 'completed' as const, summary: 'Found 1 silent range', data: [1] };
      },
    };
    const run = await new Orchestrator(provider, { executor }).agent(input, { maxSteps: 4 });
    expect(executions).toBe(1);
    expect(run.steps[1]?.note).toMatch(/\(cached\)/);
  });

  it('caches a data-less outcome without inventing a preview', async () => {
    // A host outcome may carry only a summary (e.g. "nothing found") — the cached
    // replay must not fabricate a "→ …" data preview or a data field.
    const provider = new ScriptedProvider([
      { text: 'analyze', toolCalls: [call('analyze_silence', { assetId: 'asset_1' })] },
      { text: 'again', toolCalls: [call('analyze_silence', { assetId: 'asset_1' })] },
      { text: 'done', toolCalls: [] },
    ]);
    const executor = {
      run: async () => ({ status: 'completed' as const, summary: 'No silent ranges' }),
    };
    const run = await new Orchestrator(provider, { executor }).agent(input, { maxSteps: 4 });
    // `describeToolCall` renders the analysis in editor language with the asset name.
    expect(run.steps[1]?.note).toBe('Finding silences in a.mp4 (cached)');
    expect(run.steps[1]?.note).not.toMatch(/→/);
  });

  it('bounds a non-JSON-serializable executor payload to a safe preview', async () => {
    // Defensive: JSON.stringify returns undefined for functions/symbols; the
    // model-facing note must still be a bounded string, never a crash.
    const provider = new ScriptedProvider([
      { text: 'analyze', toolCalls: [call('analyze_silence', { assetId: 'asset_1' })] },
      { text: 'done', toolCalls: [] },
    ]);
    const executor = {
      run: async () => ({ status: 'completed' as const, summary: 'weird', data: () => 0 }),
    };
    const run = await new Orchestrator(provider, { executor }).agent(input, { maxSteps: 3 });
    expect(run.steps[0]?.note).toBe('weird → null');
  });

  it('surfaces an executor failure as a failed call, never a success', async () => {
    const provider = new ScriptedProvider([
      { text: 'analyze', toolCalls: [call('analyze_silence', { assetId: 'asset_1' })] },
      { text: 'done', toolCalls: [] },
    ]);
    const executor = {
      run: async () => {
        throw new Error('sidecar unreachable');
      },
    };
    const run = await new Orchestrator(provider, { executor }).agent(input, { maxSteps: 3 });
    expect(run.steps[0]?.note).toMatch(/failed: sidecar unreachable/);
    expect(run.steps[0]?.applied).toBe(false);
  });
  it('rejects malformed analysis args before any host round-trip', async () => {
    const provider = new ScriptedProvider([
      {
        text: 'analyze',
        toolCalls: [call('analyze_silence', [1] as unknown as Record<string, unknown>)],
      },
      { text: 'done', toolCalls: [] },
    ]);
    let executions = 0;
    const executor = {
      run: async () => {
        executions += 1;
        return { status: 'completed' as const, summary: 'never' };
      },
    };
    const run = await new Orchestrator(provider, { executor }).agent(input, { maxSteps: 3 });
    expect(executions).toBe(0);
    expect(run.steps[0]?.note).toMatch(/Invalid arguments for "analyze_silence"/);
  });

  it('finishes immediately when the model proposes no tool calls (empty rationale)', async () => {
    const run = await new Orchestrator(new FakeProvider({ text: '' })).agent(input);
    expect(run.result.patch.operations).toHaveLength(0);
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]?.applied).toBe(false);
    expect(run.log[0]).toMatch(/finished — no further edits/);
    expect(run.critique.checks.find((c) => c.id === 'request_match')?.status).toBe('warn');
  });

  it('applies an edit with empty rationale + empty goal (uses fallback reasons)', async () => {
    const provider = new FakeProvider({
      text: '',
      toolCalls: [call('adjust_audio', { clipId: 'clip_a', gainDb: -2 })],
    });
    const run = await new Orchestrator(provider).agent({ project: makeProject(), userPrompt: '' });
    expect(run.steps.filter((s) => s.applied)).toHaveLength(1);
    expect(run.result.patch.reason).toBe('Agent edit'); // empty goal → fallback
    expect(run.steps.find((s) => s.applied)?.patch?.reason).toBe('Agent step'); // empty rationale → fallback
  });

  it('recovers from an invalid-args tool call (operationsFor throws)', async () => {
    const provider = new FakeProvider({
      text: 'trim it',
      toolCalls: [call('trim_clip', { clipId: 'clip_a' })], // missing start/end
    });
    const run = await new Orchestrator(provider).agent(input, { maxSteps: 2 });
    expect(run.result.patch.operations).toHaveLength(0);
    expect(run.steps[0]?.note).toMatch(/Rejected "trim_clip"/);
  });

  it('fails an overlapping overlay on ITS OWN call, keeps the valid one, and applies the corrected retry', async () => {
    // Regression for the "No edits were applied … Try rephrasing" dead end: the model
    // stacks two overlapping text layers on one track in a single turn. The second
    // call must fail immediately with the validator's overlap reason (checked against
    // the turn's speculative copy that already holds the first overlay), the first
    // overlay must still land, and the model — reading the reason from the log —
    // corrects course next turn instead of the run stopping.
    const provider = new ScriptedProvider([
      {
        text: 'add the intro overlays',
        toolCalls: [
          call('add_text_layer', { trackId: 'video_1', text: 'Title', start: 12, end: 15 }),
          call('add_text_layer', { trackId: 'video_1', text: 'Subtitle', start: 13, end: 16 }),
        ],
      },
      {
        text: 'retry the subtitle on a free range',
        toolCalls: [
          call('add_text_layer', { trackId: 'video_1', text: 'Subtitle', start: 15, end: 18 }),
        ],
      },
      { text: 'done', toolCalls: [] },
    ]);
    const run = await new Orchestrator(provider).agent(input, { maxSteps: 4 });
    // Turn 1 lands the valid overlay and records the overlap rejection; turn 2 lands
    // the corrected one — the combined reviewable patch holds both.
    expect(run.result.patch.operations).toHaveLength(2);
    expect(run.result.validation.valid).toBe(true);
    expect(run.steps[0]?.applied).toBe(true);
    expect(run.steps[0]?.note).toMatch(/Rejected "add_text_layer" — .*overlap/);
    expect(run.steps[1]?.applied).toBe(true);
  });

  it('recovers from a rejected tool call instead of aborting the run', async () => {
    const provider = new FakeProvider({
      text: 'delete a ghost track',
      toolCalls: [call('delete_range', { trackId: 'ghost', start: 0, end: 1 })],
    });
    const run = await new Orchestrator(provider).agent(input, { maxSteps: 2 });
    expect(run.result.patch.operations).toHaveLength(0);
    // Per-call validation fails the call itself with the validator's reason (which
    // the model reads from the log next turn) — not a turn-end batch surprise.
    expect(run.steps.some((s) => /Rejected "delete_range" — /.test(s.note))).toBe(true);
  });

  it('refuses unknown/unavailable tools and records inspection of read tools', async () => {
    const provider = new FakeProvider({
      text: 'inspect then poke',
      toolCalls: [
        call('get_project_state', {}), // read → id-preserving digest, not a blind slice
        call('get_selected_range', {}), // short (null) → not truncated
        call('get_transcript', { bogus: 1 }), // junk key on a read tool → sanitized away
        call('frobnicate', {}),
        call('generate_mask', {}),
      ],
    });
    const run = await new Orchestrator(provider).agent(input, { maxSteps: 1 });
    const note = run.steps[0]?.note ?? '';
    // The read digest must hand the model REAL ids (asset_1, the tracks) so it never has
    // to invent them — the bug this fixes was a 240-char slice that dropped the ids.
    expect(note).toMatch(/Reading the project → /);
    expect(note).toContain('asset_1');
    expect(note).toContain('video_1');
    expect(note).toMatch(/Checking the selection → null/);
    // A junk key on a READ call is named rather than stripped: an unknown argument is
    // how a model asks for a scope the tool does not have, and answering the call it
    // did not make would leave it believing the scope was honored.
    expect(note).toMatch(/Invalid arguments for "get_transcript"/);
    expect(note).toMatch(/Unrecognized key: "bogus"/);
    expect(note).toMatch(/Refused unknown tool "frobnicate"/);
    expect(note).toMatch(/Skipped "generate_mask"/);
  });

  it('surfaces a genuinely malformed read call (non-object args) as a failure', async () => {
    const provider = new FakeProvider({
      text: 'inspect badly',
      // Arrays pass through sanitizeToolArgs untouched and fail schema.parse —
      // junk-key tolerance must not swallow a structurally wrong call.
      toolCalls: [call('get_transcript', [1, 2] as unknown as Record<string, unknown>)],
    });
    const run = await new Orchestrator(provider).agent(input, { maxSteps: 1 });
    const note = run.steps[0]?.note ?? '';
    expect(note).toMatch(/Invalid arguments for "get_transcript"/);
  });

  it('applies tool-input-contract semantic assertions on the interactive read path', async () => {
    // Base zod validation alone lets an inverted start/end window through (both are just
    // numbers); only the relational contract in tool-input-contract.ts rejects it. The
    // interactive `runAgentCall` dispatcher looks the tool up straight from the registry
    // for read/ask/action/analysis kinds — it must still wrap it through
    // `withToolInputContract` before calling `.read()`, exactly like the mutate path
    // (`operationsForCall`) and the provider-facing schema (`toolDescriptors`) already do.
    const provider = new FakeProvider({
      text: 'read a backwards window',
      toolCalls: [call('get_transcript', { start: 10, end: 5 })],
    });
    const run = await new Orchestrator(provider).agent(input, { maxSteps: 1 });
    const note = run.steps[0]?.note ?? '';
    expect(note).toMatch(/Invalid arguments for "get_transcript"/);
    expect(note).toMatch(/end > start/i);
  });

  it('applies tool-input-contract semantic assertions on the interactive ask path', async () => {
    // map_time's mutual-exclusivity check (sourceTime vs sequenceTime) lives in the same
    // contract module and only fires through withToolInputContract's wrapped `.read()`.
    const provider = new FakeProvider({
      text: 'map two time domains at once',
      toolCalls: [call('map_time', { sourceTime: 1, sequenceTime: 2 })],
    });
    const run = await new Orchestrator(provider).agent(input, { maxSteps: 1 });
    const note = run.steps[0]?.note ?? '';
    expect(note).toMatch(/Invalid arguments for "map_time"/);
    expect(note).toMatch(/exactly one time domain/i);
  });

  it('fails render/export requests honestly without a host executor (render-vs-preview rule)', async () => {
    const provider = new FakeProvider({
      text: 'render it',
      toolCalls: [call('render_preview', {})],
    });
    const run = await new Orchestrator(provider).agent(input, { maxSteps: 1 });
    // The orchestrator never runs ffmpeg itself; with no executor the action is a
    // failed call with an actionable note, not a pretended render.
    expect(run.steps[0]?.note).toMatch(/no analysis engine is connected/);
    expect(run.result.patch.operations).toHaveLength(0);
  });

  it('threads duration/platform/render facts into the self-check', async () => {
    const run = await new Orchestrator(new MockProvider()).agent(input, {
      durationTargetSeconds: 45,
      targetPlatform: 'reels',
      render: { hasBlackFrames: false, audioClipping: true },
    });
    const byId = (id: string) => run.critique.checks.find((c) => c.id === id);
    expect(byId('duration_target')?.status).toBe('fail'); // timeline is ~10s, target 45s
    expect(byId('audio_clipping')?.status).toBe('fail');
    expect(byId('black_frames')?.status).toBe('pass');
    expect(run.critique.ok).toBe(false);
  });

  it('rejects a turn that exceeds the per-turn op cap (blast-radius bound, C1)', async () => {
    const provider = new FakeProvider({
      text: 'delete a lot',
      toolCalls: [call('delete_range', { trackId: 'video_1', start: 0, end: 3 })],
    });
    // maxOpsPerTurn: 0 → any op-producing turn is rejected wholesale.
    const run = await new Orchestrator(provider).agent(input, { maxOpsPerTurn: 0, maxSteps: 3 });
    expect(run.result.patch.operations).toHaveLength(0);
    expect(run.steps.at(-1)?.note).toMatch(/exceeds the per-turn cap/);
    expect(run.steps.at(-1)?.applied).toBe(false);
  });

  it('stops once the per-run op cap is reached (blast-radius bound, C1)', async () => {
    // One turn applies three ops (folder + move + add_clip); a cap of 1 stops the run
    // right after, and the combined patch is still valid + reviewable.
    const provider = new FakeProvider({
      text: 'organize then edit',
      toolCalls: [
        call('manage_assets', { strategy: 'by-kind' }),
        call('add_clip', {
          trackId: 'video_1',
          assetId: 'asset_1',
          start: 10,
          end: 14,
          sourceStart: 0,
          sourceEnd: 4,
        }),
      ],
    });
    const run = await new Orchestrator(provider).agent(
      { project: makeProject(), userPrompt: 'do a lot' },
      { maxOpsPerRun: 1, maxSteps: 5 },
    );
    expect(run.result.validation.valid).toBe(true);
    expect(run.log.some((l) => /per-run cap/.test(l))).toBe(true);
  });
});

describe('agent auto-repair (C3) and plan ledger (C4)', () => {
  it('runs one bounded repair pass when a fixable finding remains', async () => {
    // Loop: apply an edit, then finish. The Critic then fails the duration target,
    // so a single repair pass runs (the 3rd scripted response) and applies a fix.
    const provider = new ScriptedProvider([
      { text: 'lower audio', toolCalls: [call('adjust_audio', { clipId: 'clip_a', gainDb: -2 })] },
      { text: 'done', toolCalls: [] },
      { text: 'repairing', toolCalls: [call('adjust_audio', { clipId: 'clip_a', gainDb: -6 })] },
    ]);
    const run = await new Orchestrator(provider).agent(input, {
      durationTargetSeconds: 45,
      maxSteps: 3,
    });
    const repair = run.steps.find((s) => s.note.startsWith('Repair pass:'));
    expect(repair).toBeDefined();
    expect(repair?.applied).toBe(true);
    expect(run.log.some((l) => l.startsWith('Repair:'))).toBe(true);
  });

  it('answers recall_evidence honestly when the repair pass has no evidence store attached', async () => {
    // The repair pass (`attemptRepair`) never threads the run's EvidenceStore — see
    // `HostCallContext.evidence`'s doc comment — so a repair turn reaching for
    // `recall_evidence` must degrade to an honest "no store" note instead of throwing on
    // a missing `host.evidence`.
    const provider = new ScriptedProvider([
      { text: 'lower audio', toolCalls: [call('adjust_audio', { clipId: 'clip_a', gainDb: -2 })] },
      { text: 'done', toolCalls: [] },
      {
        text: 'recalling',
        // A bare recall_evidence call (no ops) makes attemptRepair return null and the
        // repair pass never surfaces at all — pair it with a real fix so the turn
        // actually applies and this call's note rides along in the recorded step.
        toolCalls: [
          call('recall_evidence', { evidenceId: 'ev_1' }),
          call('adjust_audio', { clipId: 'clip_a', gainDb: -6 }),
        ],
      },
    ]);
    const run = await new Orchestrator(provider).agent(input, {
      durationTargetSeconds: 45,
      maxSteps: 3,
    });
    const repair = run.steps.find((s) => s.note.startsWith('Repair pass:'));
    expect(repair?.note).toContain('this run keeps no evidence store');
  });

  it('names what it has when recall_evidence is asked for an unknown handle', async () => {
    const provider = new ScriptedProvider([
      { text: 'read the timeline', toolCalls: [call('get_timeline', {})] },
      { text: 'recall a bad handle', toolCalls: [call('recall_evidence', { evidenceId: 'ev_9' })] },
      { text: 'done', toolCalls: [] },
    ]);
    const run = await new Orchestrator(provider).agent(input);
    const recallStep = run.steps.find((s) => s.toolCalls.includes('recall_evidence'));
    expect(recallStep?.note).toContain('no such handle "ev_9"');
    expect(recallStep?.note).toContain('You have: ev_1');
  });

  it('says plainly that nothing has been read yet when recall_evidence is the very first call', async () => {
    const provider = new ScriptedProvider([
      { text: 'recall too soon', toolCalls: [call('recall_evidence', { evidenceId: 'ev_1' })] },
      { text: 'done', toolCalls: [] },
    ]);
    const run = await new Orchestrator(provider).agent(input);
    const recallStep = run.steps.find((s) => s.toolCalls.includes('recall_evidence'));
    expect(recallStep?.note).toContain('you have not read anything yet this run');
  });

  it("recalls a prior read's full payload by its handle, marked non-novel", async () => {
    const provider = new ScriptedProvider([
      { text: 'read the timeline', toolCalls: [call('get_timeline', {})] },
      { text: 'recall it', toolCalls: [call('recall_evidence', { evidenceId: 'ev_1' })] },
      { text: 'done', toolCalls: [] },
    ]);
    const run = await new Orchestrator(provider).agent(input);
    const recallStep = run.steps.find((s) => s.toolCalls.includes('recall_evidence'));
    // Reads as the editor-language phrase, not the raw tool name (see describe.ts).
    expect(recallStep?.note).toContain('Recalling what it found →');
    expect(recallStep?.note).toContain('tracks');
    // A recall must not itself read as a novel finding (it returns what was already
    // known), so the no-progress guard does not treat it as fresh reconnaissance.
    expect(recallStep?.applied).toBe(false);
  });

  it('skips the repair pass when autoRepair is disabled', async () => {
    const provider = new ScriptedProvider([
      { text: 'lower audio', toolCalls: [call('adjust_audio', { clipId: 'clip_a', gainDb: -2 })] },
      { text: 'done', toolCalls: [] },
      { text: 'would repair', toolCalls: [call('adjust_audio', { clipId: 'clip_a', gainDb: -6 })] },
    ]);
    const run = await new Orchestrator(provider).agent(input, {
      durationTargetSeconds: 45,
      autoRepair: false,
      maxSteps: 3,
    });
    expect(run.steps.some((s) => s.note.startsWith('Repair pass:'))).toBe(false);
  });

  it('does not repair when the model declines (no tool calls in the repair turn)', async () => {
    const provider = new ScriptedProvider([
      { text: 'edit', toolCalls: [call('adjust_audio', { clipId: 'clip_a', gainDb: -2 })] },
      { text: 'done' }, // finish AND the repeated repair response → toolCalls undefined
    ]);
    const run = await new Orchestrator(provider).agent(input, {
      durationTargetSeconds: 45,
      maxSteps: 2,
    });
    expect(run.steps.some((s) => s.note.startsWith('Repair pass:'))).toBe(false);
  });

  it('drafts an up-front plan when planFirst is set (C4)', async () => {
    const provider = new FakeProvider({
      text: '1. Trim the intro\n2. Add captions',
      toolCalls: [],
    });
    const run = await new Orchestrator(provider).agent(input, { planFirst: true });
    expect(run.plan).toEqual(['Trim the intro', 'Add captions']);
  });

  it('omits the plan by default', async () => {
    const run = await new Orchestrator(new MockProvider()).agent(input);
    expect(run.plan).toBeUndefined();
  });

  it('records an empty plan when the model returns no plan text', async () => {
    const run = await new Orchestrator(new FakeProvider({ text: '', toolCalls: [] })).agent(input, {
      planFirst: true,
    });
    expect(run.plan).toEqual([]);
  });

  it('skips repair when only non-fixable checks fail (e.g. black frames)', async () => {
    const provider = new ScriptedProvider([
      { text: 'edit', toolCalls: [call('adjust_audio', { clipId: 'clip_a', gainDb: -2 })] },
      { text: 'done', toolCalls: [] },
      {
        text: 'should not run',
        toolCalls: [call('adjust_audio', { clipId: 'clip_a', gainDb: -9 })],
      },
    ]);
    const run = await new Orchestrator(provider).agent(input, {
      render: { hasBlackFrames: true, audioClipping: false },
      maxSteps: 2,
    });
    expect(run.critique.ok).toBe(false); // black_frames failed
    expect(run.steps.some((s) => s.note.startsWith('Repair pass:'))).toBe(false);
  });

  it('does not record a repair step when the repair turn only reads (no ops)', async () => {
    const provider = new ScriptedProvider([
      { text: 'edit', toolCalls: [call('adjust_audio', { clipId: 'clip_a', gainDb: -2 })] },
      { text: 'done', toolCalls: [] },
      { text: 'inspect', toolCalls: [call('get_timeline', {})] }, // read tool → 0 ops
    ]);
    const run = await new Orchestrator(provider).agent(input, {
      durationTargetSeconds: 45,
      maxSteps: 2,
    });
    expect(run.steps.some((s) => s.note.startsWith('Repair pass:'))).toBe(false);
  });

  it('rejects a repair turn that exceeds the per-turn op cap', async () => {
    // maxOpsPerTurn: 0 rejects the main edit AND the repair edit; the duration target
    // still fails (fixable), so the repair runs but its op is over the cap → no repair step.
    const provider = new ScriptedProvider([
      { text: 'edit', toolCalls: [call('adjust_audio', { clipId: 'clip_a', gainDb: -2 })] },
      { text: 'repair', toolCalls: [call('adjust_audio', { clipId: 'clip_a', gainDb: -6 })] },
    ]);
    const run = await new Orchestrator(provider).agent(input, {
      durationTargetSeconds: 45,
      maxOpsPerTurn: 0,
      maxSteps: 2,
    });
    expect(run.steps.some((s) => s.note.startsWith('Repair pass:'))).toBe(false);
    expect(run.result.patch.operations).toHaveLength(0);
  });

  it('records a rejected repair attempt (invalid edit, empty rationale)', async () => {
    const provider = new ScriptedProvider([
      { text: 'edit', toolCalls: [call('adjust_audio', { clipId: 'clip_a', gainDb: -2 })] },
      { text: 'done', toolCalls: [] },
      { text: '', toolCalls: [call('delete_range', { trackId: 'ghost', start: 0, end: 1 })] },
    ]);
    const run = await new Orchestrator(provider).agent(input, {
      durationTargetSeconds: 45,
      maxSteps: 2,
    });
    const repair = run.steps.find((s) => s.note.startsWith('Repair pass:'));
    expect(repair).toBeDefined();
    expect(repair?.applied).toBe(false);
    // The repair op was refused by per-call validation; the honest non-applied
    // attempt is still recorded with the validator's reason.
    expect(repair?.note).toMatch(/Rejected "delete_range" — /);
  });
});

describe('parsePlanLines (C4)', () => {
  it('strips numbering/bullets and blank lines', () => {
    expect(parsePlanLines('1. Trim intro\n\n2) Add captions\n- Export')).toEqual([
      'Trim intro',
      'Add captions',
      'Export',
    ]);
  });

  it('caps the number of steps', () => {
    const text = Array.from({ length: 30 }, (_, i) => `${i + 1}. step`).join('\n');
    expect(parsePlanLines(text, 5)).toHaveLength(5);
  });

  it('returns an empty list for empty text', () => {
    expect(parsePlanLines('')).toEqual([]);
  });
});

describe('parseAgentPlan (U2 — clean todo, prose to chat)', () => {
  it('splits numbered steps from surrounding intro/question prose', () => {
    const text =
      "Sure! Here's my plan:\n1. Trim the intro\n2. Add captions\nWould you like me to proceed?";
    expect(parseAgentPlan(text)).toEqual({
      message: "Sure! Here's my plan:\nWould you like me to proceed?",
      steps: ['Trim the intro', 'Add captions'],
    });
  });

  it('keeps a question OUT of the todo steps (the reported bug)', () => {
    const { steps } = parseAgentPlan('1. Do the edit\nWould you like me to proceed?');
    expect(steps).toEqual(['Do the edit']);
    expect(steps.some((s) => s.includes('proceed'))).toBe(false);
  });

  it('falls back to legacy line-per-step parse when there are no list markers', () => {
    // Preserves the numberless-plan behavior (a ledger still appears), message empty.
    expect(parseAgentPlan('Trim the intro\nAdd captions')).toEqual({
      message: '',
      steps: ['Trim the intro', 'Add captions'],
    });
  });

  it('returns empty message + steps for empty text', () => {
    expect(parseAgentPlan('')).toEqual({ message: '', steps: [] });
  });

  it('caps the number of steps', () => {
    const text = Array.from({ length: 30 }, (_, i) => `${i + 1}. step`).join('\n');
    expect(parseAgentPlan(text, 5).steps).toHaveLength(5);
  });
});

describe('compactAgentLog (B4)', () => {
  it('returns the log unchanged when within the recent window', () => {
    expect(compactAgentLog(['a', 'b'], 6)).toEqual(['a', 'b']);
  });

  it('digests older steps and keeps the recent window verbatim', () => {
    const log = Array.from({ length: 10 }, (_, i) => `step ${i}`);
    const out = compactAgentLog(log, 3);
    expect(out).toHaveLength(4); // 1 digest + 3 recent
    expect(out[0]).toMatch(/7 earlier steps summarized/);
    expect(out.slice(1)).toEqual(['step 7', 'step 8', 'step 9']);
  });

  it('uses singular phrasing for a single omitted step', () => {
    const log = Array.from({ length: 7 }, (_, i) => `s${i}`);
    expect(compactAgentLog(log, 6)[0]).toMatch(/1 earlier step summarized/);
  });
});

describe('micro-compaction of old tool results (E2)', () => {
  const bigPayload = JSON.stringify({
    tracks: Array.from({ length: 100 }, (_, i) => `clip_${i}`),
  });
  const readEntry = `Step 1: Read the timeline → ${bigPayload}`;
  const mixedEntry = `Step 2: Read the timeline → ${bigPayload}; Trimmed Intro.mp4 · 0s–3.2s`;

  describe('clearNotePayloads', () => {
    it('clears a large read payload, keeping the "what was called" prefix', () => {
      expect(clearNotePayloads(readEntry)).toBe(
        `Step 1: Read the timeline → ${CLEARED_RESULT_MARKER}`,
      );
    });

    it('clears only the payload segment of a mixed entry — the mutation note survives', () => {
      expect(clearNotePayloads(mixedEntry)).toBe(
        `Step 2: Read the timeline → ${CLEARED_RESULT_MARKER}; Trimmed Intro.mp4 · 0s–3.2s`,
      );
    });

    it('never touches mutation-only, rejection, or steering entries', () => {
      const mutation = 'Step 3: Trimmed Intro.mp4 · 0s–3.2s; Added captions';
      const rejection = `Step 4: Rejected "trim_clip" — ${'overlaps its neighbour. '.repeat(12)}`;
      const steering = `Steering: "${'keep the intro exactly as it is. '.repeat(10)}"`;
      expect(clearNotePayloads(mutation)).toBe(mutation);
      expect(clearNotePayloads(rejection)).toBe(rejection);
      expect(clearNotePayloads(steering)).toBe(steering);
    });

    it('never clears an ask_user answer — human guidance is not re-derivable', () => {
      const answer = `Step 5: Asked the editor: "Which take?" → they answered: "${'the second one, and keep the jump cut before it. '.repeat(5)}". Follow this answer.`;
      expect(clearNotePayloads(answer)).toBe(answer);
    });

    it('keeps small payloads — clearing a one-liner buys nothing', () => {
      const small = 'Step 6: Read the selected range → {"start":1,"end":2}';
      expect(clearNotePayloads(small)).toBe(small);
    });

    it('clears a multiline digest payload as one unit (no leaked tail lines)', () => {
      const hits = Array.from({ length: 8 }, (_, i) => `- clip clip_${i} @${i}s: "words"`).join(
        '\n',
      );
      const entry = `Step 7: Searched media for "intro" → 8 matches:\n${hits}`;
      expect(clearNotePayloads(entry)).toBe(
        `Step 7: Searched media for "intro" → ${CLEARED_RESULT_MARKER}`,
      );
    });
  });

  describe('compactAgentLog clearing tier (E2.2)', () => {
    it('does not engage below the token threshold', () => {
      const log = [readEntry, 'Step 2: Trimmed Intro.mp4 · 0s–3.2s'];
      expect(compactAgentLog(log)).toEqual(log);
    });

    it('clears payloads of old entries but keeps the freshest N verbatim', () => {
      // 6 bulk-read entries ≈ well over AGENT_LOG_CLEAR_THRESHOLD_TOKENS.
      const log = Array.from(
        { length: 6 },
        (_, i) => `Step ${i + 1}: Read the timeline → ${bigPayload}`,
      );
      const out = compactAgentLog(log);
      expect(out).toHaveLength(6);
      for (const entry of out.slice(0, 6 - AGENT_LOG_PAYLOAD_FRESH)) {
        expect(entry).toContain(CLEARED_RESULT_MARKER);
      }
      for (const entry of out.slice(6 - AGENT_LOG_PAYLOAD_FRESH)) {
        expect(entry).toContain(bigPayload);
      }
    });

    it('threshold boundary: exactly at the threshold stays untouched, one char past engages', () => {
      const oldRead = `Old: Read the timeline → ${bigPayload}`;
      // Pad a filler entry so the joined estimate (chars/4, '\n' joiners included)
      // lands EXACTLY on the threshold — the tier requires strictly greater.
      const fillerLength = AGENT_LOG_CLEAR_THRESHOLD_TOKENS * 4 - oldRead.length - 'mid'.length - 2;
      const atThreshold = [oldRead, 'mid', 'x'.repeat(fillerLength)];
      expect(compactAgentLog(atThreshold, 6)[0]).toBe(oldRead);
      const overThreshold = [oldRead, 'mid', 'x'.repeat(fillerLength + 4)];
      expect(compactAgentLog(overThreshold, 6)[0]).toContain(CLEARED_RESULT_MARKER);
    });

    it('composes with the rolling window: cleared entries then digest+window', () => {
      const log = Array.from(
        { length: 10 },
        (_, i) => `Step ${i + 1}: Read the timeline → ${bigPayload}`,
      );
      const out = compactAgentLog(log, 3);
      expect(out).toHaveLength(4);
      expect(out[0]).toMatch(/7 earlier steps summarized/);
      expect(out[1]).toContain(CLEARED_RESULT_MARKER);
      expect(out[3]).toContain(bigPayload); // freshest entries keep payloads
    });
  });
});

describe('callNoveltyKey (reconnaissance vs the analysis spin)', () => {
  const c = (name: string, args: Record<string, unknown>): ToolCall => ({
    id: 'x',
    name,
    arguments: args,
  });

  it('collapses the same analysis on the same asset, however the args are tuned', () => {
    // THE spin the no-progress guard exists to catch: detect_beats at sensitivity 1.5,
    // then 3.5, then 2 is one question asked three ways — re-analysing the same media
    // cannot reveal anything new about it, so it must not read as progress.
    const a = callNoveltyKey(c('detect_beats', { assetId: 'm', sensitivity: 1.5 }));
    const b = callNoveltyKey(c('detect_beats', { assetId: 'm', sensitivity: 3.5 }));
    expect(a).toBe(b);
  });

  it('treats the same analysis on a DIFFERENT asset as genuinely new', () => {
    expect(callNoveltyKey(c('detect_beats', { assetId: 'm1' }))).not.toBe(
      callNoveltyKey(c('detect_beats', { assetId: 'm2' })),
    );
  });

  it('keys non-read, non-analysis calls on their full arguments', () => {
    // For load_skill, a changed argument really is a different question.
    expect(callNoveltyKey(c('load_skill', { name: 'beat-synced-editing' }))).not.toBe(
      callNoveltyKey(c('load_skill', { name: 'color-grading' })),
    );
  });

  it('treats a read call with no arguments object at all the same as one with an empty object', () => {
    // A model can omit `arguments` entirely for a no-arg read tool (get_timeline, etc.);
    // the novelty key must still be derivable rather than throwing on a missing object.
    const bare: ToolCall = { id: 'x', name: 'get_transcript', arguments: undefined as never };
    expect(callNoveltyKey(bare)).toBe(callNoveltyKey(c('get_transcript', {})));
  });

  it('regression: transcript windows collapse to one key, however they are sliced', () => {
    // The reported failure: a run re-read the transcript at a new window every turn
    // ({0,60} → {0,120} → {60,180} → whole), so every turn looked novel, the stall
    // streak reset every turn, and the run researched to the step cap applying nothing.
    // Re-reading a different slice of the same unchanged transcript is one question.
    const keys = [
      callNoveltyKey(c('get_transcript', { start: 0, end: 60 })),
      callNoveltyKey(c('get_transcript', { start: 0, end: 120 })),
      callNoveltyKey(c('get_transcript', { start: 60, end: 180 })),
      callNoveltyKey(c('get_transcript', {})),
    ];
    expect(new Set(keys).size).toBe(1);
  });

  it('keeps a read of a DIFFERENT subject genuinely novel', () => {
    // Only window args are dropped; identity args still separate real questions, so
    // legitimate exploration is never mistaken for a spin.
    expect(callNoveltyKey(c('get_clip', { clipId: 'a' }))).not.toBe(
      callNoveltyKey(c('get_clip', { clipId: 'b' })),
    );
  });

  it('argument ORDER cannot manufacture novelty', () => {
    expect(callNoveltyKey(c('get_clip', { clipId: 'a', trackId: 't' }))).toBe(
      callNoveltyKey(c('get_clip', { trackId: 't', clipId: 'a' })),
    );
  });
});

/**
 * The module's own text, so the audit below asserts which `case` labels the digest switch
 * actually has rather than a hand-kept copy of them that could drift from it. Same
 * technique as the tool-parity fixture guard: rebuild the claim from the live source.
 */
const summarizeReadResultSource = readFileSync(new URL('./orchestrator.ts', import.meta.url), 'utf8');

/**
 * Reads that are honestly served by the bounded JSON preview, each with the reason.
 *
 * The `default` arm of `summarizeReadResult` is a floor, not an answer. Ten read tools
 * had reached it by accident — every one of them a tool whose payload is a record list,
 * a catalog or a findings report, handed to the model as a 1200-escaped-character slice
 * ending in a bare `…`, and distilled into the run's durable memory as the first 180
 * characters of that slice. Three stalled runs came out of it (ADR 0127, ADR 0128, and
 * the caption run that could not read its own verification report).
 *
 * So membership here is a DECISION a reader can check, not a gap. Adding a read tool now
 * fails CI until somebody either writes its digest or states here why it does not need
 * one.
 */
const READS_SERVED_BY_JSON_PREVIEW: Readonly<Record<string, string>> = {
  get_transcript: 'the source word list, which the model asked for verbatim',
  get_selected_range: 'two numbers and an id',
  get_frame: 'a frame handle; the picture itself rides as image content',
  measure_color: 'a handful of scalar measurements, all of them named in the payload',
  map_footage: 'a per-asset mapping already keyed by the ids the model passed in',
  index_media: 'a progress/count acknowledgement, not a record list',
  transcribe: 'an acknowledgement; the words arrive via get_transcript',
  propose_edits: 'a proposal the model reads whole and acts on in the same turn',
  detect_faces: 'unavailable in this build — it returns a refusal, not a payload',
};

describe('every read tool can be summarized (no silent previewJson fallthrough)', () => {
  it('either has a digest arm or is listed as served by the JSON preview, with a reason', () => {
    const digested = new Set(
      [...summarizeReadResultSource.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1] as string),
    );
    const undigested = TOOL_REGISTRY.filter((tool) => {
      const role = classifyTool(tool.name, tool.kind).role;
      return role === 'inspection' || role === 'analysis' || role === 'guidance';
    })
      .map((tool) => tool.name)
      .filter((name) => !digested.has(name) && !(name in READS_SERVED_BY_JSON_PREVIEW));
    expect(undigested).toEqual([]);
  });

  it('does not list a tool as preview-served that actually has a digest', () => {
    const digested = new Set(
      [...summarizeReadResultSource.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1] as string),
    );
    const contradictory = Object.keys(READS_SERVED_BY_JSON_PREVIEW).filter((name) =>
      digested.has(name),
    );
    expect(contradictory).toEqual([]);
  });
});

describe('summarizeReadResult carries a verification report the run can act on', () => {
  it('groups issues by code instead of handing back escaped JSON', () => {
    // The live failure: 40 cues x 2 problems = 68 near-identical issues, previewJson'd to
    // a blob cut mid-string, whose first 180 characters became the run's only memory of
    // its own verification. The first line must now say what is wrong.
    const issues = [
      ...Array.from({ length: 40 }, (_, i) => ({
        code: 'caption_stale',
        clipId: `cap_${i}`,
        at: i,
        detail: `Caption at ${i}s shows 3 words but 2 now play across it.`,
      })),
      ...Array.from({ length: 28 }, (_, i) => ({
        code: 'caption_spans_speech_break',
        clipId: `cap_${i}`,
        at: i,
        detail: `Caption at ${i}s bridges the speech break at ${i + 1}s.`,
      })),
    ];
    const note = summarizeReadResult('verify_captions', { ok: false, cueCount: 40, issues });
    const first = note.split('\n')[0]!;
    expect(first).toContain('NOT verified');
    expect(first).toContain('40 cues checked');
    expect(first).toContain('40x caption_stale');
    expect(first).toContain('28x caption_spans_speech_break');
    // One worked example per kind, not 68 lines of prose.
    expect(note.split('\n')).toHaveLength(3);
  });

  it('says so plainly when nothing is wrong', () => {
    const note = summarizeReadResult('verify_captions', { ok: true, cueCount: 21, issues: [] });
    expect(note).toBe('verified clean, 21 cues checked');
  });

  it('lists every cut, because a transition can only go at one of them', () => {
    const boundaries = Array.from({ length: 45 }, (_, i) => ({
      trackId: 'video_main',
      at: i * 0.5,
      fromClipId: `clip_${i}`,
      toClipId: `clip_${i + 1}`,
      maxTransitionSeconds: 0.25,
    }));
    const note = summarizeReadResult('list_edit_boundaries', boundaries);
    expect(note.split('\n')[0]).toBe('45 cuts:');
    expect(note).toContain('clip_0 → clip_1');
    expect(note).toContain('max transition 0.25s');
  });

  it('lists every effect id, grouped, because the ids ARE the deliverable', () => {
    const note = summarizeReadResult('discover_effects', {
      matched: 78,
      returned: 2,
      effects: [
        { effectId: 'vhs-tape', category: 'stylize' },
        { effectId: 'film-grain', category: 'stylize' },
      ],
    });
    expect(note.split('\n')[0]).toBe('2 of 78 matching effects');
    expect(note).toContain('stylize: vhs-tape, film-grain');
  });

  it('names the total silence, not just the gap count', () => {
    const note = summarizeReadResult('analyze_silence', {
      assetId: 'a1',
      ranges: [
        { start: 1, end: 2.5, duration: 1.5 },
        { start: 4, end: 4.25, duration: 0.25 },
      ],
    });
    expect(note.split('\n')[0]).toBe('2 silent gaps, 1.75s total, in a1:');
  });
});

describe('summarizeReadResult (agent must never invent ids)', () => {
  it('get_timeline: carries a caption track\'s committed STYLE, not just its clip count', () => {
    // The failure this closes: asked to "use a different caption style", a run read the
    // timeline — whose payload holds `templateId: headline` and the accent already applied
    // — but the digest rendered only ids and clip counts. The distilled fact was "5
    // tracks, 87 clips", the raw payload aged out of the rolling log window, and the run
    // spent the rest of its budget hunting for the answer it had already been given.
    const note = summarizeReadResult('get_timeline', {
      tracks: [
        {
          id: 'layer_caption_4',
          type: 'caption',
          clips: [],
          captionStyle: {
            templateId: 'headline',
            accent: { mode: 'keywords', keywords: ['route', 'heart', 'searching'] },
          },
        },
      ],
    });
    expect(note).toContain('template=headline');
    expect(note).toContain('accent=keywords (3 keywords)');
  });

  it('get_timeline: says so plainly when a caption track carries no style at all', () => {
    const note = summarizeReadResult('get_timeline', {
      tracks: [{ id: 'layer_caption_4', type: 'caption', clips: [], captionStyle: {} }],
    });
    expect(note).toContain('template=none');
    // An accent of 'none' is not a fact worth a word; only a real one is named.
    expect(note).not.toContain('accent=');
  });

  it('get_timeline: names the accent mode even when it accents no explicit keywords', () => {
    const note = summarizeReadResult('get_timeline', {
      tracks: [
        {
          id: 'c',
          type: 'caption',
          clips: [],
          captionStyle: {
            templateId: 'karaoke',
            display: 'phrase',
            fontFamily: 'Inter',
            accent: { mode: 'last-word' },
          },
        },
      ],
    });
    expect(note).toContain('template=karaoke · phrase · Inter · accent=last-word');
  });

  it('discover_caption_styles: lists every template id, grouped, because the ids ARE the deliverable', () => {
    // set_track_caption_style rejects an id that is not in the catalog, so a truncated
    // list is a list the run cannot act on. previewJson cut this after ~18 of 51 — and
    // the style already applied to the project was past the cut, so the run could
    // neither name what it had nor choose something deliberately different.
    const templates = Array.from({ length: 51 }, (_, i) => ({
      templateId: `tpl_${i}`,
      label: `T${i}`,
      category: i % 2 === 0 ? 'phrase' : 'karaoke',
      suggestedWordsPerLine: 3,
      fontFamily: 'Inter',
      display: 'phrase',
    }));
    const note = summarizeReadResult('discover_caption_styles', {
      matched: 51,
      returned: 51,
      fonts: [{ family: 'Inter', category: 'sans', minWeight: 100, maxWeight: 900 }],
      templates,
      compositionFields: ['fontFamily'],
    });
    for (const t of templates) expect(note).toContain(t.templateId);
    expect(note).toContain('51 of 51 matching templates, 1 bundled fonts');
    expect(note).toContain('fonts: Inter');
  });

  it('discover_caption_styles: reports an empty match instead of an empty list', () => {
    expect(
      summarizeReadResult('discover_caption_styles', { matched: 0, returned: 0, fonts: [], templates: [] }),
    ).toContain('no caption templates match');
  });

  it('get_mapped_transcript: keeps every mapped word with its SEQUENCE timing', () => {
    const words = Array.from({ length: 81 }, (_, i) => ({
      word: `w${i}`,
      start: i * 0.25,
      end: i * 0.25 + 0.2,
      sourceStart: i * 0.25,
      sourceEnd: i * 0.25 + 0.2,
    }));
    const note = summarizeReadResult('get_mapped_transcript', {
      words,
      // The wire shape runs carry: bounds and a count, never copies of the words. See
      // domain-tools/timeline.ts — repeating them made the payload exactly twice the size
      // of the information in it.
      runs: [{ clipId: 'c', assetId: 'a', start: 0, end: 20.2, wordCount: 81 }],
      droppedCount: 3,
      revision: 749,
    });
    // The run bounds ride in the HEAD, because that first line becomes the run's durable
    // fact and the bounds are the only place a cue may not be broken across.
    expect(note).toContain(
      '81 mapped words, 3 dropped by cuts in 1 speech run (0–20.2s), revision 749',
    );
    for (const w of words) expect(note).toContain(w.word);
  });

  it('get_mapped_transcript: omits a drop count when the cuts dropped nothing', () => {
    const note = summarizeReadResult('get_mapped_transcript', {
      words: [{ word: 'hello', start: 0, end: 0.4 }],
      runs: [],
    });
    expect(note).toContain('1 mapped words, revision ?');
    expect(note).not.toContain('dropped');
  });

  it('get_clip: renders a bare clip without inventing effects, an override or a cue', () => {
    const note = summarizeReadResult('get_clip', {
      clip: { id: 'clip_1', assetId: 'a', trackId: 'video_main', start: 0, end: 2 },
    });
    expect(note).toContain('clip_1');
    expect(note).not.toContain('effects:');
    expect(note).not.toContain('cue');
  });

  it('discover_caption_styles: falls back to the template count when the payload omits totals', () => {
    const note = summarizeReadResult('discover_caption_styles', {
      templates: [{ templateId: 'stamp' }],
      fonts: [],
    });
    expect(note).toContain('1 of 1 matching templates, 0 bundled fonts');
    // A template with no category still has to be listed; it is a usable id.
    expect(note).toContain('other: stamp');
  });

  it('get_mapped_transcript: says plainly when the edit left no speech', () => {
    expect(summarizeReadResult('get_mapped_transcript', { words: [], runs: [] })).toContain(
      'no mapped words',
    );
  });

  it('get_timeline_summary: keeps the per-track rows that are its only reason to exist', () => {
    const note = summarizeReadResult('get_timeline_summary', {
      durationSeconds: 21.867,
      trackCount: 2,
      clipCount: 87,
      tracks: [
        { id: 'layer_caption_4', type: 'caption', clipCount: 40, firstClipStart: 0.09, lastClipEnd: 19.75 },
        { id: 'audio_music', type: 'audio', clipCount: 0, firstClipStart: null, lastClipEnd: null },
      ],
      markerCount: 1,
      transcriptWordCount: 81,
    });
    expect(note).toContain('sequence 21.87s, 2 tracks, 87 clips, 81 transcript words');
    expect(note).toContain('layer_caption_4 [caption] 40 clips 0.09–19.75s');
    // A track with no clips has no span to name; it must not invent one, and a row that
    // omits clipCount entirely reads as 0 rather than as "undefined clips".
    expect(note).toContain('audio_music [audio] 0 clips');
    expect(
      summarizeReadResult('get_timeline_summary', {
        trackCount: 1,
        tracks: [{ id: 'fx', type: 'effect' }],
      }),
    ).toContain('fx [effect] 0 clips');
  });

  it('get_timeline_summary: degrades to the head line when a payload carries no tracks', () => {
    expect(summarizeReadResult('get_timeline_summary', { trackCount: 0, tracks: [] })).toContain(
      'sequence ?, 0 tracks',
    );
  });

  it('get_clip: keeps ids, both time pairs, the cue and any per-cue style override', () => {
    const note = summarizeReadResult('get_clip', {
      trackId: 'layer_caption_4',
      clip: {
        id: 'caption_layer_caption_4_90',
        assetId: '__caption__',
        trackId: 'layer_caption_4',
        start: 0.09,
        end: 1.28,
        sourceStart: 0,
        sourceEnd: 1.19,
        effects: [{ id: 'e1', type: 'caption', params: {} }],
        captionStyle: { maxWidthPercent: 15, templateId: 'stamp' },
        captionCue: {
          text: 'Car,\ntake a new route,',
          words: [{ word: 'Car,', start: 0.09, end: 0.27 }],
          derivedFromRevision: 684,
        },
      },
    });
    expect(note).toContain('caption_layer_caption_4_90');
    expect(note).toContain('layer_caption_4');
    expect(note).toContain('effects: caption');
    expect(note).toContain('cue style override: template=stamp');
    expect(note).toContain('cue (1 words, from revision 684): Car, / take a new route,');
  });

  it('get_clip: keeps a cue whose word list is missing rather than dropping the text', () => {
    const note = summarizeReadResult('get_clip', {
      clip: {
        id: 'clip_1',
        assetId: 'a',
        trackId: 't',
        start: 0,
        end: 1,
        captionCue: { text: 'hello' },
      },
    });
    expect(note).toContain('cue (0 words, from revision ?): hello');
  });

  it('get_mapped_transcript: treats a payload with no word list as no speech', () => {
    expect(summarizeReadResult('get_mapped_transcript', { revision: 3 })).toContain(
      'no mapped words',
    );
  });

  it('discover_caption_styles: reports an empty catalog for a payload with no template list', () => {
    expect(summarizeReadResult('discover_caption_styles', {})).toBe(
      'no caption templates match (0 in catalog)',
    );
  });

  it('get_clip: falls back to a JSON preview for a payload that is not a clip', () => {
    expect(summarizeReadResult('get_clip', { clip: null })).toContain('clip');
  });

  it('list_assets: keeps every asset id so the agent has real ids to reference', () => {
    const assets = Array.from({ length: 50 }, (_, i) => ({
      id: `asset_img_${i}`,
      path: `media/img_${i}.png`,
      kind: 'image' as const,
      durationSeconds: 5,
    }));
    const note = summarizeReadResult('list_assets', { assets, folders: [] });
    // The whole point of the fix: EVERY id survives, not just the first few before a
    // 240-char slice. A missing id is what drove the model to fabricate asset_img_9723…
    for (const a of assets) expect(note).toContain(a.id);
    expect(note).toContain('50 assets');
  });

  it('get_timeline_map: gives the model every clip SOURCE in-point, not the first four', () => {
    // The run that motivated this: 41 video clips + one music bed, asked for "more
    // precise montage cuts, at least 45 clips, don't keep the clips from the starting
    // offset". Answering it needs each clip's sourceStart — and this payload had no
    // digest case, so it fell through to previewJson at 1200 escaped chars: about four
    // spans of forty-two, followed by a bare `…`. The model could not obtain the number
    // it was asked to vary, and reasoned about clips it had never been shown.
    const spans = Array.from({ length: 41 }, (_, i) => ({
      clipId: `clip__layer_video_main_asset_cropped_search_${Math.round(i * 533)}`,
      assetId: 'asset_cropped_search',
      trackId: 'layer_video_main',
      start: Math.round(i * 533) / 1000,
      end: Math.round((i + 1) * 533) / 1000,
      sourceStart: Math.round(i * 611) / 1000,
      sourceEnd: Math.round(i * 611 + 533) / 1000,
      speed: 1,
    }));
    const note = summarizeReadResult('get_timeline_map', {
      spans,
      duration: 21.867,
      revision: 12,
    });
    expect(note).toContain('timeline map, 41 clips');
    expect(note).toContain('sequence duration 21.87s');
    expect(note).toContain('revision 12');
    for (const span of spans) {
      expect(note).toContain(span.clipId);
      // The source half of the timing is the half no other surface shows: the context
      // block renders `clipId[start–end s]` and get_timeline's digest the same.
      // Same 2-dp rounding the digest uses, trailing zeros dropped (`22`, not `22.00`).
      expect(note).toContain(`src ${Math.round(span.sourceStart * 100) / 100}–`);
    }
    expect(note).not.toContain('…"');
  });

  it('get_timeline_map: omits 1x speed and marks a retimed clip', () => {
    const note = summarizeReadResult('get_timeline_map', {
      spans: [
        {
          clipId: 'c1',
          assetId: 'a',
          trackId: 't',
          start: 0,
          end: 1,
          sourceStart: 0,
          sourceEnd: 1,
          speed: 1,
        },
        {
          clipId: 'c2',
          assetId: 'a',
          trackId: 't',
          start: 1,
          end: 2,
          sourceStart: 4,
          sourceEnd: 6,
          speed: 2,
        },
      ],
      duration: 2,
      revision: 3,
    });
    expect(note).toContain('c1 asset=a track=t seq 0–1s src 0–1s');
    expect(note).toContain('c2 asset=a track=t seq 1–2s src 4–6s ×2');
  });

  it("get_timeline_map: falls back to the JSON preview for map_time's other shapes", () => {
    // `map_time` answers three shapes; only the argument-less one is the whole map.
    const note = summarizeReadResult('map_time', {
      at: { clipId: 'c1', sourceTime: 3 },
      revision: 4,
    });
    expect(note).toContain('sourceTime');
    expect(note).not.toContain('timeline map');
  });

  it('get_clips: keeps every row of a page and says how to reach the rest', () => {
    const clips = Array.from({ length: 50 }, (_, i) => ({
      id: `clip_${i}`,
      trackId: 'layer_video_main',
      assetId: 'asset_1',
      start: i,
      end: i + 1,
      sourceStart: i * 2,
      sourceEnd: i * 2 + 1,
      effectCount: 0,
      keyframeCount: 0,
    }));
    const note = summarizeReadResult('get_clips', { clips, total: 120, hasMore: true });
    for (const clip of clips) expect(note).toContain(clip.id);
    expect(note).toContain('50 clips');
    // A blind character cut told the model nothing was missing. This says what to do.
    expect(note).toContain('raise offset');
    expect(note).toContain('total 120');
  });

  it('get_clips: reports the exact total when the page is the whole listing', () => {
    const note = summarizeReadResult('get_clips', {
      clips: [
        {
          id: 'clip_1',
          trackId: 't',
          assetId: 'a',
          start: 0,
          end: 1,
          sourceStart: 9,
          sourceEnd: 10,
          effectCount: 2,
          keyframeCount: 3,
        },
      ],
      total: 1,
      hasMore: false,
    });
    expect(note).toContain('1 clip of 1 total');
    expect(note).toContain('src 9–10s fx=2 kf=3');
    expect(note).not.toContain('raise offset');
  });

  it('detect_beats: gives the model every exact onset, not a BPM approximation (W4)', () => {
    // The beat grid IS the deliverable, and it went through the default JSON preview: a
    // 366-beat payload was sliced at 1200 escaped chars, so the model saw 33 beats
    // covering the first 15s of a 20s track, ending mid-number — then was asked to cut to
    // a grid it had never received. Same defect class as the load_skill truncation.
    const beats = Array.from({ length: 366 }, (_, i) => ({
      time: Math.round(i * 0.4878 * 1000) / 1000,
      strength: 0.82,
    }));
    const note = summarizeReadResult('detect_beats', { beats, bpm: 123.1 });
    // A montage needs the detected onsets themselves. BPM is an average and cannot
    // reconstruct non-uniform timing, swing, or detector jitter.
    expect(note).toContain('366 exact beat onsets');
    expect(note).toContain('~123 BPM');
    expect(note).toContain('178.047'); // the last onset — the span, not a mid-cut fragment
    expect(note).not.toContain('more beats not listed');
    expect(note).not.toContain('Compute any beat');
    expect(note.split('\n')[1]!.split(', ')).toHaveLength(366);
  });

  it('detect_beats: preserves all 37 non-uniform onsets needed by a 20s montage', () => {
    const times = Array.from(
      { length: 37 },
      (_, index) => Math.round((index * 0.53 + (index % 4) * 0.017) * 1000) / 1000,
    );
    const note = summarizeReadResult('detect_beats', {
      beats: times.map((time) => ({ time, strength: 0.8 })),
      bpm: 113.2,
    });
    expect(note).toContain('37 exact beat onsets');
    for (const time of times) expect(note).toContain(time.toString());
    expect(note.split('\n')[1]!.split(', ')).toHaveLength(37);
  });

  it('detect_beats: lists a short grid in full, with no "more beats" tail', () => {
    const note = summarizeReadResult('detect_beats', {
      beats: [{ time: 0 }, { time: 0.5 }, { time: 1 }],
      bpm: 120,
    });
    expect(note).toContain('3 exact beat onsets');
    expect(note).toContain('0, 0.5, 1');
    expect(note).not.toContain('more beats');
  });

  it('detect_beats: says so honestly when there are none', () => {
    expect(summarizeReadResult('detect_beats', { beats: [], bpm: 0 })).toBe('no beats detected');
    expect(summarizeReadResult('detect_beats', {})).toBe('no beats detected');
    // A payload whose times are junk is the same case — not a grid.
    expect(summarizeReadResult('detect_beats', { beats: [{ strength: 1 }] })).toBe(
      'no beats detected',
    );
  });

  it('detect_beats: omits the tempo when the engine could not determine one', () => {
    const note = summarizeReadResult('detect_beats', { beats: [{ time: 0 }, { time: 1 }] });
    expect(note).toContain('2 exact beat onsets');
    expect(note).not.toContain('BPM');
  });

  it('load_skill: delivers the whole playbook, never a truncated fragment (ADR 0057)', () => {
    // The body IS the deliverable — the model asked for it because it does not know it.
    // The old generic preview JSON-escaped it and sliced it at 1200 chars (~a third of a
    // real skill, mid-sentence), so the model kept re-loading it and never edited.
    const body = `# Playbook\n\n${'Cut on the downbeat, not every beat. '.repeat(120)}\nEND-MARKER`;
    const note = summarizeReadResult('load_skill', {
      name: 'beat-synced-editing',
      description: 'How to cut to music',
      body,
    });
    expect(body.length).toBeGreaterThan(1200);
    expect(note).toContain(body);
    expect(note).toContain('END-MARKER');
    expect(note).toContain('beat-synced-editing — How to cut to music');
    // Prose, not an escaped JSON blob.
    expect(note).not.toContain('\\n');
  });

  it('load_skill: an unknown skill still names the valid ones so the model self-corrects', () => {
    // Not the body shape — falls back to the bounded JSON preview, which is right: the
    // error object is small and the `available` list is what lets the model recover.
    const note = summarizeReadResult('load_skill', {
      error: 'Unknown skill "nope".',
      available: ['beat-synced-editing', 'color-grading'],
    });
    expect(note).toContain('Unknown skill');
    expect(note).toContain('beat-synced-editing');
  });

  it('search_media: keeps every hit id, time, and placement in the digest (B2.3)', () => {
    const note = summarizeReadResult('search_media', {
      hits: [
        { type: 'transcript', start: 5, end: 5.9, snippet: '[budget] review', score: 1.2 },
        { type: 'marker', markerId: 'm1', start: 12, end: 12, snippet: '[hook]', score: 0.4 },
        {
          type: 'asset',
          assetId: 'asset_1',
          snippet: 'media/a.mp4',
          score: 0,
          placements: [{ clipId: 'clip_a', start: 0, end: 6 }],
        },
      ],
    });
    expect(note).toContain('3 matches');
    expect(note).toContain('transcript 5–5.9s: "[budget] review"');
    expect(note).toContain('marker m1 @12s');
    expect(note).toContain('asset asset_1');
    expect(note).toContain('on timeline: clip_a 0–6s');
  });

  it('search_media: defaults a missing type/snippet and ignores a malformed placement entry', () => {
    const note = summarizeReadResult('search_media', {
      hits: [{ start: 3, end: 3, placements: [null] }],
    });
    // No `type` → 'hit'; `start === end` → a single timestamp, not a range; no
    // `snippet` → nothing after the colon; a `null` placement degrades to `{}`
    // rather than throwing.
    expect(note).toContain('- hit @3s: → on timeline: undefined undefined–undefineds');
  });

  it('search_media: defaults a missing "hits" key to no matches', () => {
    expect(summarizeReadResult('search_media', {})).toBe('no matches');
  });

  it('search_media: an empty result reads as "no matches", and huge lists are bounded', () => {
    expect(summarizeReadResult('search_media', { hits: [] })).toBe('no matches');
    const hits = Array.from({ length: 400 }, (_, i) => ({
      type: 'transcript',
      start: i,
      end: i + 0.5,
      snippet: `[word] ${i}`,
      score: 1,
    }));
    const note = summarizeReadResult('search_media', { hits });
    expect(note).toContain('400 matches');
    expect(note).toMatch(/more matches not shown/);
    expect(note).toContain('refine the query');
  });

  it('visual reads keep complete packets with asset time, caption, dialogue, and provenance', () => {
    const note = summarizeReadResult('search_visual', {
      backend: 'sqlite-vec',
      packets: [
        {
          assetId: 'asset_product',
          t0: 4.125,
          t1: 4.875,
          sceneId: 7,
          score: 0.032786,
          caption: 'A hand rotates a black camera on a white table.',
          transcriptOverlap: 'This is the new compact body.',
          sources: ['visual', 'caption-fts'],
        },
      ],
    });
    expect(note).toContain('1 visual evidence packet via sqlite-vec');
    expect(note).toContain('asset=asset_product scene=7 asset-time=4.13–4.88s');
    expect(note).toContain('rrf=0.0328 sources=visual,caption-fts');
    expect(note).toContain('visible caption: A hand rotates a black camera on a white table.');
    expect(note).toContain('overlapping dialogue: This is the new compact body.');
    expect(note).toContain('rrf is fused retrieval rank, not confidence');
    expect(note).not.toContain('{"packets"');
  });

  it('visual reads fall back to "unknown" scene and no-sources for a minimal packet', () => {
    const note = summarizeReadResult('search_visual', {
      packets: [{ assetId: 'asset_x', t0: 1, t1: 2 }],
    });
    expect(note).toContain('scene=unknown');
    expect(note).toContain('sources=none');
    expect(note).toContain('visible caption: (none)');
    expect(note).toContain('overlapping dialogue: (none)');
  });

  it('visual reads fall back to "?" and "unknown-asset" for a packet missing identity/time', () => {
    const note = summarizeReadResult('search_visual', { packets: [{}] });
    expect(note).toContain('asset=unknown-asset');
    expect(note).toContain('asset-time=?–?s');
    expect(note).toContain('rrf=?');
  });

  it('visual reads report "no visual evidence" when the packets key is entirely absent', () => {
    expect(summarizeReadResult('search_visual', {})).toBe('no visual evidence');
  });

  it('visual reads reject safety-only text as grounding and bound by whole packets', () => {
    const packets = Array.from({ length: 30 }, (_, i) => ({
      assetId: `asset_${i}`,
      t0: i,
      t1: i + 0.5,
      sceneId: i,
      score: 1 / (60 + i),
      caption: i === 0 ? 'User Safety: safe' : `Concrete scene ${i}`,
      transcriptOverlap: '',
      sources: ['visual'],
    }));
    const note = summarizeReadResult('describe_footage', { packets });
    expect(note).toContain('generic safety/status text');
    expect(note).toContain('visible caption: User Safety: safe');
    expect(note).toContain('asset=asset_23');
    expect(note).not.toContain('asset=asset_24');
    expect(note).toContain('6 more visual packets not shown');
    expect(note.trimEnd().endsWith(')')).toBe(true);
  });

  it('visual reads report an empty or unavailable evidence set without fabricated packets', () => {
    expect(summarizeReadResult('search_visual', { packets: [] })).toBe('no visual evidence');
    expect(
      summarizeReadResult('describe_footage', {
        packets: [],
        reason: 'no embedding key configured',
      }),
    ).toBe('no visual evidence: no embedding key configured');
  });

  it('session_context: renders every non-empty section, omitting blank ones (B6.3)', () => {
    expect(summarizeReadResult('session_context', {})).toBe(
      'nothing learned about this project yet',
    );
    const note = summarizeReadResult('session_context', {
      corrections: '## no captions over faces',
      decisions: '',
      soul: '# Working style',
      sessionNote: '',
      binSummary: '',
    });
    expect(note).toContain('Rejected before (do not repeat)');
    expect(note).toContain('no captions over faces');
    expect(note).toContain('Working style (all projects)');
    expect(note).not.toContain('Accepted before');
  });

  it('list_assets: bounds a huge library by dropping WHOLE records with a narrow hint', () => {
    const assets = Array.from({ length: 400 }, (_, i) => ({
      id: `asset_${i}`,
      path: `m/${i}.mp4`,
      kind: 'video' as const,
    }));
    const note = summarizeReadResult('list_assets', { assets, folders: [] });
    expect(note).toContain('asset_0'); // first records shown in full
    expect(note).toContain('400 assets'); // honest total
    expect(note).toMatch(/… 100 more assets not shown/); // no silent mid-list cut
    expect(note).toContain('filter list_assets by kind/folderId'); // tells it how to narrow
  });

  it('list_assets: renders folders with their ids and parents', () => {
    const note = summarizeReadResult('list_assets', {
      assets: [],
      folders: [{ id: 'f_b', name: 'B-roll', parentId: 'f_root' }],
    });
    expect(note).toContain('f_b');
    expect(note).toContain('under f_root');
  });

  it('list_assets: a root folder (no parent) omits the "under" suffix', () => {
    const note = summarizeReadResult('list_assets', {
      assets: [],
      folders: [{ id: 'f_root', name: 'Root' }],
    });
    expect(note).toContain('f_root "Root"');
    expect(note).not.toContain('under');
  });

  it('list_assets: pluralizes "folders" once there is more than one', () => {
    const note = summarizeReadResult('list_assets', {
      assets: [],
      folders: [
        { id: 'f_a', name: 'A' },
        { id: 'f_b', name: 'B' },
      ],
    });
    expect(note).toContain('2 folders:');
  });

  it('list_assets: an asset in a folder carries an "in:<folderId>" tag', () => {
    const note = summarizeReadResult('list_assets', {
      assets: [{ id: 'asset_1', path: 'media/a.mp4', kind: 'video', folderId: 'f_root' }],
      folders: [],
    });
    expect(note).toContain('in:f_root');
  });

  it('list_assets: an empty path still resolves to a filename (no crash on pop() === "")', () => {
    const note = summarizeReadResult('list_assets', {
      assets: [{ id: 'asset_1', path: '', kind: 'video' }],
      folders: [],
    });
    expect(note).toContain('asset_1');
  });

  it('list_assets: missing assets/folders keys default to empty (defensive against partial data)', () => {
    const note = summarizeReadResult('list_assets', {});
    expect(note).toContain('no assets');
  });

  it('list_assets: bounds an overflowing folder list too, with no narrow hint for folders', () => {
    const folders = Array.from({ length: 301 }, (_, i) => ({ id: `f_${i}`, name: `F${i}` }));
    const note = summarizeReadResult('list_assets', { assets: [], folders });
    expect(note).toMatch(/… 1 more folders not shown\)/); // no ";  filter…" narrow suffix
  });

  it('get_project_state: surfaces asset ids AND real track/clip ids', () => {
    const note = summarizeReadResult('get_project_state', makeProject());
    expect(note).toContain('asset_1');
    expect(note).toContain('video_1');
    expect(note).toContain('clip_a');
    expect(note).toContain('clip_b');
    expect(note).toContain('2 words'); // transcript summarized to a count, not dumped
  });

  it('get_project_state: reports the folder count when the project has folders', () => {
    const note = summarizeReadResult('get_project_state', {
      ...makeProject(),
      folders: [{ id: 'f_a', name: 'A' }],
    });
    expect(note).toContain('1 folders');
  });

  it('get_project_state: defends against a partial/malformed object missing optional fields', () => {
    // summarizeReadResult takes `unknown` — a caller (or a future engine response shape)
    // may omit fields a real schema-validated Project always fills via `.default([])`,
    // including `timeline` itself (so `project.timeline?.tracks ?? []` falls all the way
    // through both the optional-chain and the nullish-coalesce).
    const note = summarizeReadResult('get_project_state', { id: 'p' });
    expect(note).toContain('no assets');
    expect(note).toContain('0 words');
    expect(note).toContain('timeline: no tracks');
  });

  it('get_timeline: lists track and clip ids with times', () => {
    const note = summarizeReadResult('get_timeline', makeProject().timeline);
    expect(note).toContain('video_1');
    expect(note).toContain('clip_a asset=asset_1 0–6s');
    expect(note).toContain('audio_1');
    expect(note).toContain('empty'); // the clipless audio track
  });

  it('get_timeline: no tracks at all reads as "no tracks", not an empty list', () => {
    expect(summarizeReadResult('get_timeline', { tracks: [] })).toBe('timeline: no tracks');
  });

  it('get_timeline: a missing tracks key defaults to none (defensive against partial data)', () => {
    expect(summarizeReadResult('get_timeline', {})).toBe('timeline: no tracks');
  });

  it("get_timeline: surfaces a track's locked/hidden/muted flags", () => {
    const note = summarizeReadResult('get_timeline', {
      tracks: [
        { id: 'video_1', type: 'video', clips: [], locked: true, hidden: true, muted: true },
      ],
    });
    expect(note).toContain('video_1 [video locked,hidden,muted]');
  });

  it('other reads fall back to a generously bounded JSON preview', () => {
    expect(summarizeReadResult('get_selected_range', null)).toBe('null');
    const words = Array.from({ length: 5 }, (_, i) => ({ word: `w${i}`, start: i, end: i + 1 }));
    expect(summarizeReadResult('get_transcript', words)).toContain('w0');
  });
});

describe('review mode', () => {
  it('returns a deterministic critic report + readable text', async () => {
    const review = await new Orchestrator(new MockProvider()).review(input);
    expect(review.report.checks.length).toBe(8);
    expect(review.text).toContain(review.report.summary);
    expect(review.text).toMatch(/\[(PASS|WARN|FAIL|SKIPPED)\]/);
  });

  it('threads duration/platform/render options into the report', async () => {
    const review = await new Orchestrator(new MockProvider()).review(input, {
      durationTargetSeconds: 45,
      targetPlatform: 'reels',
      render: { hasBlackFrames: true, audioClipping: false },
    });
    const byId = (id: string) => review.report.checks.find((c) => c.id === id);
    expect(byId('duration_target')?.status).toBe('fail');
    expect(byId('export_settings')?.status).toBe('warn');
    expect(byId('black_frames')?.status).toBe('fail');
    expect(review.report.ok).toBe(false);
  });
});

/**
 * E4 parity mirror — the legacy `agent()` loop applies the same diminishing-returns
 * stop as the Conductor reducer, so both control paths judge convergence identically.
 */
describe('agent() diminishing-returns stop (E4 parity mirror)', () => {
  const read = (id: string, name: string): ToolCall => ({ id, name, arguments: {} });

  // Distinct zero-arg read tools, one per turn, so each turn is novel (dodges the stall
  // guard) while still contributing nothing new to the plan (zero edits) — the fixture
  // for the diminishing-returns reducer, which only cares about the token-delta streak.
  const READ_TOOL_NAMES = [
    'get_timeline',
    'get_selected_range',
    'get_project_state',
    'list_assets',
    'get_timeline_summary',
    'get_transcript',
  ];

  const scriptedReadTurns = (): {
    text: string;
    toolCalls: ToolCall[];
    usage: { outputTokens: number };
  }[] =>
    Array.from({ length: DIMINISHING_RETURNS_TURNS }, (_, i) => ({
      text: '',
      toolCalls: [read(`r${i + 1}`, READ_TOOL_NAMES[i % READ_TOOL_NAMES.length]!)],
      usage: { outputTokens: 20 },
    }));

  it('stops after N novel-but-tiny zero-edit turns with an honest log line', async () => {
    const provider = new ScriptedProvider([
      ...scriptedReadTurns(),
      { text: 'should not run', toolCalls: [] },
    ]);
    const run = await new Orchestrator(provider).agent(input);
    expect(run.steps).toHaveLength(DIMINISHING_RETURNS_TURNS);
    expect(run.log.at(-1)).toMatch(
      new RegExp(`converged — the last ${DIMINISHING_RETURNS_TURNS} turns each produced under`),
    );
  });

  it('a tuned minOutputTokens threshold is honored', async () => {
    const provider = new ScriptedProvider([
      ...scriptedReadTurns(),
      { text: 'done', toolCalls: [] },
    ]);
    const run = await new Orchestrator(provider).agent(input, {
      diminishingReturns: { minOutputTokens: 10 },
    });
    // 20-token turns are all ABOVE the tuned 10-token threshold — no early stop.
    expect(run.steps.length).toBeGreaterThan(DIMINISHING_RETURNS_TURNS);
  });
});

/**
 * E5 (plan/ORCHESTRATION-EFFICIENCY-CC-PATTERNS.md) — route-scoped tool surface.
 * The question route's advertised surface is read/analysis/ask ONLY; a mutating or
 * rendering descriptor must never reach a Q&A prompt. (Audit note: today's question
 * route sends no tools at all — this scope is the enforced ceiling, locked by tests,
 * for the day it gains tool use.)
 */
describe('route-scoped tool surface (E5)', () => {
  const orchestrator = new Orchestrator(new MockProvider());

  it('question scope advertises only read/analysis/ask kinds', () => {
    const names = orchestrator.agentTools('question').map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(['read', 'analysis', 'ask']).toContain(getTool(name)!.kind);
    }
    expect(names).toContain('get_timeline');
    expect(names).toContain('analyze_silence');
    expect(names).toContain('ask_user');
  });

  it('a question-route surface never contains a mutating or rendering descriptor', () => {
    const names = orchestrator.agentTools('question').map((t) => t.name);
    expect(names).not.toContain('trim_clip');
    expect(names).not.toContain('delete_range');
    expect(names).not.toContain('render_preview');
    expect(names).not.toContain('export_video');
    expect(names.some((n) => getTool(n)!.mutates)).toBe(false);
  });

  it('agent scope (the default) keeps the full surface unchanged', () => {
    expect(orchestrator.agentTools()).toEqual(orchestrator.agentTools('agent'));
    const names = orchestrator.agentTools('agent').map((t) => t.name);
    expect(names).toContain('trim_clip');
    expect(names).toContain('get_timeline');
  });

  it('action recovery advertises mutation, ask, and recall — never a fresh read', () => {
    const names = orchestrator.agentTools('action-recovery').map((tool) => tool.name);
    expect(names).toContain('add_clip');
    expect(names).toContain('ask_user');
    // The turn asserts the run already has its evidence; that is only true if it can
    // reach it. A real montage run was told to recall rather than re-read, found no
    // recall tool, and placed forty-six clips on asset durations it had inferred from
    // clip-id suffixes because the media bin it had read twice was unreachable.
    expect(names).toContain('recall_evidence');
    expect(names).not.toContain('get_timeline');
    expect(names).not.toContain('list_assets');
    expect(names).not.toContain('detect_beats');
    for (const name of names) {
      if (name === 'recall_evidence') continue;
      expect(['mutate', 'ask']).toContain(getTool(name)!.kind);
    }
  });

  it('scoping never touches the registry itself (the MCP surface is unaffected)', () => {
    orchestrator.agentTools('question');
    expect(TOOL_REGISTRY.some((t) => t.kind === 'mutate' && t.available)).toBe(true);
    expect(TOOL_REGISTRY.some((t) => t.kind === 'action' && t.available)).toBe(true);
  });

  it('E5.2 measurement: the question-scope descriptor block is materially smaller', () => {
    const cost = (tools: readonly unknown[]): number => estimateTokens(JSON.stringify(tools));
    const full = cost(orchestrator.agentTools('agent'));
    const question = cost(orchestrator.agentTools('question'));
    // The scoped surface must save a meaningful share of the descriptor block —
    // the exact figures are recorded in plan/ORCHESTRATION-EFFICIENCY-CC-PATTERNS.md.
    expect(question).toBeLessThan(full * 0.6);
  });
});
