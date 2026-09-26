/**
 * Cut-out edge styles in the Mask tab (MK9.2): the outline, glow and shadow drawn around what the
 * clip's mask stack keeps (a background removal, a drawn shape, a key).
 *
 * Shown once the clip has something to trace (an enabled mask limiting the clip, or the alpha of a
 * photo, sticker or title), or a style to remove. Each change is one `set_clip_edge_style` patch
 * through the editor's validated path, the operation the assistant uses too. Colours are stored as
 * 0–255 channels; the picker edits them as one hex value. The Sticker section shows the same
 * controls for an outline and a shadow, fewer of them (`EdgeStyleControls`, plan/elements EL6b.3).
 */
import { useState } from 'react';
import { Switch } from '@framepilot/ui';
import { syntheticClipKind } from '@framepilot/editor-core';
import {
  EDGE_STYLE_CATALOG,
  EDGE_STYLE_EFFECT_TYPE,
  EDGE_STYLE_PARAMS,
  clampEdgeStyleParams,
  masksOf,
  resolveEdgeStyleParams,
  type Asset,
  type Clip,
  type EdgeStyleKind,
} from '@framepilot/timeline-schema';
import { createLogger } from '@framepilot/shared-types';
import type { UseEditor } from '../../../editor/useEditor.js';
import { setClipEdgeStylePatch } from '../../../editor/patch-builders.js';
import { InspectorRow } from '../InspectorRow.js';
import { LabeledSelect } from '../LabeledSelect.js';
import { MaskNumberField } from './MaskNumberField.js';

const log = createLogger('web-editor:edge-styles');

/** The kinds in the order the panel lists them, top of the look first. */
const PANEL_KINDS: readonly { readonly kind: EdgeStyleKind; readonly label: string }[] = [
  { kind: 'stroke', label: 'Outline' },
  { kind: 'glow', label: 'Glow' },
  { kind: 'shadow', label: 'Shadow' },
];

const COLOUR_PARAMS = new Set(['red', 'green', 'blue']);

