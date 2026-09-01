/**
 * Contextual, tab-driven inspector for clip and effect-layer properties.
 *
 * The editing behavior remains owned by focused section modules and typed patch
 * builders. This shell follows the interaction model used by modern desktop editors:
 * a compact selection header, contextual category tabs, and a focused property page.
 */
import { useMemo, useState } from 'react';
import { Button } from '@framepilot/ui';
import type { UseEditor } from '../editor/useEditor.js';
import {
  MASK_SHAPES,
  type MaskShapeName,
  addMaskPatch,
  removeEffectLayerPatch,
  setEffectLayerEnabledPatch,
  setEffectLayerParamsPatch,
} from '../editor/patch-builders.js';
import { EffectInspector } from './EffectInspector.js';
import { MaskPackActions } from './inspector/MaskPackActions.js';
import { ScrubNumber } from './ScrubNumber.js';
import {
  ArrowLeftRight,
  AudioLines,
  Copy,
  Crop as CropIcon,
  Gauge,
  ICON_SIZE,
  Layers,
  Palette,
  RotateCcw,
  Scan,
  SlidersHorizontal,
  Sparkles,
  Type,
  type LucideIcon,
} from './icons.js';
import { Tooltip } from './Tooltip.js';
import { InspectorRow } from './inspector/InspectorRow.js';
import { InspectorSection } from './inspector/InspectorSection.js';
import { LabeledSelect } from './inspector/LabeledSelect.js';
import { visibleSections, type InspectorSectionDef } from './inspector/registry.js';
import { resolveInspectorSelection } from './inspector/selection.js';
import { useSectionState } from './inspector/useSectionState.js';
import { sharedFrom } from './inspector/mixed.js';
import {
  IDENTITY_TRANSFORM,
  applyClipPropertiesPatch,
  readClipProperties,
  type ClipProperties,
} from './inspector/clipProperties.js';
import { AudioPanel } from './inspector/sections/AudioSection.js';
import { ColorPanel } from './inspector/sections/ColorSection.js';
import { SpeedPanel } from './inspector/sections/SpeedSection.js';
import { CropPanel } from './inspector/sections/CropSection.js';
import { BlendModePanel } from './inspector/sections/BlendSection.js';
import { TransitionPanel } from './inspector/sections/TransitionSection.js';
import { TextOverlayInspector } from './inspector/sections/TextSection.js';
import { TransformPanel } from './inspector/sections/TransformSection.js';
import { oneOf, useViewPreference } from '../editor/useViewPreference.js';
import './Inspector.css';

export interface InspectorProps {
  readonly editor: UseEditor;
  /** Project frame rate, for source-range math in pack-driven mask jobs. */
  readonly fps?: number;
  /** Selected effect layers take precedence over clip selection. */
  readonly selectedEffectLayerIds?: readonly string[];
  readonly onClearEffectLayers?: () => void;
}

const INSPECTOR_TAB_IDS = [
  'basic',
  'text',
  'audio',
  'color',
  'mask',
  'transition',
  'effects',
] as const;

type InspectorTabId = (typeof INSPECTOR_TAB_IDS)[number];

/**
 * The tab the Inspector opens on — remembered between sessions.
 *
 * "Preferred" is the right word: the Inspector still follows the SELECTION first (a
 * transition selects the Transition tab, a caption the Text tab), so this only decides
 * where an ordinary clip lands. Someone grading a cut lives in Color and someone mixing
 * lives in Audio, and sending both back to Basic on every open is a click each of them
 * pays forever.
 */
const coerceInspectorTab = oneOf<InspectorTabId>(INSPECTOR_TAB_IDS);

interface InspectorTab {
  readonly id: InspectorTabId;
  readonly label: string;
}

const INSPECTOR_TABS: readonly InspectorTab[] = [
  { id: 'basic', label: 'Basic' },
  { id: 'text', label: 'Text' },
  { id: 'audio', label: 'Audio' },
  { id: 'color', label: 'Color' },
  { id: 'mask', label: 'Mask' },
  { id: 'transition', label: 'Transition' },
  { id: 'effects', label: 'Effects' },
];

