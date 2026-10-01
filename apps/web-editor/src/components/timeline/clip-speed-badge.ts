/**
 * The speed badge on a timeline clip (ADR 0198 §6) — display only.
 *
 * A clip that plays at anything other than 1× looks exactly like one that does not:
 * same block, same name, a length that only hints at it. The badge says so on the
 * clip, the way every NLE does. It reads the clip's stored rate and never writes it;
 * the Speed section of the Inspector stays the one place the rate is changed.
 */
import { hasSpeedRamp } from '@framepilot/editor-core';
import type { Clip } from '@framepilot/timeline-schema';

/** What the badge shows (`text`) and the fuller wording for its tooltip (`title`). */
export interface ClipSpeedBadge {
  readonly text: string;
  readonly title: string;
}

/** The speed every clip has unless told otherwise; no badge is drawn for it. */
const NORMAL_SPEED = 1;
/** A stored speed of zero is a freeze frame (schema v15, ADR 0090). */
const FREEZE_SPEED = 0;
/** Two decimals is enough to tell 1.25× from 1.3× without printing float noise. */
const RATE_DECIMALS = 2;

/** `1.3`, `0.25`, `2` — trailing zeros dropped, never `2.00`. */
function formatRate(rate: number): string {
  return String(Number(rate.toFixed(RATE_DECIMALS)));
}

/**
 * The badge for a clip, or `null` when it plays at normal speed.
 *
 * A curve (speed ramp) wins over the constant rate, because the constant no longer
 * describes the clip. Reverse is a direction, not a rate, so it is spelled out rather
 * than shown as a minus sign that reads like a typo.
 *
 * @param clip - The clip's stored speed fields.
 * @returns The text and tooltip for the badge, or `null` for a 1× clip.
 */
export function clipSpeedBadge(clip: Pick<Clip, 'speed' | 'speedRamp'>): ClipSpeedBadge | null {
  if (hasSpeedRamp(clip)) return { text: 'Ramp', title: 'Speed ramp' };
  const speed = clip.speed ?? NORMAL_SPEED;
  if (speed === NORMAL_SPEED) return null;
  if (speed === FREEZE_SPEED) return { text: 'Freeze', title: 'Freeze frame' };
  const rate = `${formatRate(Math.abs(speed))}×`;
  if (speed < 0) return { text: `Rev ${rate}`, title: `Speed ${rate}, reversed` };
  return { text: rate, title: `Speed ${rate}` };
}
