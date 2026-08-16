/**
 * Compact semantic identity for immutable preview projections.
 *
 * Editor clips/effect layers are replaced, never mutated, when a persisted edit changes
 * them. Object identity is therefore already a collision-free semantic revision inside
 * one renderer session. WebCodecs used JSON.stringify over full keyframe/effect/overlay
 * payloads merely to detect that identity change. Attach a tiny toJSON token to a shallow
 * projection instead, so the existing guards keep their behavior without allocating a
 * multi-megabyte signature string.
 */

let nextIdentity = 1;
const identities = new WeakMap<object, number>();

export function previewIdentity(source: object): string {
  let identity = identities.get(source);
  if (identity === undefined) {
    identity = nextIdentity;
    nextIdentity += 1;
    identities.set(source, identity);
  }
  return `p${identity}`;
}

/** Attach a non-enumerable JSON signature without mutating the project-owned source. */
export function withPreviewIdentity<T extends object>(value: T, source: object): T {
  const token = previewIdentity(source);
  Object.defineProperty(value, 'toJSON', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: () => token,
  });
  return value;
}

/** Test-only reset. Production identities are session-monotonic. */
export function resetPreviewIdentitiesForTests(): void {
  nextIdentity = 1;
  // WeakMap cannot be cleared. Tests use fresh source objects, so resetting the counter is enough.
}