const SECTION_TABS: Readonly<Record<string, InspectorTabId>> = {
  transform: 'basic',
  speed: 'basic',
  crop: 'basic',
  blend: 'basic',
  text: 'text',
  audio: 'audio',
  color: 'color',
  mask: 'mask',
  transition: 'transition',
  effects: 'effects',
};

const SECTION_ICONS: Readonly<Record<string, LucideIcon>> = {
  transform: SlidersHorizontal,
  text: Type,
  color: Palette,
  speed: Gauge,
  audio: AudioLines,
  crop: CropIcon,
  blend: Layers,
  transition: ArrowLeftRight,
  mask: Scan,
  effects: Sparkles,
};

/** What reset-all writes. Timing, transitions, fades, and ducking remain edit decisions. */
const identityProperties = (from: ClipProperties): ClipProperties => ({
  transform: IDENTITY_TRANSFORM,
  grade: {
    exposure: 0,
    contrast: 0,
    saturation: 0,
    temperature: 0,
    tint: 0,
    shadows: 0,
    highlights: 0,
  },
  speed: 1,
  crop: { x: 0, y: 0, width: 1, height: 1 },
  blendMode: 'normal',
  audio: { ...from.audio, gainDb: 0, muted: false, normalize: false },
});

function displayClipKind(trackType: string): string {
  return `${trackType.charAt(0).toUpperCase()}${trackType.slice(1)} clip`;
}

function sectionIcon(sectionId: string): JSX.Element {
  const Icon = SECTION_ICONS[sectionId] ?? SlidersHorizontal;
  return <Icon size={ICON_SIZE.sm} />;
}

function tabForSection(sectionId: string): InspectorTabId {
  return SECTION_TABS[sectionId] ?? 'basic';
}

