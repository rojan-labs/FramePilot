import { COMMAND_REJECTION_CODES } from '@framepilot/editor-core';
import { describe, expect, it } from 'vitest';
import {
  AUDIO_PARAMETER_CONTRACTS,
  CLIP_KEYFRAME_PROPERTIES,
  COLOR_GRADE_PARAMETER_CONTRACTS,
  EDITOR_COMMAND_TYPES,
} from '@framepilot/editor-core';
import { PROFESSIONAL_EDIT_INTENTS } from './domain-tools/professional-edit.js';
import {
  EDITOR_CAPABILITIES,
  EditorCapabilitySchema,
  editorCapabilityDriftIssues,
  listEditorCapabilities,
} from './editor-capabilities.js';
import { TOOL_REGISTRY } from './tool-registry.js';

describe('editor capability registry', () => {
  it('advertises every professional command exactly once through the domain tool', () => {
    const timeline = listEditorCapabilities({ domain: 'timeline', availability: 'available' });

    expect(timeline.map((capability) => capability.commandType).sort()).toEqual(
      [...EDITOR_COMMAND_TYPES].sort(),
    );
    expect(timeline.map((capability) => capability.id.replace('timeline.', '')).sort()).toEqual(
      [...PROFESSIONAL_EDIT_INTENTS].sort(),
    );
    expect(new Set(timeline.map((capability) => capability.tool))).toEqual(
      new Set(['professional_edit']),
    );
  });

  it('derives motion, color, and audio property metadata from runtime contracts', () => {
    const motion = listEditorCapabilities({ domain: 'motion' });
    expect(motion.map((capability) => capability.id.replace('motion.clip.', ''))).toEqual(
      CLIP_KEYFRAME_PROPERTIES,
    );
    expect(motion.every((capability) => capability.keyframeable)).toBe(true);
    expect(motion.find((capability) => capability.id.endsWith('.opacity'))?.value.bounds).toEqual({
      min: 0,
      max: 1,
    });

    const color = listEditorCapabilities({ domain: 'color' });
    expect(
      Object.fromEntries(color.map((capability) => [capability.id, capability.value.bounds])),
    ).toEqual(
      Object.fromEntries(
        Object.entries(COLOR_GRADE_PARAMETER_CONTRACTS).map(([name, bounds]) => [
          `color.clip.${name}`,
          bounds,
        ]),
      ),
    );
    const audio = listEditorCapabilities({ domain: 'audio' });
    expect(audio[0]?.value.bounds).toEqual(AUDIO_PARAMETER_CONTRACTS.gainDb);
    expect(new Set(audio.map((capability) => capability.tool))).toEqual(
      new Set(['professional_audio']),
    );
    expect(
      audio.find((capability) => capability.id.endsWith('sidechain_duck'))?.value.bounds,
    ).toEqual(AUDIO_PARAMETER_CONTRACTS.duckAmountDb);
  });

  it('advertises only manual existing-mask tracking as executable', () => {
    const tracking = listEditorCapabilities({ domain: 'tracking_mask' });
    expect(tracking).toEqual([
      expect.objectContaining({
        id: 'tracking_mask.manual_mask_track',
        editable: true,
        tool: 'professional_tracking_mask',
        availability: { state: 'available', reason: expect.any(String) },
      }),
      expect.objectContaining({
        id: 'tracking_mask.automatic_subject_track',
        editable: false,
        availability: { state: 'unavailable', reason: expect.stringMatching(/Capability Pack/) },
      }),
    ]);
  });

  it('filters by target and editability without returning mutable registry storage', () => {
    const clipCapabilities = listEditorCapabilities({ appliesTo: 'clip', editable: true });

    expect(clipCapabilities.length).toBeGreaterThan(0);
    expect(clipCapabilities.every((capability) => capability.appliesTo.includes('clip'))).toBe(
      true,
    );
    clipCapabilities.pop();
    expect(listEditorCapabilities({ appliesTo: 'clip', editable: true }).length).toBeGreaterThan(
      clipCapabilities.length,
    );
  });

  it('has no drift against live tool and command registries', () => {
    expect(editorCapabilityDriftIssues(EDITOR_CAPABILITIES, TOOL_REGISTRY)).toEqual([]);
  });

  it('reports duplicate ids, missing tools, non-mutators, and unadvertised commands', () => {
    const roll = EDITOR_CAPABILITIES.find((capability) => capability.id === 'timeline.roll')!;
    const issues = editorCapabilityDriftIssues(
      [roll, roll],
      [{ name: 'professional_edit', available: false, mutates: false }],
      ['roll_edit', 'slip_edit'],
    );

    expect(issues).toEqual(
      expect.arrayContaining([
        { capabilityId: 'timeline.roll', message: 'Duplicate capability id.' },
        {
          capabilityId: 'timeline.roll',
          message: 'Tool professional_edit is not an available mutator.',
        },
        { capabilityId: 'command:slip_edit', message: 'Compiler command is not advertised.' },
      ]),
    );
  });

  it('rejects available editable claims that omit executable contracts', () => {
    expect(() =>
      EditorCapabilitySchema.parse({
        id: 'motion.fake',
        kind: 'property',
        domain: 'motion',
        appliesTo: ['clip'],
        value: { kind: 'number', unit: 'ratio' },
        keyframeable: true,
        inspectable: true,
        editable: true,
        operationTypes: [],
        // Present so the parse fails on the MISSING CONTRACT this test is about, not on a
        // missing description.
        description: 'A fake capability used to prove the contract gate rejects it.',
        availability: { state: 'available', reason: 'Claimed.' },
      }),
    ).toThrow(/requires/i);
  });
});

