/**
 * Cross-host command/effect policy parity (plan P1.1).
 *
 * Browser, desktop, and MCP must apply one command/effect policy, or "the agent did X" would mean
 * something different depending on which host the user happened to be driving. This fixture pins
 * the two things that actually differ per host: the operations that reach the shared patch engine,
 * and which tools a host is allowed to invoke at all.
 */
import { describe, expect, it } from 'vitest';
import { TOOL_REGISTRY, assembleEdit } from '@framepilot/ai-sdk';
import { readProjectFile } from '@framepilot/timeline-schema/file';
import { EditorSession, SessionError } from './session.js';
import { UI_INDEPENDENT_HOST_TOOLS, buildMcpTools } from './tools.js';
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
