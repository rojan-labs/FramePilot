/**
 * P5.1's Done-when, as a test: "every controller and proposer is called through the
 * contract and a test asserts its input contains no field outside its declared slice."
 */
import { describe, expect, it } from 'vitest';
import { makeProject } from '../__fixtures__/project.js';
import { captureEditorInteractionContext } from '../editor-context/interaction-context.js';
import type { ColorEvidenceReader } from '../color-evidence.js';
import type { ToolContext } from '../tool-context.js';
import { getTool } from '../tool-registry.js';
import {
  AUDIO_SPECIALIST,
  AUTOMATIC_TRACKING_SPECIALIST,
  COLOR_SPECIALIST,
  CRITIC_SPECIALIST,
  DOMAIN_SPECIALISTS,
  MOTION_SPECIALIST,
  SPECIALIST_CONTEXT_KEYS,
  SUBJECT_DETECTION_SPECIALIST,
  SpecialistContractError,
  TIMELINE_SPECIALIST,
  TRACKING_MASK_SPECIALIST,
  defineSpecialist,
  runSpecialist,
  sliceOf,
} from './index.js';

/** Every field the sandbox can offer, all present — so a leak has something to leak. */
function fullContext(): Required<
  Pick<ToolContext, 'project' | 'projectRevision' | 'interaction'>
> & {
  readonly evidence: ColorEvidenceReader;
} {
  const project = makeProject();
  return {
    project,
    projectRevision: 7,
    interaction: captureEditorInteractionContext({
      project,
      projectRevision: 7,
      playheadSeconds: 1,
      selectedClipIds: ['clip_a'],
      primaryClipId: 'clip_a',
    }),
    evidence: { lookup: () => undefined } as unknown as ColorEvidenceReader,
  };
}

const ALL_SPECIALISTS = [...DOMAIN_SPECIALISTS, CRITIC_SPECIALIST];

describe('the specialist slice', () => {
  it.each(ALL_SPECIALISTS.map((specialist) => [specialist.name, specialist] as const))(
    '%s receives no field outside its declared slice',
    (_name, specialist) => {
      const context = sliceOf(specialist, fullContext());
      expect(Object.keys(context).sort()).toEqual([...specialist.slice].sort());
      for (const key of Object.keys(context)) {
        expect(specialist.slice).toContain(key);
      }
    },
  );

  it('declares slices only from the sandbox vocabulary', () => {
    for (const specialist of ALL_SPECIALISTS) {
      for (const key of specialist.slice) expect(SPECIALIST_CONTEXT_KEYS).toContain(key);
    }
  });

  it('gives the colour specialist host evidence and gives no other specialist any', () => {
    expect(COLOR_SPECIALIST.slice).toContain('evidence');
    for (const specialist of ALL_SPECIALISTS) {
      if (specialist.name === 'color') continue;
      expect(specialist.slice).not.toContain('evidence');
    }
  });

  it('gives the Critic the project and nothing else', () => {
    expect(CRITIC_SPECIALIST.slice).toEqual(['project']);
  });

  it.each([
    ['audio', AUDIO_SPECIALIST],
    ['motion', MOTION_SPECIALIST],
    ['timeline', TIMELINE_SPECIALIST],
    ['tracking_mask', TRACKING_MASK_SPECIALIST],
    ['automatic_tracking', AUTOMATIC_TRACKING_SPECIALIST],
    ['subject_detection', SUBJECT_DETECTION_SPECIALIST],
    ['critic', CRITIC_SPECIALIST],
  ] as const)('%s refuses an input carrying an undeclared field', (_name, specialist) => {
    const context = { ...sliceOf(specialist, fullContext()), evidence: {} };
    expect(() =>
      runSpecialist(specialist as never, {
        task: 'leak',
        context: context as never,
        constraints: {},
        inputs: {} as never,
      }),
    ).toThrow(SpecialistContractError);
  });
});

describe('runSpecialist', () => {
  const trivial = defineSpecialist<{ n: number }, { doubled: number }>({
    name: 'trivial',
    slice: ['project'],
    run: (input) => ({
      outputs: { doubled: input.inputs.n * 2 },
      artifacts: [{ kind: 'fact', name: 'n', value: input.inputs.n }],
      confidence: 1,
      errors: [],
    }),
  });

  const valid = {
    task: 'double',
    context: { project: makeProject() },
    constraints: {},
    inputs: { n: 2 },
  };

  it('validates in, runs, validates out', () => {
    expect(runSpecialist(trivial, valid).outputs).toEqual({ doubled: 4 });
  });

  it('rejects a missing task', () => {
    expect(() => runSpecialist(trivial, { ...valid, task: '' })).toThrow(
      /trivial specialist input violated its contract/,
    );
  });

  it('rejects an output that breaks the envelope', () => {
    const broken = defineSpecialist<undefined, undefined>({
      name: 'broken',
      slice: ['project'],
      run: () => ({ outputs: undefined, artifacts: [], confidence: 9, errors: [] }),
    });
    expect(() =>
      runSpecialist(broken, {
        task: 't',
        context: { project: makeProject() },
        constraints: {},
        inputs: undefined,
      }),
    ).toThrow(/broken specialist output violated its contract/);
  });
});

describe('the Critic specialist', () => {
  it('grades its confidence by the share of deterministic checks that held', () => {
    const output = runSpecialist(CRITIC_SPECIALIST, {
      task: 'verify',
      context: { project: makeProject() },
      constraints: {},
      inputs: {},
    });
    expect(output.confidence).toBeGreaterThan(0);
    expect(output.confidence).toBeLessThanOrEqual(1);
    expect(output.outputs.report.findings.length).toBeGreaterThan(0);
    // Every failing check is reported as an error, and no passing one is.
    const failing = output.outputs.report.findings.filter((f) => f.severity === 'fail');
    expect(output.errors.map((e) => e.code).sort()).toEqual(failing.map((f) => f.id).sort());
  });
});

describe('the professional tools go through the contract', () => {
  it('professional_motion refuses an objective its controller rejects, via the contract', () => {
    const tool = getTool('professional_motion');
    if (!tool || tool.kind !== 'mutate')
      throw new Error('professional_motion is not a mutate tool');
    const ctx = fullContext();
    expect(() =>
      tool.buildOps(
        {
          intent: 'animate_to',
          property: 'scale',
          value: 1.2,
          durationFrames: 30,
          target: 'this',
          constraintPolicy: 'property_bounds',
        },
        { ...ctx, interaction: { ...ctx.interaction, projectRevision: 999 } },
      ),
    ).toThrow(/professional_motion controller rejected/);
  });
});
