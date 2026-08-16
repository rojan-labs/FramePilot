/**
 * A tiny, dependency-free bounded LRU cache (Map insertion-order based).
 *
 * Why this exists: several session caches — captured video-frame thumbnails and
 * rendered waveform `ImageBitmap`s — were unbounded `Map`s keyed by content AND
 * by the clip's exact pixel size. A continuous zoom gesture produces a fresh key
 * per animation frame (every distinct width is a new entry), so those caches grew
 * without limit and, for `ImageBitmap`s, retained GPU/where-decoded memory that is
 * never released. Zooming in and out repeatedly therefore made the whole app lag
 * (memory pressure + GC churn). Bounding them with an LRU caps that cost; an
 * optional {@link onEvict} hook lets an evicted `ImageBitmap` be `.close()`d so its
 * backing memory is freed immediately rather than waiting for GC.
 *
 * Recency: {@link get} and {@link set} move the touched key to the most-recent end,
 * so the least-recently-used entry is always evicted first. Never stores `undefined`
 * (a missing key and a stored `undefined` would be indistinguishable via `get`).
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();

  /**
   * @param max     Maximum entries to retain (must be ≥ 1).
   * @param onEvict Called with each entry as it is evicted or cleared — use it to
   *                release native resources (e.g. `ImageBitmap.close()`).
   */
  public constructor(
    private readonly max: number,
    private readonly onEvict?: (value: V, key: K) => void,
  ) {}

  public has(key: K): boolean {
    return this.map.has(key);
  }

  /** Return the value and mark it most-recently-used, or `undefined` if absent. */
  public get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Re-insert to move this key to the most-recent (last) position.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  /** Insert/refresh a key, evicting least-recently-used entries past the bound. */
  public set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as K;
      const evicted = this.map.get(oldest) as V;
      this.map.delete(oldest);
      this.onEvict?.(evicted, oldest);
    }
  }

  /** Remove one entry WITHOUT running {@link onEvict} (the value may still be in use). */
  public delete(key: K): boolean {
    return this.map.delete(key);
  }

  public get size(): number {
    return this.map.size;
  }

  /** Drop every entry, running {@link onEvict} for each so resources are released. */
  public clear(): void {
    if (this.onEvict) for (const [key, value] of this.map) this.onEvict(value, key);
    this.map.clear();
  }
}
