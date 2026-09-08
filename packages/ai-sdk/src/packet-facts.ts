/**
 * Ledger facts on visual evidence packets (VU2.5).
 *
 * `search_visual` and `describe_footage` return packets keyed by `(assetId, t0, t1)` in
 * asset seconds — the same key the shot ledger stores its rows under. Joining them is
 * therefore free, and it turns two surfaces that could only ever answer "here is a caption"
 * into surfaces that answer "here is a wide static shot of the street, and here is what it
 * is described as".
 *
 * Two things this adds, and one it deliberately does not:
 *
 * - **A `facts` block on each packet.** The structured tier-2 description when the footage
 *   has one, and the tier-0/tier-1 words line otherwise. Never both, and never a caption
 *   restated as a fact.
 * - **A `facts` filter on `search_visual`.** "Wide shots of the street" stops being a hope
 *   about the ranker and becomes a filter over labels that were actually assigned.
 * - It does **not** re-rank. Ranking is the engine's, the filter only removes.
 *
 * Everything degrades honestly: with no ledger the packets come back exactly as the engine
 * sent them, and a filter that could not be applied says so rather than returning
 * everything as though it had been.
 */
import type { LedgerSnapshot, ShotRecord } from './ledger.js';
import { MIN_LABEL_CONFIDENCE, shotWords } from './kernel/context/shot-words.js';

/** What a caller may filter packets by. Every field is a set of acceptable values. */
export interface PacketFactsFilter {
  /** `SHOT_SIZE_LADDER` values — CU, MS, WS … Matched against the tier-1 label. */
  readonly shotSize?: readonly string[] | undefined;
  /** `static`, `slow`, `handheld`, `fast`. Matched against the tier-0 measurement. */
  readonly motion?: readonly string[] | undefined;
  /** Entity ids from the digest (`person_01`). Matched against the tier-1 entity list. */
  readonly entities?: readonly string[] | undefined;
  /** Setting words. Matched against the tier-1 label and the tier-2 description. */
  readonly setting?: readonly string[] | undefined;
}

