/**
 * Loads the channel-strip worklet into an audio context, once per context.
 *
 * Kept apart from `program-audio.ts` so the bundler-specific worklet URL is only evaluated in a
 * browser: `program-audio.ts` imports this lazily, and its tests inject a stand-in.
 */
import stripWorkletUrl from './channel-strip.worklet.ts?worker&url';

const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

/**
 * Add the channel-strip processor to `ctx`. Resolves when nodes of it can be created; rejects
 * when the context cannot run worklets (no secure context, or the module failed to load).
 */
export function loadChannelStripModule(ctx: BaseAudioContext): Promise<void> {
  const existing = loaded.get(ctx);
  if (existing) return existing;
  const loading = ctx.audioWorklet.addModule(stripWorkletUrl);
  loaded.set(ctx, loading);
  loading.catch(() => loaded.delete(ctx));
  return loading;
}