const hexOf = (params: Readonly<Record<string, number>>): string =>
  `#${['red', 'green', 'blue']
    .map((name) =>
      Math.round(params[name] ?? 0)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

const channelsOf = (hex: string): Record<string, number> => ({
  red: Number.parseInt(hex.slice(1, 3), 16),
  green: Number.parseInt(hex.slice(3, 5), 16),
  blue: Number.parseInt(hex.slice(5, 7), 16),
});

/** The clip's stored style of `kind`, clamped as the renderers read it, or `null`. */
function storedStyle(clip: Clip, kind: EdgeStyleKind): Record<string, number> | null {
  const effect = clip.effects.find(
    (candidate) => candidate.type === EDGE_STYLE_EFFECT_TYPE && candidate.params.kind === kind,
  );
  return effect === undefined ? null : clampEdgeStyleParams(kind, effect.params);
}

/**
 * Whether the clip has something to trace: an enabled mask limiting it, its own alpha (a photo,
 * a sticker or a title, plan/elements EL2b; an opaque photo's outline is a border), or a style
 * to remove.
 *
 * @param ownAlpha - The clip shows a still or a title, whose alpha is a cut-out of its own.
 */
export function showsEdgeStyles(clip: Clip, ownAlpha = false): boolean {
  const cuts = masksOf(clip).some((mask) => mask.enabled && mask.target.kind === 'alpha');
  return ownAlpha || cuts || clip.effects.some((effect) => effect.type === EDGE_STYLE_EFFECT_TYPE);
}

/** A still or a title: a clip whose picture carries an alpha of its own to trace. */
export function hasOwnAlpha(clip: Clip, assets: readonly Asset[]): boolean {
  if (syntheticClipKind(clip.assetId) === 'text') return true;
  return assets.find((asset) => asset.id === clip.assetId)?.kind === 'image';
}

export interface EdgeStylePanelProps {
  readonly editor: UseEditor;
  readonly clip: Clip;
}

export function EdgeStylePanel({ editor, clip }: EdgeStylePanelProps): JSX.Element | null {
  if (!showsEdgeStyles(clip, hasOwnAlpha(clip, editor.state.assets))) return null;
  return (
    <div className="inspector-subpanel edge-style-panel" role="group" aria-label="Edge style">
      {PANEL_KINDS.map(({ kind, label }) => (
        <EdgeStyleControls key={kind} editor={editor} clip={clip} kind={kind} label={label} />
      ))}
    </div>
  );
}

/** A control `EdgeStyleControls` can show once its style is on: the preset, the colour, a param. */
export type EdgeStyleField = 'preset' | 'colour' | (string & {});

export interface EdgeStyleControlsProps {
  readonly editor: UseEditor;
  readonly clip: Clip;
  readonly kind: EdgeStyleKind;
  /** "Outline", "Glow", "Shadow". */
  readonly label: string;
  /** What the style is drawn around, for the switch's name. */
  readonly around?: string;
  /** The controls shown once it is on (param names, `preset`, `colour`); all when absent. */
  readonly fields?: readonly EdgeStyleField[];
}

/** One edge style's switch and, once on, its controls. */
export function EdgeStyleControls({
  editor,
  clip,
  kind,
  label,
  around = 'the cut-out',
  fields,
}: EdgeStyleControlsProps): JSX.Element {
  const shows = (field: EdgeStyleField): boolean => fields === undefined || fields.includes(field);
  const [refused, setRefused] = useState(false);
  const commit = (params: Record<string, number> | null): void => {
    const patch = setClipEdgeStylePatch(editor.state.timeline, clip.id, kind, params);
    const issues = patch === null ? [] : editor.applyPatchChecked(patch);
    // Said, not only logged. The validator's words name clip ids, so they stay in the log.
    const refusedNow = patch === null || issues.length > 0;
    if (refusedNow) {
      log.warn('edge style refused', {
        kind,
        issues: issues.map((issue) => issue.message),
      });
    }
    setRefused(refusedNow);
  };
  const params = storedStyle(clip, kind);
  const presets = EDGE_STYLE_CATALOG.filter((entry) => entry.kind === kind);
  return (
    <div className="edge-style-kind">
      <InspectorRow label={label} name={`${label} edge style`}>
        <Switch
          checked={params !== null}
          label={`${label} around ${around}`}
          onCheckedChange={(on) => commit(on ? resolveEdgeStyleParams(presets[0]!) : null)}
        />
      </InspectorRow>
      {/* Mounted empty, so the region is there before it has anything to say. */}
      <p className="inspector-note live-slot" role="status">
        {refused
          ? `The ${label.toLowerCase()} was not changed. Pick a preset, or turn it off and on.`
          : ''}
      </p>
      {params !== null && (
        <>
          {shows('preset') && (
            <LabeledSelect
              caption="Preset"
              label={`${label} preset`}
              value={
                presets.find((entry) =>
                  Object.entries(resolveEdgeStyleParams(entry)).every(
                    ([name, value]) => params[name] === value,
                  ),
                )?.id ?? 'custom'
              }
              options={['custom', ...presets.map((entry) => entry.id)]}
              labels={['Custom', ...presets.map((entry) => entry.label)]}
              onChange={(id) => {
                const entry = presets.find((candidate) => candidate.id === id);
                if (entry !== undefined) commit(resolveEdgeStyleParams(entry));
              }}
            />
          )}
          {shows('colour') && (
            <InspectorRow label="Colour" name={`${label} colour`}>
              <input
                type="color"
                className="edge-style-colour"
                aria-label={`${label} colour`}
                value={hexOf(params)}
                onChange={(event) => commit({ ...params, ...channelsOf(event.target.value) })}
              />
            </InspectorRow>
          )}
          {EDGE_STYLE_PARAMS[kind]
            .filter((descriptor) => !COLOUR_PARAMS.has(descriptor.name) && shows(descriptor.name))
            .map((descriptor) => (
              <MaskNumberField
                key={descriptor.name}
                label={descriptor.label}
                name={`${label} ${descriptor.label.toLowerCase()}`}
                value={params[descriptor.name] ?? descriptor.default}
                min={descriptor.min}
                max={descriptor.max}
                step={descriptor.step}
                {...(descriptor.unit === undefined ? {} : { unit: descriptor.unit })}
                onCommit={(value) => commit({ ...params, [descriptor.name]: value })}
              />
            ))}
        </>
      )}
    </div>
  );
}
