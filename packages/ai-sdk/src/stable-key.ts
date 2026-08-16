/**
 * @framepilot/ai-sdk/stable-key — bounded identity keys.
 *
 * Several keys in the run are built by serialising whatever the model just did: a
 * turn's tool calls, a host tool's arguments. Those keys are only ever compared for
 * equality, but their LENGTH is a contract: `run-contracts.ts` caps an effect's
 * `idempotencyKey` at 256 characters, and a snapshot that breaches it fails to parse —
 * which fails the whole run, after its edits have already been applied.
 *
 * That cap used to be a function of how much editing one turn did. A montage turn
 * cutting thirty segments serialised kilobytes of arguments into one key and the run
 * died on `effects.6.idempotencyKey: Too big: expected string to have <=256
 * characters`. Identity does not need the full text; it needs to be stable, unique, and
 * bounded. These helpers give all three, and keep a readable head for debugging.
 */

/**
 * Order-sensitive 53-bit hash (cyrb53).
 *
 * Deliberately not a cryptographic digest: nothing security-bearing depends on it, and
 * this module runs in the browser build as well as the desktop one, so it stays
 * dependency-free rather than reaching for `node:crypto`.
 */
export function stableDigest(value: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < value.length; index += 1) {
    const ch = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Longest digest `boundedKeySegment` can append, including its `~` separator. */
export const KEY_DIGEST_CHARS = 12;

/**
 * The identity-key length cap every producer of a run-persisted key budgets
 * against — `run-contracts.ts`'s `identityKeySchema` is what actually enforces
 * it (a key longer than this fails to parse, which fails the whole run
 * snapshot), but every producer needs the same number to know how much
 * readable budget it has left. Defined here rather than in `run-contracts.ts`
 * so this dependency-free module stays the one place both the enforcement
 * point and every producer (`orchestrator.ts`'s turn signature,
 * `effect-runtime.ts`'s tool-argument key, `apps/desktop/electron/main.ts`'s
 * recorded key) can import it from — a producer computing its own sub-budget
 * against a copied `256` has nothing tying it back to this cap if it ever
 * changes.
 */
export const MAX_IDENTITY_KEY_CHARS = 256;

/**
 * One segment of an identity key, capped at `maxChars` readable characters plus a
 * digest of the whole input. Two values that differ anywhere — including past the
 * cut-off — produce different segments, so equality survives the truncation.
 */
export function boundedKeySegment(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}~${stableDigest(value)}`;
}
