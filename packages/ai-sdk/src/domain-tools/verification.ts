/**
 * Verification tools — asking the engine to actually make the thing.
 *
 * Two tools, both side effects the host performs rather than patches: a fast
 * preview and the real export. They are the end of every editing path, which is
 * why they are their own family rather than an appendix to whichever domain
 * happened to make the last edit.
 */
import type { ToolSpec } from '../tool-registry.js';
import { actionTool, noArgs } from './tool-factories.js';

export const VERIFICATION_TOOLS: readonly ToolSpec[] = [
  actionTool({ name: 'render_preview', description: 'Render a fast low-res preview.' }, noArgs),
  actionTool({ name: 'export_video', description: 'Render the final export video.' }, noArgs),
];
