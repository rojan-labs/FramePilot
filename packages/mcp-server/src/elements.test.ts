/**
 * Elements over MCP (plan/elements EL8.5, 07 §7): an external agent finds a callout, draws it,
 * restyles and animates it through the same registry tools the in-app agent uses, saves, and
 * undoes — and the file on disk is what the editor would have written. Stickers are the desktop
 * app's to place: this surface neither advertises `add_sticker` nor offers sticker ids it could
 * never use, and it says so in words an agent can act on.
 */
import { describe, expect, it } from 'vitest';
import { readProjectFile } from '@framepilot/timeline-schema/file';
import { clipAnimation, shapeClipParams } from '@framepilot/editor-core';
import type { Clip, Project } from '@framepilot/timeline-schema';
import { callTool, type CallToolResult } from './dispatch.js';
import { EditorSession, SessionError } from './session.js';
import { buildMcpTools } from './tools.js';
import { makeSandboxProject } from './__fixtures__/project.js';

const parse = (result: CallToolResult): unknown => JSON.parse(result.content[0]!.text);
const clips = (project: Project): Clip[] => project.timeline.tracks.flatMap((t) => t.clips);

async function open() {
  const { root, projectPath } = await makeSandboxProject();
  const session = new EditorSession(root);
  await callTool(session, null, 'open_project', { path: 'project.fp.json' });
  return { root, projectPath, session };
}

describe('elements over MCP', () => {
  it('advertises the element tools, and not the sticker tool the desktop app serves', () => {
    const names = buildMcpTools().map((tool) => tool.name);
    for (const name of [
      'search_elements',
      'add_shape',
      'set_shape_style',
      'set_element_animation',
    ]) {
      expect(names, name).toContain(name);
    }
    expect(names).not.toContain('add_sticker');
  });

  it('finds, draws, restyles and animates a callout, saves it, and undoes back to the start', async () => {
    const { projectPath, session } = await open();
    const before = await readProjectFile(projectPath);

    const found = parse(
      await callTool(session, null, 'search_elements', { query: 'arrow', kind: 'shape' }),
    ) as { results: { elementId: string }[] };
    expect(found.results.map((row) => row.elementId)).toContain('line-arrow');

    const added = parse(
      await callTool(session, null, 'add_shape', {
        shape: 'line-arrow/red',
        start: 1,
        end: 4,
        ends: { x1: 20, y1: 70, x2: 45, y2: 50 },
      }),
    ) as { applied: boolean };
    expect(added.applied).toBe(true);
    const arrow = clips(session.state()!.project).find((clip) => shapeClipParams(clip) !== null)!;

    for (const [name, args] of [
      ['set_shape_style', { clipId: arrow.id, stroke: 'white', strokeWidth: 1.2 }],
      ['set_element_animation', { clipId: arrow.id, in: { kind: 'pop' } }],
    ] as const) {
      const result = await callTool(session, null, name, args);
      expect(result.isError, name).toBeUndefined();
      expect((parse(result) as { applied: boolean }).applied, name).toBe(true);
    }

    await callTool(session, null, 'save_project', {});
    const saved = clips(await readProjectFile(projectPath)).find((clip) => clip.id === arrow.id)!;
    expect(shapeClipParams(saved)).toMatchObject({
      shape: 'line-arrow',
      stroke: '#FFFFFF',
      strokeWidth: 1.2,
      x2: 45,
      y2: 50,
    });
    expect(clipAnimation(saved).in?.kind).toBe('pop');

    for (let n = 0; n < 3; n += 1) await callTool(session, null, 'undo', {});
    expect(session.state()!.project.timeline).toEqual(before.timeline);
  });

  it('offers no sticker ids, and refuses add_sticker with what to do instead', async () => {
    const { session } = await open();
    const found = parse(await callTool(session, null, 'search_elements', { query: 'fire' })) as {
      results: { kind: string }[];
      note?: string;
    };
    expect(found.results.every((row) => row.kind === 'shape')).toBe(true);
    expect(found.note).toMatch(/desktop app/u);

    expect(() => session.runTool('add_sticker', { elementId: 'fire', start: 1 })).toThrow(
      SessionError,
    );
    const refused = await callTool(session, null, 'add_sticker', { elementId: 'fire', start: 1 });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/desktop app/u);
    expect(refused.content[0]!.text).toMatch(/add_shape/u);
  });
});