export function Inspector({
  editor,
  fps = 30,
  selectedEffectLayerIds = [],
  onClearEffectLayers = () => {},
}: InspectorProps): JSX.Element {
  const { selection: selectionId, selectedIds, timeline, playhead } = editor.state;
  const selection = useMemo(
    () => resolveInspectorSelection(timeline, selectionId, selectedIds, selectedEffectLayerIds),
    [timeline, selectionId, selectedIds, selectedEffectLayerIds],
  );
  const sections = useMemo(() => visibleSections(selection), [selection]);
  const tabs = useMemo(
    () =>
      INSPECTOR_TABS.filter((tab) =>
        sections.some((section) => tabForSection(section.id) === tab.id),
      ),
    [sections],
  );
  const sectionState = useSectionState();

  const [preferredTab, setPreferredTab] = useViewPreference<InspectorTabId>(
    'inspectorTab',
    'basic',
    coerceInspectorTab,
  );
  const [copied, setCopied] = useState<ClipProperties | null>(null);
  const [maskShape, setMaskShape] = useState<MaskShapeName>('ellipse');
  const [maskFeather, setMaskFeather] = useState(0);
  const [maskOpacity, setMaskOpacity] = useState(1);

  if (selection.kind === 'effect-layer' && selection.effectLayer !== null) {
    const { layer } = selection.effectLayer;
    return (
      <section className="inspector inspector-pro inspector-pro-effect" aria-label="inspector">
        <header className="inspector-clipbar">
          <span className="inspector-clip-icon" aria-hidden="true">
            <Sparkles size={ICON_SIZE.md} />
          </span>
          <div className="inspector-clip-copy">
            <strong>Effect layer</strong>
            <span title={layer.id}>{layer.id}</span>
          </div>
        </header>
        <nav className="inspector-tabs" aria-label="effect inspector categories">
          <span className="inspector-tab is-active">Effect</span>
        </nav>
        {selection.effectLayerIds.length > 1 && (
          <p className="inspector-multi">
            {selection.effectLayerIds.length} effects selected. Editing the first.
          </p>
        )}
        <div className="inspector-tab-page inspector-effect-page">
          <EffectInspector
            layer={layer}
            onPreview={(params) => {
              void params;
            }}
            onCommit={(params, intensity) => {
              const patch = setEffectLayerParamsPatch(timeline, layer.id, params, intensity);
              if (patch) editor.applyPatch(patch);
            }}
            onToggleEnabled={(enabled) => {
              const patch = setEffectLayerEnabledPatch(timeline, layer.id, enabled);
              if (patch) editor.applyPatch(patch);
            }}
            onRemove={() => {
              const patch = removeEffectLayerPatch(timeline, layer.id);
              if (patch) editor.applyPatch(patch);
              onClearEffectLayers();
            }}
          />
        </div>
      </section>
    );
  }

  if (selection.primary === null) {
    return (
      // Four elements said one thing: a glyph in a filled tile, a tracked all-caps
      // `PROPERTIES` kicker, "It's empty here", and the instruction. The kicker
      // repeated the panel's own tab, and "It's empty here" described the panel
      // rather than telling the user anything. What is left names the state and
      // gives the one action that leaves it.
      <section className="inspector inspector-pro inspector-empty-state" aria-label="inspector">
        <span className="inspector-empty-icon" aria-hidden="true">
          <SlidersHorizontal size={ICON_SIZE.lg} />
        </span>
        <h2>Nothing selected</h2>
        <p className="inspector-empty">
          Click a clip, transition, text layer or effect on the timeline to edit it here.
        </p>
      </section>
    );
  }

  const { clip, track } = selection.primary;
  const clipRelative = Math.max(0, Math.min(clip.end - clip.start, playhead - clip.start));
  const targetIds = selection.clips.map((location) => location.clip.id);
  const multi = selection.kind === 'multi-clip';
  const sharedTrack = sharedFrom(selection.clips, (location) => location.track.id);
  const clipKind = displayClipKind(track.type);
  const activeTab = tabs.some((tab) => tab.id === preferredTab) ? preferredTab : 'basic';
  const activeTabLabel = INSPECTOR_TABS.find((tab) => tab.id === activeTab)?.label ?? 'Basic';

  const applyProperties = (properties: ClipProperties, reason: string): void => {
    const patch = applyClipPropertiesPatch(timeline, targetIds, properties, reason);
    if (patch) editor.applyPatch(patch);
  };

  const applyMask = (): void => {
    const patch = addMaskPatch(timeline, clip.id, maskShape, maskFeather, maskOpacity);
    if (patch) editor.applyPatch(patch);
  };

  const sectionBody = (section: InspectorSectionDef): JSX.Element | null => {
    switch (section.id) {
      case 'transform':
        return (
          <TransformPanel
            key={`${clip.id}-transform`}
            editor={editor}
            clip={clip}
            clipTime={clipRelative}
          />
        );
      case 'text':
        return <TextOverlayInspector key={`text-${clip.id}`} editor={editor} clip={clip} />;
      case 'color':
        return <ColorPanel key={clip.id} editor={editor} clip={clip} />;
      case 'speed':
        return <SpeedPanel key={`${clip.id}-speed`} editor={editor} clip={clip} />;
      case 'audio':
        return <AudioPanel key={`${clip.id}-audio`} editor={editor} clip={clip} track={track} />;
      case 'crop':
        return <CropPanel key={`${clip.id}-crop`} editor={editor} clip={clip} />;
      case 'blend':
        return <BlendModePanel key={`${clip.id}-blend`} editor={editor} clip={clip} />;
      case 'transition':
        return <TransitionPanel key={`${clip.id}-transition`} editor={editor} clip={clip} />;
      case 'mask':
        return (
          <div className="inspector-subpanel" aria-label="add-mask">
            <LabeledSelect
              caption="Shape"
              label="mask shape"
              value={maskShape}
              options={MASK_SHAPES}
              onChange={(value) => setMaskShape(value as MaskShapeName)}
            />
            <ScrubNumber
              label="Feather"
              ariaLabel="mask feather"
              value={maskFeather}
              min={0}
              max={0.5}
              step={0.01}
              defaultValue={0}
              onChange={setMaskFeather}
            />
            <ScrubNumber
              label="Opacity"
              ariaLabel="mask opacity"
              value={maskOpacity}
              min={0}
              max={1}
              step={0.05}
              defaultValue={1}
              onChange={setMaskOpacity}
            />
            <Button variant="secondary" type="button" onClick={applyMask}>
              Add mask
            </Button>
            <MaskPackActions editor={editor} clip={clip} fps={fps} />
          </div>
        );
      case 'effects':
        return clip.effects.length === 0 ? (
          <p className="inspector-empty inspector-empty-inline">No clip effects applied.</p>
        ) : (
          <ul className="inspector-effect-list">
            {clip.effects.map((effect) => (
              <li key={effect.id}>
                <span>{effect.type}</span>
                <code title={effect.id}>{effect.id}</code>
              </li>
            ))}
          </ul>
        );
      default:
        return null;
    }
  };

  return (
    <section className="inspector inspector-pro" aria-label="inspector">
      <header className="inspector-clipbar">
        <span className="inspector-clip-icon" aria-hidden="true">
          <Layers size={ICON_SIZE.md} />
        </span>
        <div className="inspector-clip-copy">
          <strong title={clip.id}>
            {multi ? `${selection.clips.length} clips selected` : clip.id}
          </strong>
          <span>
            {clipKind}
            {!sharedTrack.mixed && ` · ${track.id}`}
          </span>
        </div>
        <div className="inspector-clip-actions" role="group" aria-label="clip properties">
          <Tooltip label="Copy properties">
            <button
              type="button"
              className="inspector-icon-button"
              aria-label="copy properties"
              onClick={() => setCopied(readClipProperties(selection.primary!))}
            >
              <Copy size={ICON_SIZE.sm} aria-hidden="true" />
            </button>
          </Tooltip>
          <button
            type="button"
            className="inspector-text-button"
            aria-label="paste properties"
            disabled={copied === null}
            onClick={() => {
              if (copied !== null) {
                applyProperties(copied, `Paste properties onto ${targetIds.length} clip(s)`);
              }
            }}
          >
            Paste
          </button>
          {multi && (
            <button
              type="button"
              className="inspector-text-button"
              aria-label="apply to selected"
              onClick={() =>
                applyProperties(
                  readClipProperties(selection.primary!),
                  `Apply ${clip.id}'s properties to ${targetIds.length} clips`,
                )
              }
            >
              Apply all
            </button>
          )}
          <Tooltip label="Reset all properties">
            <button
              type="button"
              className="inspector-icon-button"
              aria-label="reset all properties"
              onClick={() =>
                applyProperties(
                  identityProperties(readClipProperties(selection.primary!)),
                  `Reset properties on ${targetIds.length} clip(s)`,
                )
              }
            >
              <RotateCcw size={ICON_SIZE.sm} aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
      </header>

      <nav className="inspector-tabs" role="tablist" aria-label="inspector categories">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            className={`inspector-tab${activeTab === tab.id ? ' is-active' : ''}`}
            aria-selected={activeTab === tab.id}
            aria-controls="inspector-tab-panel"
            onClick={() => setPreferredTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {multi && (
        <p className="inspector-multi" aria-label="multi-selection">
          {selection.clips.length} clips selected. Editing {clip.id} as the primary clip. Shared
          changes apply to the selection.
        </p>
      )}

      <div
        id="inspector-tab-panel"
        className="inspector-tab-page"
        role="tabpanel"
        aria-label={`${activeTabLabel} controls`}
      >
        <div className="inspector-sections" aria-label="property sections">
          {sections.map((section) => (
            <div
              key={section.id}
              className="inspector-section-slot"
              hidden={tabForSection(section.id) !== activeTab}
            >
              <InspectorSection
                title={section.title}
                label={section.label}
                icon={sectionIcon(section.id)}
                open={sectionState.isOpen(section.id)}
                onToggle={(open) => sectionState.setOpen(section.id, open)}
              >
                {sectionBody(section)}
              </InspectorSection>
            </div>
          ))}
        </div>
      </div>

      <footer className="inspector-statusbar">
        <span>{sharedTrack.mixed ? 'Mixed tracks' : `${track.type} · ${track.id}`}</span>
        <span>
          {clip.start.toFixed(2)}s–{clip.end.toFixed(2)}s
        </span>
      </footer>
    </section>
  );
}

export { InspectorRow };