/** A packet as it arrives: everything else is passed through untouched. */
interface RawPacket {
  readonly assetId?: unknown;
  readonly t0?: unknown;
  readonly t1?: unknown;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Shots of one asset that overlap `[t0, t1)` in ASSET seconds. */
function shotsUnder(
  ledger: LedgerSnapshot,
  assetId: string,
  t0: number,
  t1: number,
): readonly ShotRecord[] {
  return ledger.shots.filter(
    (shot) => shot.assetId === assetId && shot.t1 > t0 && shot.t0 < (t1 > t0 ? t1 : t0 + 1e-6),
  );
}

/** Case-insensitive membership, so a model's "WS" and the ledger's "ws" agree. */
function includesValue(values: readonly string[], candidate: string | null | undefined): boolean {
  if (candidate === null || candidate === undefined) return false;
  const wanted = candidate.toLowerCase();
  return values.some((value) => value.toLowerCase() === wanted);
}

/** Does one shot satisfy every clause of the filter? Absent facts never satisfy a clause. */
function shotMatches(shot: ShotRecord, filter: PacketFactsFilter): boolean {
  if (filter.shotSize && filter.shotSize.length > 0) {
    const labelled = shot.labelled?.shotSize;
    const described = shot.described?.camera.shotSize;
    const fromLabel = labelled && labelled.p >= MIN_LABEL_CONFIDENCE ? labelled.value : undefined;
    if (!includesValue(filter.shotSize, fromLabel ?? described)) return false;
  }
  if (filter.motion && filter.motion.length > 0) {
    if (!includesValue(filter.motion, shot.measured?.motion.class)) return false;
  }
  if (filter.entities && filter.entities.length > 0) {
    const ids = (shot.labelled?.entities ?? []).map((entity) => entity.id);
    if (!filter.entities.some((wanted) => ids.includes(wanted))) return false;
  }
  if (filter.setting && filter.setting.length > 0) {
    const labelled = shot.labelled?.setting;
    const fromLabel = labelled && labelled.p >= MIN_LABEL_CONFIDENCE ? labelled.value : undefined;
    const described = shot.described?.setting;
    if (!includesValue(filter.setting, fromLabel) && !includesValue(filter.setting, described)) {
      return false;
    }
  }
  return true;
}

/** Is the filter asking for anything at all? */
export function filterIsEmpty(filter: PacketFactsFilter | undefined): boolean {
  if (filter === undefined) return true;
  return (
    (filter.shotSize?.length ?? 0) === 0 &&
    (filter.motion?.length ?? 0) === 0 &&
    (filter.entities?.length ?? 0) === 0 &&
    (filter.setting?.length ?? 0) === 0
  );
}

/** The `facts` block one packet carries, when the ledger knows anything about its span. */
function factsFor(shots: readonly ShotRecord[]): Record<string, unknown> | undefined {
  const described = shots.find((shot) => shot.described)?.described;
  if (described) {
    // The structured caption itself, not a rendering of it: `summary` is what a human
    // reads, and every other field is what a filter or a solver can use.
    return {
      provenance: 'described',
      summary: described.summary,
      subject: described.subject,
      action: described.action,
      setting: described.setting,
      camera: described.camera,
      onScreenText: described.onScreenText,
      p: described.p,
    };
  }
  const first = shots[0];
  if (!first) return undefined;
  // `shotWords` reads a structural subset; the ledger's nullish fields are collapsed to
  // `null` so the one absence value the renderer tests for is the one it gets.
  const words = shotWords({
    measured: first.measured ?? null,
    labelled: first.labelled ?? null,
    described: first.described ?? null,
  });
  if (words === '') return undefined;
  return {
    provenance: first.labelled ? 'labelled' : 'measured',
    words,
  };
}

/** What {@link applyPacketFacts} did, so the caller can say it out loud. */
export interface PacketFactsResult {
  readonly packets: readonly unknown[];
  /** How many packets the filter removed. */
  readonly removed: number;
  /** A sentence to append to the tool summary, or `''` when there is nothing to qualify. */
  readonly note: string;
}

/**
 * Attach ledger facts to evidence packets, and drop the ones a filter excludes.
 *
 * @param packets - The engine's packets, untouched apart from an added `facts` key.
 * @param ledger - The run's shot ledger, or `null`/`undefined` when the host has none.
 * @param filter - Optional fact filter; ignored (and reported) when there is no ledger.
 * @returns The packets, how many the filter removed, and the sentence that qualifies both.
 */
export function applyPacketFacts(
  packets: readonly unknown[],
  ledger: LedgerSnapshot | null | undefined,
  filter?: PacketFactsFilter,
): PacketFactsResult {
  if (!ledger || ledger.shots.length === 0) {
    // A filter that could not run must NOT read as a filter that found everything
    // acceptable: the model would take the whole result set as "wide shots of the street".
    const note = filterIsEmpty(filter)
      ? ''
      : ' — the facts filter was ignored: this footage has not been measured yet, so these ' +
        'packets are unfiltered.';
    return { packets, removed: 0, note };
  }

  const kept: unknown[] = [];
  let removed = 0;
  for (const packet of packets) {
    const raw = packet as RawPacket;
    const assetId = typeof raw.assetId === 'string' ? raw.assetId : undefined;
    const t0 = numberOr(raw.t0, 0);
    const shots =
      assetId === undefined ? [] : shotsUnder(ledger, assetId, t0, numberOr(raw.t1, t0));
    if (
      !filterIsEmpty(filter) &&
      !shots.some((shot) => shotMatches(shot, filter as PacketFactsFilter))
    ) {
      removed += 1;
      continue;
    }
    const facts = factsFor(shots);
    kept.push(
      facts === undefined || typeof packet !== 'object' || packet === null
        ? packet
        : { ...(packet as Record<string, unknown>), facts },
    );
  }

  const note =
    removed === 0
      ? ''
      : ` — ${String(removed)} packet(s) dropped by the facts filter; the rest match every ` +
        'clause of it.';
  return { packets: kept, removed, note };
}
