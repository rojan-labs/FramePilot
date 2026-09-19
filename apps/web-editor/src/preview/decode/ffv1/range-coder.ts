/**
 * FFV1's range decoder (`libavcodec/rangecoder.{c,h}`), bit for bit.
 *
 * WHY a TypeScript port: a matte artifact's lossless masters are FFV1 in Matroska
 * (`render/mattes.py`), which no browser decodes. The preview reads the same bytes the export
 * reads, so the monitor's matte is the export's matte exactly (BR5.1, see
 * `docs/guides/preview-masks.md`, "Mattes"). Every value here stays below 2^24, so plain
 * JavaScript integer arithmetic is exact.
 */

/** `ff_build_rac_states(c, 0.05 * (1LL << 32), 256 - 8)`: FFV1's default state transitions. */
const DEFAULT_FACTOR = 214748364n;
const DEFAULT_MAX_P = 256 - 8;

function buildStates(factor: bigint, maxP: number): { zero: Uint8Array; one: Uint8Array } {
  const one = 1n << 32n;
  const zeroState = new Uint8Array(256);
  const oneState = new Uint8Array(256);
  let lastP8 = 0;
  let p = one / 2n;
  for (let i = 0; i < 128; i++) {
    let p8 = Number((256n * p + one / 2n) >> 32n);
    if (p8 <= lastP8) p8 = lastP8 + 1;
    if (lastP8 && lastP8 < 256 && p8 <= maxP) oneState[lastP8] = p8;
    p += ((one - p) * factor + one / 2n) >> 32n;
    lastP8 = p8;
  }
  for (let i = 256 - maxP; i <= maxP; i++) {
    if (oneState[i]) continue;
    let q = (BigInt(i) * one + 128n) >> 8n;
    q += ((one - q) * factor + one / 2n) >> 32n;
    let p8 = Number((256n * q + one / 2n) >> 32n);
    if (p8 <= i) p8 = i + 1;
    if (p8 > maxP) p8 = maxP;
    oneState[i] = p8;
  }
  for (let i = 1; i < 255; i++) zeroState[i] = 256 - oneState[256 - i]!;
  return { zero: zeroState, one: oneState };
}

const DEFAULT_STATES = buildStates(DEFAULT_FACTOR, DEFAULT_MAX_P);

/** The default `one_state` table (a custom table is coded as deltas against it). */
export const DEFAULT_ONE_STATE: Uint8Array = DEFAULT_STATES.one;

/** Overreads past the end that still count as a valid stream (`MAX_OVERREAD`). */
export const MAX_OVERREAD = 2;

export class RangeDecoder {
  low = 0;
  range = 0xff00;
  /** Next byte to read. */
  pos: number;
  /** One past the last byte this coder may read. */
  end: number;
  /** Where the coder started (a slice's first byte). */
  readonly start: number;
  overread = 0;
  zeroState: Uint8Array = DEFAULT_STATES.zero.slice();
  oneState: Uint8Array = DEFAULT_STATES.one.slice();

  /** `ff_init_range_decoder` over `bytes[start, end)`. */
  constructor(
    readonly bytes: Uint8Array,
    start: number,
    end: number,
  ) {
    this.start = start;
    this.end = end;
    this.low = ((bytes[start] ?? 0) << 8) | (bytes[start + 1] ?? 0);
    this.pos = start + 2;
    if (this.low >= 0xff00) {
      this.low = 0xff00;
      this.end = this.pos;
    }
  }

  /** Copy of this coder's position and tables (slice 0 continues the frame header's coder). */
  clone(): RangeDecoder {
    const copy = Object.create(RangeDecoder.prototype) as RangeDecoder;
    Object.assign(copy, this);
    copy.zeroState = this.zeroState.slice();
    copy.oneState = this.oneState.slice();
    return copy;
  }

  /** Install a custom transition table (`ff_ffv1_init_slice_state`, `AC_RANGE_CUSTOM_TAB`). */
  setTransitions(stateTransition: Uint8Array): void {
    for (let j = 1; j < 256; j++) {
      this.oneState[j] = stateTransition[j]!;
      this.zeroState[256 - j] = 256 - this.oneState[j]!;
    }
  }

  private refill(): void {
    this.range = this.range << 8;
    this.low = this.low << 8;
    if (this.pos < this.end) {
      this.low += this.bytes[this.pos]!;
      this.pos++;
    } else {
      this.overread++;
    }
  }

  /** `get_rac`: one binary decision with the adaptive state at `states[index]`. */
  bit(states: Uint8Array, index: number): number {
    const state = states[index]!;
    const range1 = (this.range * state) >> 8;
    this.range -= range1;
    if (this.low < this.range) {
      states[index] = this.zeroState[state]!;
      if (this.range < 0x100) this.refill();
      return 0;
    }
    this.low -= this.range;
    states[index] = this.oneState[state]!;
    this.range = range1;
    if (this.range < 0x100) this.refill();
    return 1;
  }

  /** `get_rac` with a throwaway state initialised to `value` (e.g. `(uint8_t[]){129}`). */
  bitWithFreshState(value: number): number {
    FRESH[0] = value;
    return this.bit(FRESH, 0);
  }

  /**
   * `get_symbol_inline(c, state + base, is_signed)`.
   *
   * @throws Ffv1DecodeError when the exponent exceeds 31 (corrupt stream).
   */
  symbol(states: Uint8Array, base: number, signed: boolean): number {
    if (this.bit(states, base)) return 0;
    let e = 0;
    while (this.bit(states, base + 1 + Math.min(e, 9))) {
      e++;
      if (e > 31) throw new RangeCoderError('A symbol exponent is out of range.');
    }
    let a = 1;
    for (let i = e - 1; i >= 0; i--) a = a + a + this.bit(states, base + 22 + Math.min(i, 9));
    const negative = signed && this.bit(states, base + 11 + Math.min(e, 10)) === 1;
    return negative ? -a : a;
  }
}

const FRESH = new Uint8Array(1);

export class RangeCoderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RangeCoderError';
  }
}
