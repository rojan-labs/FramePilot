/**
 * Two-tier temporal index for preview-time interval lookups.
 *
 * Short cues use fine buckets so caption lookup stays tiny. Long adjustment/effect
 * spans use coarse buckets so a two-hour layer is not duplicated into 1,440 five-
 * second arrays. Query cost remains proportional to intervals near the current frame.
 */

export interface TimedSpan {
  readonly start: number;
  readonly end: number;
}

export interface TemporalIndex<T extends TimedSpan> {
  readonly bucketSeconds: number;
  readonly buckets: ReadonlyMap<number, readonly T[]>;
  readonly coarseBucketSeconds: number;
  readonly coarseBuckets: ReadonlyMap<number, readonly T[]>;
  /** Original authoring position, used only to merge fine/coarse hits deterministically. */
  readonly order: ReadonlyMap<T, number>;
}

const DEFAULT_BUCKET_SECONDS = 5;
const LONG_SPAN_FINE_BUCKETS = 12;
const COARSE_BUCKET_MULTIPLIER = 60;

function addToBuckets<T>(
  buckets: Map<number, T[]>,
  item: T,
  first: number,
  last: number,
): void {
  for (let bucket = first; bucket <= last; bucket += 1) {
    const entries = buckets.get(bucket);
    if (entries) entries.push(item);
    else buckets.set(bucket, [item]);
  }
}

/** Build a duration-bounded index while preserving authoring order. */
export function buildTemporalIndex<T extends TimedSpan>(
  items: readonly T[],
  bucketSeconds: number = DEFAULT_BUCKET_SECONDS,
): TemporalIndex<T> {
  const safeBucketSeconds =
    Number.isFinite(bucketSeconds) && bucketSeconds > 0 ? bucketSeconds : DEFAULT_BUCKET_SECONDS;
  const coarseBucketSeconds = safeBucketSeconds * COARSE_BUCKET_MULTIPLIER;
  const buckets = new Map<number, T[]>();
  const coarseBuckets = new Map<number, T[]>();
  const order = new Map<T, number>();

  items.forEach((item, itemIndex) => {
    if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.end <= item.start) return;
    order.set(item, itemIndex);
    const fineFirst = Math.floor(item.start / safeBucketSeconds);
    const fineLast = Math.ceil(item.end / safeBucketSeconds) - 1;
    const fineBucketCount = fineLast - fineFirst + 1;

    if (fineBucketCount <= LONG_SPAN_FINE_BUCKETS) {
      addToBuckets(buckets, item, fineFirst, fineLast);
      return;
    }

    const coarseFirst = Math.floor(item.start / coarseBucketSeconds);
    const coarseLast = Math.ceil(item.end / coarseBucketSeconds) - 1;
    addToBuckets(coarseBuckets, item, coarseFirst, coarseLast);
  });

  return { bucketSeconds: safeBucketSeconds, buckets, coarseBucketSeconds, coarseBuckets, order };
}

/** Return active spans at `time`, preserving original authoring order across both tiers. */
export function activeTimedItemsAt<T extends TimedSpan>(
  index: TemporalIndex<T>,
  time: number,
): readonly T[] {
  if (!Number.isFinite(time)) return [];
  const fine = index.buckets.get(Math.floor(time / index.bucketSeconds)) ?? [];
  const coarse = index.coarseBuckets.get(Math.floor(time / index.coarseBucketSeconds)) ?? [];
  const active = [...fine, ...coarse].filter((item) => item.start <= time && time < item.end);
  if (active.length <= 1) return active;
  return active.sort(
    (a, b) => (index.order.get(a) ?? Number.MAX_SAFE_INTEGER) - (index.order.get(b) ?? Number.MAX_SAFE_INTEGER),
  );
}
