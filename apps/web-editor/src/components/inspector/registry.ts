/**
 * Registry for contextual inspector modules.
 *
 * Stable ids drive persisted disclosure state and tests. Display titles can evolve
 * with the editor's UX, while applicability and order remain pure data.
 */
import { hasClipSelection, type InspectorSelection } from './selection.js';

export interface InspectorSectionDef {
  readonly id: string;
  readonly title: string;
  readonly label: string;
  readonly order: number;
  readonly defaultOpen: boolean;
  readonly appliesTo: (selection: InspectorSelection) => boolean;
}

export const INSPECTOR_SECTIONS: readonly InspectorSectionDef[] = [
  {
    id: 'transform',
    title: 'Position & size',
    label: 'transform',
    order: 10,
    defaultOpen: true,
    appliesTo: hasClipSelection,
  },
  {
    id: 'text',
    title: 'Text',
    label: 'text',
    order: 20,
    defaultOpen: true,
    appliesTo: (selection) => hasClipSelection(selection) && selection.hasText,
  },
  {
    id: 'color',
    title: 'Adjust',
    label: 'color',
    order: 30,
    defaultOpen: true,
    appliesTo: hasClipSelection,
  },
  {
    id: 'speed',
    title: 'Speed',
    label: 'speed',
    order: 40,
    defaultOpen: true,
    appliesTo: hasClipSelection,
  },
  {
    id: 'audio',
    title: 'Audio',
    label: 'audio',
    order: 50,
    defaultOpen: true,
    appliesTo: (selection) => hasClipSelection(selection) && selection.hasAudio,
  },
  {
    id: 'crop',
    title: 'Crop',
    label: 'crop',
    order: 60,
    defaultOpen: false,
    appliesTo: hasClipSelection,
  },
  {
    id: 'blend',
    title: 'Blend',
    label: 'blend mode',
    order: 70,
    defaultOpen: false,
    appliesTo: hasClipSelection,
  },
  {
    id: 'transition',
    title: 'Transition',
    label: 'transition',
    order: 80,
    defaultOpen: true,
    appliesTo: (selection) => selection.hasTransition,
  },
  {
    id: 'mask',
    title: 'Mask',
    label: 'mask',
    order: 90,
    defaultOpen: false,
    appliesTo: hasClipSelection,
  },
  {
    id: 'effects',
    title: 'Applied effects',
    label: 'effects',
    order: 100,
    defaultOpen: false,
    appliesTo: hasClipSelection,
  },
];

export function visibleSections(
  selection: InspectorSelection,
  sections: readonly InspectorSectionDef[] = INSPECTOR_SECTIONS,
): readonly InspectorSectionDef[] {
  return sections
    .filter((section) => section.appliesTo(selection))
    .sort((a, b) => a.order - b.order);
}

export function sectionById(
  id: string,
  sections: readonly InspectorSectionDef[] = INSPECTOR_SECTIONS,
): InspectorSectionDef | undefined {
  return sections.find((section) => section.id === id);
}
