/**
 * The renderer's project-scoped session caches, and the one place they are dropped.
 *
 * WHY one module (plan P6.2): every one of these caches is keyed by something a
 * project owns — an asset id, a media URL, a conversation id — so once a different
 * project is open, nothing in them can ever be served again. They are pure retention:
 * decoded `ImageBitmap`s (GPU memory the JS GC does not see), peak arrays measured in
 * tens of thousands of floats, and per-conversation scroll state. Each cache is
 * bounded, so this is not a correctness fix; it is the difference between the memory
 * coming back at project switch and coming back only under LRU pressure — which for a
 * user who opens one project at a time is never.
 *
 * Adding a cache: bound it, give it a `clear()`, and add it here. A cache reachable
 * from a `Map` in a component module and nowhere else is a cache nobody will remember
 * to clear.
 */
import { clearBitmapCache } from './bitmapCache.js';
import { clearWaveformPeakCache } from './useWaveformPeaks.js';
import { clearWaveformBitmapCache } from '../components/ClipWaveform.js';
import { resetAiSidebarScrollCache } from '../components/ai/AiSidebar.js';

/** Drop every project-scoped renderer cache. Call when a different project is opened. */
export function clearProjectSessionCaches(): void {
  clearBitmapCache();
  clearWaveformBitmapCache();
  clearWaveformPeakCache();
  resetAiSidebarScrollCache();
}
