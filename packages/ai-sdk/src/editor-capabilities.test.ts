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
        availability: { state: 'available', reason: 'Claimed.' },
      }),
    ).toThrow(/requires/i);
  });
});
