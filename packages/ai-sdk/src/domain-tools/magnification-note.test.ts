/**
 * `magnificationNote` — how far a zoom magnifies the source, said in the zoom's result.
 *
 * Harness run 8's road shot at 17 s was visibly soft: a punch-in on a panned 16:9 clip
 * multiplies the pan's ~3.16× cover zoom, so the 1080p picture was magnified far past its
 * own pixels, and nothing the model read said so. The numbers below are the render
 * compiler's placement arithmetic (`framePlanAt`) for a 16:9 source in a 1080×1920 frame:
 *
 *   fit = min(1080/W, 1920/H); cover = 3.1605 × fit; magnification = cover × punch
 *   1920×1080 → 0.5625 × 3.1605 = 1.78   3840×2160 → 0.28125 × 3.1605 = 0.89
 */
import { describe, expect, it } from 'vitest';
import { applyProjectPatch, type AnyOperation } from '@framepilot/editor-core';
import type { Project } from '@framepilot/timeline-schema';
import { assembleEdit } from '../assemble.js';
import { getTool } from '../tool-registry.js';
import { makeProject } from '../__fixtures__/project.js';
import { Orchestrator } from '../orchestrator.js';
import type { AiCompletionRequest, AiProvider, AiResponse } from '../providers/types.js';
import {
  magnificationNote,
  peakMagnification,
  SOFT_UPSCALE_THRESHOLD,
} from './magnification-note.js';

const HD = { width: 1920, height: 1080 };
const UHD = { width: 3840, height: 2160 };

