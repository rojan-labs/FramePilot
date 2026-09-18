/**
 * Which unscaled `yuv420p → rgb24` converter the export host's ffmpeg runs (MK6.4).
 *
 * WHY the preview has to know: a same-size decode goes through libswscale's unscaled converter,
 * and which one depends on the ffmpeg build MoviePy runs (imageio-ffmpeg's bundled binary). An
 * x86 build has a SIMD converter for `rgb24` (`yuv420_rgb24_ssse3`); the macOS arm64 build has
 * none, so it runs the C converter (`yuv2rgb_c_24_rgb`), whose lookup tables land up to 3 levels
 * away (about one level darker on average). Measured on an M1 Pro: the preview drawing the SIMD
 * arithmetic against an arm64 export differs in 80% of the channel values of a plain 720p frame,
 * and a steep key qualifier amplifies that to 82/255 at its edge (`alpha/key-finesse`, 99.494%
 * within 8/255 against a 99.5% gate). With the C converter both sides agree byte for byte.
 *
 * The desktop renderer and its sidecar run on the same machine, so the browser's own client
 * hints name the export host. Only the pair that was measured switches (macOS + arm); every
 * other host, and a browser without hints, keeps the SIMD arithmetic CI's x86 export uses.
 */
import { createLogger } from '@framepilot/shared-types';

const log = createLogger('preview:sws-host');

/** `simd`: the x86 `pmulhw` converter. `tables`: the C converter's lookup tables. */
export type SwsUnscaledConverter = 'simd' | 'tables';

/** The subset of `NavigatorUAData.getHighEntropyValues` this module reads. */
export interface HostClientHints {
  readonly platform?: string;
  readonly architecture?: string;
}

let converter: SwsUnscaledConverter = 'simd';

/** The converter the compositor draws unscaled decodes with. */
export function swsUnscaledConverter(): SwsUnscaledConverter {
  return converter;
}

/** Override the converter (tests; a host that knows its export better than its client hints). */
export function setSwsUnscaledConverter(next: SwsUnscaledConverter): void {
  converter = next;
}

/** The converter an export on this host runs, from the browser's client hints. */
export function unscaledConverterForHints(hints: HostClientHints): SwsUnscaledConverter {
  return hints.platform === 'macOS' && hints.architecture === 'arm' ? 'tables' : 'simd';
}

/**
 * Resolve the converter once from the browser's high-entropy client hints. Until it resolves,
 * and where hints are unavailable, the SIMD arithmetic is used.
 *
 * `window.__fpExportHostHints` takes precedence: the parity oracle's browser reports the device
 * Playwright emulates, so the harness stands in for the desktop with the platform its engine
 * frames were rendered on, as it stands in with `__fpMatteArtifactUrl` for the project folder.
 */
export async function configureSwsUnscaledConverterFromHost(): Promise<void> {
  type UaData = {
    getHighEntropyValues?: (hints: string[]) => Promise<HostClientHints>;
  };
  const stated = (globalThis as { __fpExportHostHints?: HostClientHints }).__fpExportHostHints;
  if (stated !== undefined) {
    setSwsUnscaledConverter(unscaledConverterForHints(stated));
    log.debug('unscaled yuv420p -> rgb24 converter (stated host)', { converter, ...stated });
    return;
  }
  const uaData = (globalThis.navigator as (Navigator & { userAgentData?: UaData }) | undefined)
    ?.userAgentData;
  if (uaData?.getHighEntropyValues === undefined) return;
  try {
    const hints = await uaData.getHighEntropyValues(['architecture', 'platform']);
    setSwsUnscaledConverter(unscaledConverterForHints(hints));
    log.debug('unscaled yuv420p -> rgb24 converter', { converter, ...hints });
  } catch (error) {
    log.warn('client hints unavailable; unscaled decodes use the SIMD converter', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
