/**
 * The style a caption cue renders with — split out of `caption-style-facts.ts` so the modules
 * that judge a style (`verify.ts`, `font-coverage.ts`) and the notes that report on one can
 * all read it without importing each other.
 */
import type { CaptionStyle, Clip, Track } from '@framepilot/timeline-schema';
import { getCaptionTemplate } from '@framepilot/timeline-schema/caption-templates';

/**
 * The style a cue renders with: its own override over the track default over the
 * template, with `background`/`shadow` taken whole from the first layer that sets them —
 * the same precedence the renderers use.
 */
export function resolveCaptionStyle(
  clip: Clip,
  track: Track | undefined,
): CaptionStyle | undefined {
  const authored: CaptionStyle | undefined =
    clip.captionStyle !== undefined
      ? { ...(track?.captionStyle ?? {}), ...clip.captionStyle }
      : track?.captionStyle;
  if (authored === undefined) return undefined;
  const template =
    authored.templateId !== undefined ? getCaptionTemplate(authored.templateId)?.style : undefined;
  if (template === undefined) return authored;
  return {
    ...template,
    ...authored,
    ...(authored.background === undefined && template.background !== undefined
      ? { background: template.background }
      : {}),
    ...(authored.shadow === undefined && template.shadow !== undefined
      ? { shadow: template.shadow }
      : {}),
  };
}
