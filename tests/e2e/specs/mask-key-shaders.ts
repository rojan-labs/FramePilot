/**
 * The shipped key shaders, re-exported for the MK6.3 gate.
 *
 * Re-exported rather than copied: a gate that measures a copy of the shader measures nothing.
 * The source files hold no runtime imports beyond types, so this resolves without pulling the
 * workspace packages into the Playwright bundle.
 */
export {
  MASK_KEY_FRAGMENT,
  MASK_LEVELS_FRAGMENT,
} from '../../../apps/web-editor/src/preview/masks/key-mask.js';
export { MASK_QUANTIZE_FRAGMENT } from '../../../apps/web-editor/src/preview/engine/gl/raster-shaders.js';
