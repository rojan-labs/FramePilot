/**
 * Real `AudioContext`-driven audio-master clock (plan
 * PREVIEW-WEBCODECS-COMPOSITOR.md P0 gate #4). Browser-only glue over the
 * pure scheduling math in `audio-clock-math.ts` — jsdom has no Web Audio, so
 * this file is exercised by the Playwright spike harness in a real browser,
 * not vitest.
 *
 * Design point: video frame selection reads `nowMediaUs()` every
 * presentation tick and never keeps its own clock. Gapless cuts fall out of
 * each audible buffer's real project offset plus `AudioBufferSourceNode.start()`'s
 * sample-accurate scheduling — correct math here is what makes cut boundaries
 * click-free without deleting silent timeline spans.
 */
import {
  mediaTimeUsFromAnchor,
  scheduleSegmentsOnTimeline,
  type ScheduledSegment,
  type TimelineClockAnchor,
} from './audio-clock-math.js';

export interface AudioSegment {
  /** This segment's start position on the timeline's media clock, in microseconds. */
  mediaStartUs: number;
  /** The decoded audio to play for this segment (a whole source's audio track). */
  buffer: AudioBuffer;
  /** Offset into `buffer` (seconds) where this segment's audio starts. */
  offsetSec: number;
  /** How much of `buffer`, from `offsetSec`, to play (seconds). */
  durationSec: number;
}

/** Seconds of lead time before the first segment starts, giving the browser's
 * audio thread time to pick up the scheduled `start()` calls. */
const DEFAULT_SCHEDULE_LEAD_SEC = 0.05;

/** Clamp a monitor gain into the sane range. Above 1 would clip the mix. */
const clampGain = (gain: number): number => {
  if (!Number.isFinite(gain)) return 1;
  return gain < 0 ? 0 : gain > 1 ? 1 : gain;
};

export class AudioMasterClock {
  private schedule: ScheduledSegment[] = [];
  private sources: AudioBufferSourceNode[] = [];
  private anchor: TimelineClockAnchor = { mediaStartUs: 0, ctxStartSec: 0 };
  /**
   * Monitor volume bus. Every scheduled source connects HERE rather than to
   * `ctx.destination`, so the monitor's volume/mute control is one gain change
   * instead of a rescheduling pass — and so it applies to sources already
   * playing. This is *monitoring* gain only: it never reaches the project, the
   * patch stream, or the render (AGENTS.md invariant 5).
   */
  private readonly masterGain: GainNode;

  constructor(private readonly ctx: AudioContext) {
    this.masterGain = ctx.createGain();
    this.masterGain.connect(ctx.destination);
  }

  /**
   * Set the monitor gain (0 = silent, 1 = unity). Takes effect immediately on
   * sources that are already scheduled and playing, because they are wired
   * through this node rather than straight to the destination.
   */
  setGain(gain: number): void {
    this.masterGain.gain.value = clampGain(gain);
  }

  /** Resume the context (needs a user gesture in most browsers); throws if
   * it doesn't reach `running` — a silently-`suspended` context would freeze
   * `nowMediaUs()` and make the A/V-sync gate pass vacuously against a dead clock. */
  async start(): Promise<void> {
    if (this.ctx.state !== 'running') {
      await this.ctx.resume();
    }
    if (this.ctx.state !== ('running' as AudioContextState)) {
      throw new Error(
        `AudioContext did not reach "running" (state=${this.ctx.state}) — likely blocked by the autoplay policy; resume() must be called from a user gesture.`,
      );
    }
  }

  /** Stop and discard any currently scheduled segments. */
  clear(): void {
    for (const node of this.sources) {
      try {
        node.stop();
      } catch {
        // Already stopped/ended — AudioBufferSourceNode.stop() throws in that case.
      }
    }
    this.sources = [];
    this.schedule = [];
  }

  /**
   * Start one continuous project-timeline clock and schedule each audible
   * segment at its real project offset. `segments` may be empty: video-only
   * footage still needs a clock, and silent/image/gap spans must consume time.
   */
  scheduleSegments(
    segments: readonly AudioSegment[],
    mediaStartUs = segments[0]?.mediaStartUs ?? 0,
    leadSec = DEFAULT_SCHEDULE_LEAD_SEC,
  ): void {
    this.clear();
    const firstCtxStartSec = this.ctx.currentTime + leadSec;
    this.anchor = { mediaStartUs, ctxStartSec: firstCtxStartSec };
    this.schedule = scheduleSegmentsOnTimeline(
      segments.map((seg) => ({
        mediaStartUs: seg.mediaStartUs,
        durationUs: seg.durationSec * 1_000_000,
      })),
      this.anchor,
    );
    segments.forEach((seg, i) => {
      const scheduled = this.schedule[i];
      if (!scheduled) return;
      const node = this.ctx.createBufferSource();
      node.buffer = seg.buffer;
      node.connect(this.masterGain);
      node.start(scheduled.ctxStartSec, seg.offsetSec, seg.durationSec);
      this.sources.push(node);
    });
  }

  /** The media-clock time (microseconds) right now, derived from `ctx.currentTime`. */
  nowMediaUs(): number {
    return mediaTimeUsFromAnchor(this.anchor, this.ctx.currentTime);
  }

  get contextState(): AudioContextState {
    return this.ctx.state;
  }
}
