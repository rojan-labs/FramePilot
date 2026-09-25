/**
 * The audio-thread host for a clip's channel strip (`channel-strip.ts`).
 *
 * One node per scheduled clip segment, between the clip's buffer source and its mix gain, so the
 * strip runs where the export runs it: after speed, before the fader, fades and duck. The DSP is
 * the pure `ChannelStrip`, held to ffmpeg's output by `channel-strip.test.ts`; this file only
 * adapts it to `AudioWorkletProcessor`.
 */
import {
  CHANNEL_STRIP_PROCESSOR,
  ChannelStrip,
  type ChannelStripOptions,
} from './channel-strip.js';

/** The AudioWorklet global scope, which the DOM lib does not describe. */
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  processor: new (options: { processorOptions?: unknown }) => AudioWorkletProcessor,
): void;

class ChannelStripProcessor extends AudioWorkletProcessor {
  private readonly strip: ChannelStrip;
  /** The buffer source is scheduled ahead: until it plays, there is no input to end. */
  private heard = false;

  constructor(options: { processorOptions?: unknown }) {
    super();
    const { program, channels } = options.processorOptions as ChannelStripOptions;
    this.strip = new ChannelStrip(program, sampleRate, channels);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0] ?? [];
    const output = outputs[0] ?? [];
    if (input.length === 0) {
      // Before the source starts it is not yet processing; after it ends the segment is over and
      // the node may be collected.
      return !this.heard;
    }
    this.heard = true;
    this.strip.process(input, output, output[0]?.length ?? 0);
    return true;
  }
}

registerProcessor(CHANNEL_STRIP_PROCESSOR, ChannelStripProcessor);
