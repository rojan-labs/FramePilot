/**
 * Persisted open/collapsed state for inspector sections (revamp Phase 4, F6).
 *
 * The old sections were `<details open>` with the attribute hardcoded, so every
 * section was expanded on every render and a user who collapsed Crop found it open
 * again the moment they selected a different clip. Collapse state is a preference
 * about how someone likes to work, not a fact about the clip — so it belongs in
 * `EditorSettings`, keyed by the registry's section `id`, and it must survive both a
 * selection change and a reload.
 *
 * A section the user has never touched is absent from the map and falls back to its
 * registry `defaultOpen`. That is what lets a newly added section arrive expanded for
 * existing users instead of silently collapsed, and keeps the stored blob to only
 * what was actually chosen.
 */
import { useCallback } from 'react';
import { useSettings } from '../../editor/useSettings.js';
import { sectionById, type InspectorSectionDef } from './registry.js';

export interface SectionState {
  /** Whether the section with this id is currently expanded. */
  readonly isOpen: (id: string) => boolean;
  /** Record an expand/collapse. Persisted immediately. */
  readonly setOpen: (id: string, open: boolean) => void;
  /** Expand every section that applies to the current selection. */
  readonly openAll: (sections: readonly InspectorSectionDef[]) => void;
  /** Collapse every section that applies to the current selection. */
  readonly collapseAll: (sections: readonly InspectorSectionDef[]) => void;
}

export function useSectionState(): SectionState {
  const { settings, update } = useSettings();
  const stored = settings.inspectorSections;

  const isOpen = useCallback(
    (id: string): boolean => {
      const explicit = stored[id];
      if (explicit !== undefined) return explicit;
      // Never toggled: the registry decides. An unknown id (a section removed from
      // the registry but still in someone's stored blob) reads as closed rather
      // than throwing — it has nothing to render anyway.
      return sectionById(id)?.defaultOpen ?? false;
    },
    [stored],
  );

  const setOpen = useCallback(
    (id: string, open: boolean): void => {
      update({ inspectorSections: { ...stored, [id]: open } });
    },
    [stored, update],
  );

  /** Set every listed section to `open` in ONE settings write, not N. */
  const setAll = useCallback(
    (sections: readonly InspectorSectionDef[], open: boolean): void => {
      const next = { ...stored };
      for (const section of sections) next[section.id] = open;
      update({ inspectorSections: next });
    },
    [stored, update],
  );

  const openAll = useCallback(
    (sections: readonly InspectorSectionDef[]) => setAll(sections, true),
    [setAll],
  );
  const collapseAll = useCallback(
    (sections: readonly InspectorSectionDef[]) => setAll(sections, false),
    [setAll],
  );

  return { isOpen, setOpen, openAll, collapseAll };
}
