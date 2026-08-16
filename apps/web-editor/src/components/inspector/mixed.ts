/**
 * Mixed values across a multi-clip selection (revamp Phase 4, F6).
 *
 * ## The problem this solves
 *
 * With several clips selected the inspector used to edit only the *primary* one and
 * put a badge above the panel saying so. That is honest but not useful: the reason
 * you select four clips is to change all four. Worse, the fields showed the
 * primary's values, so a selection where three clips are at 100 % and one is at 50 %
 * looked uniform.
 *
 * Every professional inspector answers this the same way: a shared value is shown
 * normally, a differing value is shown as an em-dash, and typing into the field
 * writes it to *everything selected*. That last part is the whole point — and it has
 * to be **one patch**, or undo would need four presses to reverse one edit.
 *
 * Pure: no React, no DOM.
 */

/** The em-dash shown in place of a value that differs across the selection. */
export const MIXED_INDICATOR = '—';

/** A value read across a selection: either shared, or mixed. */
export type MixedValue<T> = { readonly mixed: true } | { readonly mixed: false; readonly value: T };

/**
 * Read one property across a selection.
 *
 * An EMPTY selection is `mixed` rather than throwing or inventing a default: the
 * caller renders a disabled field either way, and "no value to show" is exactly what
 * mixed means to a user.
 */
export function sharedValue<T>(values: readonly T[]): MixedValue<T> {
  const first = values[0];
  if (values.length === 0 || first === undefined) return { mixed: true };
  return values.every((value) => Object.is(value, first))
    ? { mixed: false, value: first }
    : { mixed: true };
}

/**
 * Read one property off every item in a selection, then reduce it to shared-or-mixed.
 * The common case, spelled once so sections do not each re-derive it.
 */
export function sharedFrom<Item, T>(
  items: readonly Item[],
  read: (item: Item) => T,
): MixedValue<T> {
  return sharedValue(items.map(read));
}

/**
 * The number to seed a control with. A mixed value falls back to `fallback` so the
 * control still has a usable starting point for a drag or a nudge — the field *shows*
 * {@link MIXED_INDICATOR}, but a scrub gesture has to begin somewhere, and beginning
 * at a plausible default beats beginning at `NaN`.
 */
export function mixedNumberValue(value: MixedValue<number>, fallback: number): number {
  return value.mixed ? fallback : value.value;
}

/** Display text for a value, or the mixed indicator. */
export function mixedText<T>(value: MixedValue<T>, format: (value: T) => string): string {
  return value.mixed ? MIXED_INDICATOR : format(value.value);
}
