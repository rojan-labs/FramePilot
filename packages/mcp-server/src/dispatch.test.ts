import { describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { EditorSession } from './session.js';
import { activePointerPath } from '@framepilot/shared-types/projects-root';
import { RenderClient, RenderError } from './render-client.js';
import { AnalysisClient, AnalysisError } from './analysis-client.js';
import { callTool, type CallToolResult } from './dispatch.js';
import { makeSandboxProject } from './__fixtures__/project.js';

const parse = (result: CallToolResult): unknown => JSON.parse(result.content[0]!.text);

async function setup() {
  const { root, projectPath } = await makeSandboxProject();
  const session = new EditorSession(root);
  return { root, projectPath, session };
}

/** Write the desktop app's active-project pointer into a sandbox root. */
async function writeActivePointer(root: string, projectPath: string): Promise<void> {
  await writeFile(
    activePointerPath(root),
    JSON.stringify({ path: projectPath, projectId: 'proj_1', updatedAt: 1 }),
    'utf-8',
  );
}

const stubRenderClient = (impl: () => Promise<unknown>): RenderClient =>
  ({ render: impl }) as unknown as RenderClient;

const stubAnalysisClient = (
  impl: (name: string, path: string, args: Record<string, unknown>) => Promise<unknown>,
): AnalysisClient => ({ analyze: impl }) as unknown as AnalysisClient;

describe('callTool — session tools', () => {
  it('opens, edits, undoes, and reads history', async () => {
    const { session } = await setup();

    const opened = await callTool(session, null, 'open_project', { path: 'project.fp.json' });
    expect(opened.isError).toBeUndefined();
    expect((parse(opened) as { canUndo: boolean }).canUndo).toBe(false);

    const edited = await callTool(session, null, 'trim_clip', {
      clipId: 'clip_a',
      start: 0,
      end: 4,
    });
    expect((parse(edited) as { applied: boolean }).applied).toBe(true);

    const undone = await callTool(session, null, 'undo', {});
    expect((parse(undone) as { canUndo: boolean }).canUndo).toBe(false);

    await callTool(session, null, 'redo', {});
    const history = await callTool(session, null, 'get_patch_history', {});
    expect((parse(history) as { patches: unknown[] }).patches).toHaveLength(1);

    const saved = await callTool(session, null, 'save_project', {});
    expect(saved.isError).toBeUndefined();
  });

  it('reports project id/name but never leaks the on-disk path', async () => {
    const { session, projectPath } = await setup();

    const opened = await callTool(session, null, 'open_project', { path: 'project.fp.json' });
    const view = parse(opened) as {
      projectId: string;
      projectName: string;
      path?: string;
    };
    expect(view.projectId).toBe('proj_1');
    expect(view.projectName).toBe('Demo');
    expect(view.path).toBeUndefined();
    expect(opened.content[0]!.text).not.toContain(projectPath);

    // The same holds for save_project's state view.
    const saved = await callTool(session, null, 'save_project', {});
    expect((parse(saved) as { projectId?: string }).projectId).toBe('proj_1');
    expect(saved.content[0]!.text).not.toContain(projectPath);
  });

  it('maps invalid session-tool args (ZodError) to an error result', async () => {
    const { session } = await setup();
    // `path` is optional now, so a wrong *type* is what triggers the ZodError.
    const result = await callTool(session, null, 'open_project', { path: 123 });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('[invalid_args]');
  });
});

describe('callTool — active project (no explicit open)', () => {
  it("open_project with no path opens the app's active project", async () => {
    const { session, root, projectPath } = await setup();
    await writeActivePointer(root, projectPath);

    const opened = await callTool(session, null, 'open_project', {});
    expect(opened.isError).toBeUndefined();
    // Identifies the project by its stable id — never by the on-disk path (the leak
    // that invited the direct-file-edit bypass). The absolute path must not appear.
    expect((parse(opened) as { projectId: string }).projectId).toBe('proj_1');
    expect(opened.content[0]!.text).not.toContain(projectPath);
    expect(JSON.stringify(opened.structuredContent)).not.toContain(projectPath);
  });

  it('auto-opens the active project for a registry tool with no prior open', async () => {
    const { session, root, projectPath } = await setup();
    await writeActivePointer(root, projectPath);

    const read = await callTool(session, null, 'get_timeline', {});
    expect(read.isError).toBeUndefined();
    expect(read.content[0]!.text).toContain('tracks');
  });

  it('returns no_project when nothing is open and there is no active pointer', async () => {
    const { session } = await setup();
    const result = await callTool(session, null, 'get_timeline', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('[no_project]');
  });
});

describe('callTool — registry tools', () => {
  it('returns read data and rejected validation as non-error results', async () => {
    const { session } = await setup();
    await callTool(session, null, 'open_project', { path: 'project.fp.json' });

    const read = await callTool(session, null, 'get_timeline', {});
    expect(read.isError).toBeUndefined();

    const invalid = await callTool(session, null, 'trim_clip', {
      clipId: 'nope',
      start: 0,
      end: 1,
    });
    expect(invalid.isError).toBeUndefined();
    expect((parse(invalid) as { applied: boolean }).applied).toBe(false);
  });

  it('maps a SessionError (unknown tool) to an error result', async () => {
    const { session } = await setup();
    await callTool(session, null, 'open_project', { path: 'project.fp.json' });
    const result = await callTool(session, null, 'bogus_tool', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('[unknown_tool]');
  });

  it('maps an unexpected error to an internal_error result', async () => {
    const exploding = {
      ensureOpenProject: async () => {},
      runTool: () => {
        throw new Error('unexpected boom');
      },
    } as unknown as EditorSession;
    const result = await callTool(exploding, null, 'get_timeline', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('[internal_error]');
  });

  it('stringifies a non-Error throw in the internal_error result', async () => {
    const exploding = {
      ensureOpenProject: async () => {},
      runTool: () => {
        throw 'bare string failure';
      },
    } as unknown as EditorSession;
    const result = await callTool(exploding, null, 'get_timeline', {});
    expect(result.content[0]!.text).toContain('bare string failure');
  });
});

describe('callTool — action tools (render delegation)', () => {
  it('reports unavailable rendering when no sidecar is configured', async () => {
    const { session } = await setup();
    await callTool(session, null, 'open_project', { path: 'project.fp.json' });
    const result = await callTool(session, null, 'render_preview', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('[render_unavailable]');
  });

  it('rejects an unhandled action tool instead of rendering it (B7.1)', async () => {
    // A future registry action tool reaches dispatch with no edit here. It must
    // be refused, not silently exported as a video — so this stubs the session to
    // return the action outcome the registry would produce for such a tool.
    const stubbed = {
      ensureOpenProject: async () => {},
      runTool: () => ({ kind: 'action', name: 'publish_to_youtube', args: {} }),
    } as unknown as EditorSession;
    const render = vi.fn(async () => ({ jobId: 'job_never' }));

    const result = await callTool(stubbed, stubRenderClient(render), 'publish_to_youtube', {});

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('[unsupported_action]');
    expect(render).not.toHaveBeenCalled();
  });

  it('saves then delegates a preview render to the sidecar', async () => {
    const { session } = await setup();
    await callTool(session, null, 'open_project', { path: 'project.fp.json' });
    const render = vi.fn(async () => ({ jobId: 'job_9' }));
    const result = await callTool(session, stubRenderClient(render), 'render_preview', {});

    expect(result.isError).toBeUndefined();
    expect(render).toHaveBeenCalledOnce();
    expect((parse(result) as { action: string }).action).toBe('render_preview');
  });

  it('maps a RenderError from the sidecar to an error result', async () => {
    const { session } = await setup();
    await callTool(session, null, 'open_project', { path: 'project.fp.json' });
    const failing = stubRenderClient(async () => {
      throw new RenderError(500, 'sidecar exploded');
    });
    const result = await callTool(session, failing, 'export_video', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('[render_failed:500]');
  });
});

describe('callTool — analysis tools (ffmpeg delegation)', () => {
  it('reports unavailable analysis when no sidecar is configured', async () => {
    const { session } = await setup();
    await callTool(session, null, 'open_project', { path: 'project.fp.json' });
    const result = await callTool(session, null, 'analyze_silence', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('[analysis_unavailable]');
  });

  it('validates args, saves, then delegates analyze_silence to the sidecar', async () => {
    const { session } = await setup();
    await callTool(session, null, 'open_project', { path: 'project.fp.json' });
    const analyze = vi.fn(async () => ({
      assetId: 'a',
      ranges: [{ start: 1, end: 2, duration: 1 }],
    }));
    const result = await callTool(
      session,
      null,
      'analyze_silence',
      { assetId: 'a', minSilenceSeconds: 0.75 },
      stubAnalysisClient(analyze),
    );
    expect(result.isError).toBeUndefined();
    const [name, savedPath, args] = analyze.mock.calls[0]!;
    expect(name).toBe('analyze_silence');
    expect(savedPath).toMatch(/project\.fp\.json$/);
    expect(args).toEqual({ assetId: 'a', minSilenceSeconds: 0.75 });
    const body = parse(result) as { analysis: string; result: { ranges: unknown[] } };
    expect(body.analysis).toBe('analyze_silence');
    expect(body.result.ranges).toHaveLength(1);
  });

  it('delegates detect_scenes and returns the sidecar payload', async () => {
    const { session } = await setup();
    await callTool(session, null, 'open_project', { path: 'project.fp.json' });
    const analyze = vi.fn(async () => ({ assetId: 'v', cuts: [{ time: 3.5 }] }));
    const result = await callTool(
      session,
      null,
      'detect_scenes',
      { threshold: 0.5 },
      stubAnalysisClient(analyze),
    );
    expect(analyze.mock.calls[0]![0]).toBe('detect_scenes');
    expect((parse(result) as { analysis: string }).analysis).toBe('detect_scenes');
  });

  it('rejects invalid analysis args before delegating (schema gate)', async () => {
    const { session } = await setup();
    await callTool(session, null, 'open_project', { path: 'project.fp.json' });
    const analyze = vi.fn(async () => ({}));
    const result = await callTool(
      session,
      null,
      'detect_scenes',
      { threshold: 5 }, // out of [0, 1]
      stubAnalysisClient(analyze),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('[invalid_args]');
    expect(analyze).not.toHaveBeenCalled();
  });

  it('maps an AnalysisError from the sidecar to an error result', async () => {
    const { session } = await setup();
    await callTool(session, null, 'open_project', { path: 'project.fp.json' });
    const failing = stubAnalysisClient(async () => {
      throw new AnalysisError(422, 'no audio stream');
    });
    const result = await callTool(session, null, 'analyze_silence', {}, failing);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('[analysis_failed:422]');
  });

  it('transcribe commits the sidecar words as a reversible patch, then saves', async () => {
    const { session } = await setup();
    await callTool(session, null, 'open_project', { path: 'project.fp.json' });
    const analyze = vi.fn(async () => ({
      words: [{ word: 'hi', start: 0, end: 0.5 }],
    }));
    const result = await callTool(
      session,
      null,
      'transcribe',
      { assetId: 'a' },
      stubAnalysisClient(analyze),
    );
    expect(result.isError).toBeUndefined();
    const body = parse(result) as { applied: boolean; patch: unknown; diff: unknown };
    expect(body.applied).toBe(true);
    expect(body.patch).not.toBeNull();
    expect(body.diff).not.toBeNull();

    const history = await callTool(session, null, 'get_patch_history', {});
    expect((parse(history) as { patches: unknown[] }).patches).toHaveLength(1);
  });

  it('transcribe maps an empty word list from the sidecar to an error result', async () => {
    const { session } = await setup();
    await callTool(session, null, 'open_project', { path: 'project.fp.json' });
    const analyze = vi.fn(async () => ({ words: [] }));
    const result = await callTool(
      session,
      null,
      'transcribe',
      { assetId: 'a' },
      stubAnalysisClient(analyze),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('[invalid_args]');
  });
});
