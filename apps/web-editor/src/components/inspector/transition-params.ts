/**
 * Which transition controls a kind can accept, and what each one currently reads
 * (revamp Phase 9, F7; catalog era).
 *
 * ## Why this is a module and not `&&` in the JSX
 *
 * The brief's rule is "only kind-relevant controls render". Expressed inline that
 * becomes a `kind === 'wipe' || kind === 'blur'` beside every field, and the moment
 * one of them disagrees with the renderer the inspector offers a knob the export
 * ignores — a control with no effect, which is the exact failure the render-honesty
 * rule exists to prevent.
 *
 * ## Where the answers come from now
 *
 * They are no longer written here at all. `TRANSITION_DIRECTIONS` and
 * `TRANSITION_UNIVERSAL_PARAMS` (in `timeline-schema/transition-params`) state what
 * each RENDER KIND reads, a parity test checks those tables against the shaders
 * themselves, and this module just maps a catalog id onto its render kind and asks.
 * That is what turns "add transition #78" into a data change with no inspector work:
 * the controls it gets are the controls its kind reads.
 *
 * Nothing in this file writes; it answers questions. The section component turns the
 * answers into rows.
 */
import {
  TRANSITION_DIRECTIONS,
  TRANSITION_PARAMS,
  readsUniversalParam,
  type TransitionParamDescriptor,
  type TransitionRenderKind,
} from '@framepilot/timeline-schema/transition-params';
import { getTransition } from '@framepilot/timeline-schema/transition-catalog';
import { DEFAULT_SOFTNESS } from '../../preview/transitions/transition-engine.js';

/** A look parameter every transition shares. Duration and kind are not look params. */
export type TransitionParamName = 'direction' | 'intensity' | 'softness' | 'easing';

/** The render kind behind a stored catalog id, or `null` when this build has no such id. */
export function renderKindOf(kind: string): TransitionRenderKind | null {
  return getTransition(kind)?.renderKind ?? null;
}

/** Easing curves offered. The canonical set, minus the two that make no sense here. */
export const TRANSITION_EASINGS: readonly string[] = [
  'linear',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'bezier',
];

/**
 * `hold` and per-keyframe `bezier` handles are deliberately absent.
 *
 * `hold` maps progress to 0 until the very end, so a "held" transition shows the
 * incoming clip fully hidden and then pops — a cut with extra steps, and one the
 * user would reasonably read as a bug. Bezier *handles* need a keyframe to hang on
 * (schema v14 puts them on `Keyframe`, and a transition has none), so `bezier` here
 * means the engine's smoothstep, exactly as it does for a handle-less keyframe.
 */
export const EXCLUDED_EASINGS: readonly string[] = ['hold'];

/** True when `kind` reads `param` at render time. */
export function acceptsParam(kind: string, param: TransitionParamName): boolean {
  const renderKind = renderKindOf(kind);
  if (renderKind === null) return false;
  // Easing shapes the progress every envelope runs on, so every kind reads it.
  if (param === 'easing') return true;
  if (param === 'direction') return TRANSITION_DIRECTIONS[renderKind].length > 0;
  return readsUniversalParam(renderKind, param);
}

/** The directions `kind` can express, in menu order (empty when it has none). */
export function directionsFor(kind: string): readonly string[] {
  const renderKind = renderKindOf(kind);
  return renderKind === null ? [] : TRANSITION_DIRECTIONS[renderKind];
}

/** The kind-specific numeric params, in the order the renderers read them. */
export function kindParamsFor(kind: string): readonly TransitionParamDescriptor[] {
  const renderKind = renderKindOf(kind);
  return renderKind === null ? [] : TRANSITION_PARAMS[renderKind];
}

/** The value a universal param falls back to when absent — i.e. what "reset" restores. */
export function defaultParamValue(kind: string, param: TransitionParamName): string | number {
  switch (param) {
    case 'direction': {
      const entry = getTransition(kind);
      const allowed = directionsFor(kind);
      if (entry?.direction !== undefined && allowed.includes(entry.direction)) {
        return entry.direction;
      }
      return allowed[0] ?? '';
    }
    case 'intensity':
      return getTransition(kind)?.intensity ?? 1;
    case 'softness':
      return getTransition(kind)?.softness ?? DEFAULT_SOFTNESS;
    case 'easing':
      return getTransition(kind)?.easing ?? 'linear';
  }
}

/** The value a kind-specific param falls back to — the catalog entry's, else the kind's. */
export function defaultKindParamValue(kind: string, name: string): number {
  const entry = getTransition(kind);
  const declared = kindParamsFor(kind).find((d) => d.name === name);
  return entry?.params?.[name] ?? declared?.default ?? 0;
}

/**
 * Read a universal param off a transition effect's free-form params.
 *
 * Returns the {@link defaultParamValue} when the key is absent, unreadable, or (for
 * `direction`) not one this kind accepts — the same resolution the renderers do, so
 * the inspector shows what the render will actually use rather than what is stored.
 */
export function readParam(
  params: Readonly<Record<string, unknown>>,
  kind: string,
  param: TransitionParamName,
): string | number {
  const raw = params[param];
  if (param === 'direction') {
    const allowed = directionsFor(kind);
    return typeof raw === 'string' && allowed.includes(raw) ? raw : defaultParamValue(kind, param);
  }
  if (param === 'easing') {
    return typeof raw === 'string' && TRANSITION_EASINGS.includes(raw)
      ? raw
      : defaultParamValue(kind, param);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) return defaultParamValue(kind, param);
  return Math.min(1, Math.max(0, value));
}

/** Read a kind-specific param, clamped to its declared range. */
export function readKindParam(
  params: Readonly<Record<string, unknown>>,
  kind: string,
  name: string,
): number {
  const declared = kindParamsFor(kind).find((d) => d.name === name);
  if (declared === undefined) return 0;
  const value = Number(params[name]);
  if (!Number.isFinite(value)) return defaultKindParamValue(kind, name);
  return Math.min(declared.max, Math.max(declared.min, value));
}

/** True when the stored value differs from the default — drives whether reset renders. */
export function isParamOverridden(
  params: Readonly<Record<string, unknown>>,
  kind: string,
  param: TransitionParamName,
): boolean {
  const current = readParam(params, kind, param);
  const fallback = defaultParamValue(kind, param);
  if (typeof current === 'number' && typeof fallback === 'number') {
    return Math.abs(current - fallback) > 1e-6;
  }
  return current !== fallback;
}

/** True when a kind-specific param has been moved off its default. */
export function isKindParamOverridden(
  params: Readonly<Record<string, unknown>>,
  kind: string,
  name: string,
): boolean {
  return Math.abs(readKindParam(params, kind, name) - defaultKindParamValue(kind, name)) > 1e-6;
}

/**
 * Every look param a kind carries, universal and kind-specific alike.
 *
 * Used by "reset look" to decide both what to clear and whether the button has
 * anything to do.
 */
export function allLookParamNames(kind: string): readonly string[] {
  const universal = (['direction', 'intensity', 'softness', 'easing'] as const).filter((p) =>
    acceptsParam(kind, p),
  );
  return [...universal, ...kindParamsFor(kind).map((d) => d.name)];
}