describe('declared time domains match the command signatures', () => {
  /**
   * Pinned against `professional-commands.ts`'s own interfaces, which are the authority:
   * `roll_edit.delta` is `FrameDelta<'sequence'>`, `slip_edit.delta` is `FrameDelta<'source'>`,
   * `insert_edit` carries a sequence `at` AND a source `sourceRange`, `lift_edit` carries only
   * clip ids. A phantom type parameter disappears at runtime, so without this table the
   * registry could drift from the commands silently — which is the exact failure mode ADR 0076
   * calls invisible.
   */
  const EXPECTED: Readonly<Record<string, readonly ('sequence' | 'source')[]>> = {
    'timeline.roll': ['sequence'],
    'timeline.slip': ['source'],
    'timeline.slide': ['sequence'],
    'timeline.ripple_trim': ['sequence'],
    'timeline.lift': [],
    'timeline.extract': [],
    'timeline.insert': ['sequence', 'source'],
    'timeline.overwrite': ['sequence', 'source'],
    'timeline.replace': ['source'],
    'timeline.j_cut': ['sequence'],
    'timeline.l_cut': ['sequence'],
    'timeline.switch_angle': ['sequence'],
  };

  it('declares the right timebase for every timeline command', () => {
    const timeline = listEditorCapabilities({ domain: 'timeline' });
    // Every timeline command is accounted for, so a NEW command cannot slip in undeclared.
    expect(timeline.map((c) => c.id).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const capability of timeline) {
      expect(capability.timeDomains, capability.id).toEqual(EXPECTED[capability.id]);
    }
  });

  it('is the one place slip differs from every other trim-shaped command', () => {
    // Slip moves the SOURCE window under a fixed sequence span. Getting this backwards
    // produces an edit that looks right in the timeline and is wrong in playback.
    const byId = new Map(listEditorCapabilities().map((c) => [c.id, c]));
    expect(byId.get('timeline.slip')?.timeDomains).toEqual(['source']);
    expect(byId.get('timeline.slide')?.timeDomains).toEqual(['sequence']);
  });

  it('leaves property capabilities without a timebase', () => {
    // Colour, audio and motion values are not times. Declaring one would invite the model to
    // convert something that has no timebase to convert.
    for (const capability of listEditorCapabilities()) {
      if (capability.kind === 'property') {
        expect(capability.timeDomains, capability.id).toEqual([]);
      }
    }
  });
});

describe('capabilities republish their command preconditions', () => {
  it('gives every timeline command a non-empty precondition set', () => {
    for (const capability of listEditorCapabilities({ domain: 'timeline' })) {
      expect(capability.preconditions.length, capability.id).toBeGreaterThan(0);
      // The authority check runs before every dispatch, so it is always among them.
      expect(capability.preconditions, capability.id).toContain('stale_timeline');
    }
  });

  it('matches editor-core, which is the authority', () => {
    for (const capability of listEditorCapabilities({ domain: 'timeline' })) {
      const commandType = capability.commandType;
      expect(commandType, capability.id).toBeDefined();
      expect(capability.preconditions).toEqual([
        ...COMMAND_REJECTION_CODES[commandType as keyof typeof COMMAND_REJECTION_CODES],
      ]);
    }
  });

  it('carries the codes a UI needs to explain a refused roll', () => {
    const roll = listEditorCapabilities().find((c) => c.id === 'timeline.roll');
    // The two that are specific to roll, not inherited from the shared helpers.
    expect(roll?.preconditions).toContain('not_adjacent');
    expect(roll?.preconditions).toContain('different_tracks');
  });

  it('leaves property capabilities without preconditions', () => {
    // A colour or gain value has no command to refuse it.
    for (const capability of listEditorCapabilities()) {
      if (capability.kind === 'property') {
        expect(capability.preconditions, capability.id).toEqual([]);
      }
    }
  });
});

describe('every capability describes itself', () => {
  it('carries a description a UI could render without parsing tool prose', () => {
    for (const capability of listEditorCapabilities()) {
      expect(capability.description.length, capability.id).toBeGreaterThan(20);
      // A description that just restates the id teaches a reader nothing.
      const words = capability.id.split(/[._]/);
      expect(capability.description.toLowerCase(), capability.id).not.toBe(words.join(' '));
    }
  });

  it('describes the mechanism, so slip and slide can be told apart', () => {
    // The single most confusable pair in the command set, and the reason these say what stays
    // FIXED rather than only what moves.
    const byId = new Map(listEditorCapabilities().map((c) => [c.id, c]));
    expect(byId.get('timeline.slip')?.description).toMatch(/without moving the clip/i);
    expect(byId.get('timeline.slide')?.description).toMatch(/neighbours/i);
    expect(byId.get('timeline.lift')?.description).toMatch(/leave the gap/i);
    expect(byId.get('timeline.extract')?.description).toMatch(/close the gap/i);
  });

  it('says plainly when a capability is unavailable', () => {
    const automatic = listEditorCapabilities().find(
      (c) => c.id === 'tracking_mask.automatic_subject_track',
    );
    expect(automatic?.availability.state).toBe('unavailable');
    expect(automatic?.description).toMatch(/not available/i);
  });

  it('gives every capability a distinct description', () => {
    const all = listEditorCapabilities().map((c) => c.description);
    expect(new Set(all).size).toBe(all.length);
  });
});