/** `media: null` = a source whose size was never probed. */
function projectWith(
  media: { width: number; height: number } | null,
  resolution: { width: number; height: number } = { width: 1080, height: 1920 },
): Project {
  return makeProject({
    fps: 30,
    resolution,
    assets: [
      {
        id: 'road',
        path: 'media/road.mp4',
        kind: 'video',
        durationSeconds: 20,
        ...(media === null ? {} : { media }),
      },
    ],
    timeline: {
      tracks: [
        {
          id: 'v1',
          type: 'video',
          clips: [
            {
              id: 'shot',
              assetId: 'road',
              trackId: 'v1',
              start: 0,
              end: 4,
              sourceStart: 2,
              sourceEnd: 6,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    },
  } as never);
}

function run(tool: string, project: Project, args: Record<string, unknown>): Project {
  const spec = getTool(tool);
  if (!spec || spec.kind !== 'mutate') throw new Error(`${tool} is not a mutate tool`);
  const ops = spec.buildOps!({ clipId: 'shot', ...args }, { project }) as AnyOperation[];
  const edit = assembleEdit(project, ops, tool, 'agent');
  expect(edit.validation.valid).toBe(true);
  return applyProjectPatch(project, edit.patch);
}

const PAN = { from: { x: 0.3 }, to: { x: 0.7 } };

describe('peakMagnification', () => {
  it('reads the pan cover zoom against the source pixels, not against the fit', () => {
    const panned = run('reframe_pan', projectWith(HD), PAN);
    expect(peakMagnification(panned, 'shot')).toMatchObject({
      magnification: 1.78,
      source: HD,
    });
    expect(
      peakMagnification(run('reframe_pan', projectWith(UHD), PAN), 'shot')?.magnification,
    ).toBe(0.89);
  });

  it('finds the peak of a punch at the end of its window, multiplied onto the pan', () => {
    const panned = run('reframe_pan', projectWith(HD), PAN);
    const punched = run('punch_in', panned, {
      fromScale: 1,
      toScale: 1.2,
      startTime: 1,
      endTime: 3,
    });
    // 1.7778 × 1.2 = 2.13, held from the window's end to the clip's.
    const peak = peakMagnification(punched, 'shot')!;
    expect(peak.magnification).toBe(2.13);
    expect(peak.clipSeconds).toBe(3);
  });

  it('has no number to give for a source that was never measured, or a missing clip', () => {
    expect(peakMagnification(projectWith(null), 'shot')).toBeNull();
    expect(peakMagnification(projectWith(HD), 'nope')).toBeNull();
  });
});

describe('magnificationNote', () => {
  it('names a punch on a panned 1080p clip as an upscale, and that the pan already was one', () => {
    const panned = run('reframe_pan', projectWith(HD), PAN);
    const punched = run('punch_in', panned, { fromScale: 1, toScale: 1.2 });
    const note = magnificationNote('punch_in', panned, punched, { clipId: 'shot' });
    expect(note).toContain('1920×1080 source magnified 2.13× in the 1080×1920 frame');
    expect(note).toContain('will look soft');
    expect(note).toContain('Before this punch it was already 1.78×');
  });

  it('points a punch that took a sharp picture past the threshold at a smaller zoom', () => {
    // 4K in a 1080p 16:9 frame fits at 0.5, so a 2.5× punch draws each pixel 1.25 wide.
    const base = projectWith(UHD, HD);
    const punched = run('punch_in', base, { fromScale: 1, toScale: 2.5 });
    const note = magnificationNote('punch_in', base, punched, { clipId: 'shot' });
    expect(note).toContain('magnified 1.25×');
    expect(note).toContain('A smaller toScale keeps it sharper.');
    expect(note).not.toContain('Before this punch');
  });

  it('says a zoom inside the source resolution keeps its detail', () => {
    const base = projectWith(UHD, HD);
    const punched = run('punch_in', base, { fromScale: 1, toScale: 1.5 });
    const note = magnificationNote('punch_in', base, punched, { clipId: 'shot' });
    expect(note).toContain('magnified 0.75×');
    expect(note).toContain('no upscale');
    expect(note).not.toContain('soft');
  });

  it('treats exactly one output pixel per source pixel as sharp, not upscaled', () => {
    expect(SOFT_UPSCALE_THRESHOLD).toBe(1);
    const base = projectWith(HD, HD);
    const punched = run('punch_in', base, { fromScale: 1, toScale: 1 });
    const note = magnificationNote('punch_in', base, punched, { clipId: 'shot' });
    expect(note).toContain('magnified 1×');
    expect(note).toContain('no upscale');
  });

  it('tells a pan that upscales that any punch on top magnifies it further', () => {
    const base = projectWith(HD);
    const panned = run('reframe_pan', base, PAN);
    const note = magnificationNote('reframe_pan', base, panned, { clipId: 'shot' });
    expect(note).toContain('magnified 1.78×');
    expect(note).toContain('will look soft');
    expect(note).toContain('any punch_in on top magnifies it further');
  });

  it('says nothing for other tools, an unmeasured source, or arguments with no clip', () => {
    const base = projectWith(HD);
    const panned = run('reframe_pan', base, PAN);
    expect(magnificationNote('add_keyframes', base, panned, { clipId: 'shot' })).toBe('');
    expect(magnificationNote('reframe_pan', base, panned, {})).toBe('');
    expect(magnificationNote('reframe_pan', base, panned, null)).toBe('');
    const unmeasured = projectWith(null);
    const punched = run('punch_in', unmeasured, { toScale: 1.2 });
    expect(magnificationNote('punch_in', unmeasured, punched, { clipId: 'shot' })).toBe('');
  });
});

describe('the zoom result the model reads', () => {
  it('carries the magnification after a punch lands on a pan', async () => {
    const requests: AiCompletionRequest[] = [];
    class Provider implements AiProvider {
      public readonly name = 'mock' as const;
      private turn = 0;
      public async complete(request: AiCompletionRequest): Promise<AiResponse> {
        requests.push(request);
        const responses: AiResponse[] = [
          {
            text: '',
            toolCalls: [{ id: 'p1', name: 'reframe_pan', arguments: { clipId: 'shot', ...PAN } }],
          },
          {
            text: '',
            toolCalls: [
              { id: 'z1', name: 'punch_in', arguments: { clipId: 'shot', toScale: 1.2 } },
            ],
          },
          { text: 'Panned and punched in.', toolCalls: [] },
        ];
        return responses[Math.min(this.turn++, responses.length - 1)]!;
      }
    }
    await new Orchestrator(new Provider()).agent(
      { project: projectWith(HD), userPrompt: 'Pan across the road and punch in' },
      { maxSteps: 4 },
    );
    const seen = JSON.stringify(requests.at(-1));
    expect(seen).toContain('magnified 1.78×');
    expect(seen).toContain('magnified 2.13×');
  });
});
