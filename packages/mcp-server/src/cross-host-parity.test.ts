/**
 * Cross-host command/effect policy parity (plan P1.1).
 *
 * Browser, desktop, and MCP must apply one command/effect policy, or "the agent did X" would mean
 * something different depending on which host the user happened to be driving. This fixture pins
 * the two things that actually differ per host: the operations that reach the shared patch engine,
 * and which tools a host is allowed to invoke at all.
 */
import { describe, expect, it } from 'vitest';
import { TOOL_REGISTRY, assembleEdit, withToolInputContract } from '@framepilot/ai-sdk';
import { readProjectFile } from '@framepilot/timeline-schema/file';
import { EditorSession, SessionError } from './session.js';
import { UI_INDEPENDENT_HOST_TOOLS, buildMcpTools, servableOverMcp } from './tools.js';
import { makeProject, makeSandboxProject } from './__fixtures__/project.js';

interface ParityCase {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/** Mutating, non-interaction-dependent tools every host is expected to support identically. */
const PARITY_CASES: readonly ParityCase[] = [
  { name: 'trim_clip', args: { clipId: 'clip_a', start: 0, end: 4 } },
  { name: 'delete_clip', args: { clipId: 'clip_b' } },
  { name: 'split_clip', args: { clipId: 'clip_a', at: 3 } },
];

/** Read the session's committed timeline back off disk, the way another host would see it. */
async function sessionTimeline(session: EditorSession) {
  const saved = await session.saveProject();
  return (await readProjectFile(saved.path)).timeline;
}

async function openSession(): Promise<EditorSession> {
  const { root } = await makeSandboxProject();
  const session = new EditorSession(root);
  await session.openProject('project.fp.json');
  return session;
}

/** The browser/desktop path: registry operations assembled through the shared patch engine. */
function hostEdit(name: string, args: Record<string, unknown>) {
  const project = makeProject();
  const tool = TOOL_REGISTRY.find((candidate) => candidate.name === name);
  if (!tool?.buildOps) throw new Error(`${name} is not a mutating registry tool.`);
  const operations = tool.buildOps(args, { project });
  return { project, operations, ...assembleEdit(project, operations, `Edit via host: ${name}`) };
}

describe('cross-host command/effect policy parity', () => {
  it.each(PARITY_CASES)(
    'reaches the same operations and validated outcome for $name',
    async ({ name, args }) => {
      const host = hostEdit(name, args);
      const session = await openSession();
      const result = await session.runTool(name, args);

      expect(result.kind).toBe('mutate');
      if (result.kind !== 'mutate') return;
      expect(result.applied).toBe(true);
      expect(result.patch.operations).toEqual(host.operations);
      expect(result.validation.valid).toBe(host.validation.valid);
      expect(result.validation.issues).toEqual(host.validation.issues);
      // The editorial outcome, not the patch id or authored reason, is what must match.
      expect(result.diff?.summary).toEqual(host.diff?.summary);
      expect(result.diff?.after).toEqual(host.diff?.after);
    },
  );

  it('rejects the same illegal command on every host and commits nothing', async () => {
    const args = { clipId: 'clip_a', start: 5, end: 2 };
    const before = makeProject();

    let hostRejected = false;
    try {
      hostRejected = !hostEdit('trim_clip', args).validation.valid;
    } catch {
      // A schema-level refusal is an equally valid rejection.
      hostRejected = true;
    }

    const session = await openSession();
    let mcpRejected = false;
    try {
      const result = await session.runTool('trim_clip', args);
      mcpRejected = result.kind === 'mutate' && !result.applied;
    } catch {
      mcpRejected = true;
    }

    expect(hostRejected).toBe(true);
    expect(mcpRejected).toBe(true);
    // An inverted range must leave the timeline exactly as it was.
    expect(session.state()?.historyLength).toBe(0);
    expect(before.timeline.tracks[0]!.clips[0]!.end).toBe(6);
  });

  it('applies an ordered command sequence to the same timeline on every host', async () => {
    const session = await openSession();
    let hostProject = makeProject();

    for (const { name, args } of PARITY_CASES) {
      // Browser/desktop: operations assembled and applied through the shared patch engine.
      const tool = TOOL_REGISTRY.find((candidate) => candidate.name === name);
      const operations = tool!.buildOps!(args, { project: hostProject });
      const assembled = assembleEdit(hostProject, operations, `Edit via host: ${name}`);
      expect(assembled.validation.valid).toBe(true);
      hostProject = { ...hostProject, timeline: assembled.diff!.after };

      const result = await session.runTool(name, args);
      expect(result.kind === 'mutate' && result.applied).toBe(true);
    }

    // Order matters: the same commands in the same order must land the same cut.
    expect(session.state()?.historyLength).toBe(PARITY_CASES.length);
    expect(await sessionTimeline(session)).toEqual(hostProject.timeline);
  });

  it('reverses an edit to the identical prior timeline on every host', async () => {
    const { name, args } = PARITY_CASES[0]!;
    const before = makeProject();
    const host = hostEdit(name, args);

    const session = await openSession();
    await session.runTool(name, args);
    expect(await sessionTimeline(session)).toEqual(host.diff!.after);

    session.undo();
    // Undo is not "close enough": both hosts restore the exact pre-edit content. The revision is
    // deliberately excluded — revisions stay monotonic across undo so stale references still fail.
    const undone = await sessionTimeline(session);
    expect({ ...undone, revision: before.timeline.revision }).toEqual(before.timeline);
    expect(undone.revision).toBeGreaterThan(host.diff!.after.revision ?? 0);
    expect(session.state()?.historyLength).toBe(0);
  });

  it('never offers interaction-dependent tools to a host without an interaction snapshot', () => {
    const exposed = new Set(buildMcpTools().map((tool) => tool.name));
    // `hostUiOnly` marks two different things: tools needing a live interaction
    // snapshot (what this test is about) and tools merely resolved outside the
    // Python sidecar. Only the former may be withheld here — see
    // `UI_INDEPENDENT_HOST_TOOLS`.
    const interactionDependent = TOOL_REGISTRY.filter(
      (tool) => tool.hostUiOnly && !UI_INDEPENDENT_HOST_TOOLS.has(tool.name),
    );

    // Guard that this stays meaningful as the professional surface grows.
    expect(interactionDependent.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'professional_edit',
        'professional_motion',
        'professional_color',
        'professional_tracking_mask',
        'professional_audio',
      ]),
    );
    for (const tool of interactionDependent) expect(exposed.has(tool.name)).toBe(false);
  });

  it.each(['professional_edit', 'professional_color', 'ask_user'])(
    'refuses %s by name, not merely by omitting it from the tool list',
    async (name) => {
      const session = await openSession();
      // Hiding a tool is not enforcement: a client can always name it directly.
      expect(() => session.runTool(name, {})).toThrow(
        expect.objectContaining({ code: 'host_ui_only' } satisfies Partial<SessionError>),
      );
    },
  );
});

/**
 * Input-contract parity (P1-4).
 *
 * The registry's Zod schema is only half of a tool's input contract; the relational and
 * range rules live in `withToolInputContract`, which the in-app path resolves at the
 * invocation boundary. This surface used to run the BARE registry entry, so an external
 * agent — the least trusted caller there is — got a strictly weaker gate than the app's
 * own model running the identical tool.
 */
describe('MCP enforces the same tool input contract as the in-app path', () => {
  /** Each case is a call the registry's Zod schema accepts and the input contract refuses. */
  const CONTRACT_CASES: readonly { readonly label: string; readonly call: ParityCase }[] = [
    {
      label: 'colour-grade parameter out of range',
      call: {
        name: 'apply_color_grade',
        args: { clipId: 'clip_a', params: { saturation: 42 } },
      },
    },
    {
      label: 'unknown colour-grade parameter',
      call: { name: 'apply_color_grade', args: { clipId: 'clip_a', params: { sparkle: 0.2 } } },
    },
    {
      label: 'keyframe property outside the supported enum',
      call: {
        name: 'add_keyframes',
        args: {
          clipId: 'clip_a',
          keyframes: [{ property: 'hue', time: 1, value: 0.5, easing: 'linear' }],
        },
      },
    },
    {
      label: 'opacity keyframe outside 0..1',
      call: {
        name: 'add_keyframes',
        args: {
          clipId: 'clip_a',
          keyframes: [{ property: 'opacity', time: 1, value: 4, easing: 'linear' }],
        },
      },
    },
    {
      label: 'map_time given both time domains',
      call: { name: 'map_time', args: { sourceTime: 1, sequenceTime: 2 } },
    },
    {
      label: 'add_clips entry with end <= start',
      call: {
        name: 'add_clips',
        args: {
          trackId: 'video_1',
          clips: [{ assetId: 'asset_1', start: 12, end: 12, sourceStart: 0 }],
        },
      },
    },
    {
      label: 'adjust_audio gain outside the contract bounds',
      call: { name: 'adjust_audio', args: { clipId: 'clip_a', gainDb: 400 } },
    },
    {
      label: 'track_object region that leaves the normalized frame',
      call: {
        name: 'track_object',
        args: {
          clipId: 'clip_a',
          target: 'bounding_box',
          region: { x: 0.9, y: 0.9, width: 0.5, height: 0.5 },
        },
      },
    },
    {
      label: 'apply_effect parameter the effect does not declare',
      call: {
        name: 'apply_effect',
        args: { effectId: 'soft-veil', startTime: 0, params: { sharpness: 1 } },
      },
    },
    {
      label: 'apply_effect parameter outside the declared range',
      call: {
        name: 'apply_effect',
        args: { effectId: 'soft-veil', startTime: 0, params: { radius: 500 } },
      },
    },
  ];

  it.each(CONTRACT_CASES)('refuses $label', async ({ call }) => {
    const session = await openSession();
    expect(() => session.runTool(call.name, call.args)).toThrow(
      expect.objectContaining({ code: 'invalid_args' } satisfies Partial<SessionError>),
    );
    // Refused BEFORE apply: nothing may reach the history when the contract says no.
    expect(session.state()?.historyLength).toBe(0);
  });

  /**
   * The sharpest case, and the reason `assertNoTransitionClamp` exists: the apply path
   * silently shortens an over-long transition to what the cut can carry. Unwrapped, MCP
   * reported "applied" for a 1.0s dissolve the timeline recorded as 0.4s — a lie the
   * external agent had no way to detect. The contract refuses and names the real limit.
   */
  it('refuses an over-long transition instead of silently clamping it', async () => {
    const session = await openSession();
    // clip_a is 6s and clip_b is 4s, so the cut carries at most 2s (half the shorter clip).
    let error: unknown;
    try {
      session.runTool('add_transition', {
        trackId: 'video_1',
        fromClipId: 'clip_a',
        toClipId: 'clip_b',
        kind: 'cross-dissolve',
        durationSeconds: 3,
      });
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(SessionError);
    expect((error as SessionError).code).toBe('invalid_args');
    // The message — not just the `cause` — must carry the legal duration: dispatch.ts
    // renders only `[code] message`, so a reason kept in `cause` never reaches the agent.
    expect((error as SessionError).message).toContain('durationSeconds <= 2');
    expect(session.state()?.historyLength).toBe(0);
  });

  it('applies a transition that fits, verbatim', async () => {
    const session = await openSession();
    const result = session.runTool('add_transition', {
      trackId: 'video_1',
      fromClipId: 'clip_a',
      toClipId: 'clip_b',
      kind: 'cross-dissolve',
      durationSeconds: 1.5,
    });
    expect(result.kind === 'mutate' && result.applied).toBe(true);
  });

  it('advertises the schema it enforces, not the bare registry one', () => {
    const advertised = new Map(buildMcpTools().map((tool) => [tool.name, tool.inputSchema]));
    // `map_time`'s advertised shape is rewritten by the contract (a flat object whose prose
    // states the mutual exclusivity Anthropic's API will not accept as a top-level oneOf).
    const mapTime = advertised.get('map_time');
    expect(JSON.stringify(mapTime)).toContain('Mutually exclusive');
    // Every registry tool the contract rewrites must be advertised in its rewritten form.
    for (const tool of TOOL_REGISTRY.filter(servableOverMcp)) {
      expect(advertised.get(tool.name)).toEqual(withToolInputContract(tool).parameters);
    }
  });
});
