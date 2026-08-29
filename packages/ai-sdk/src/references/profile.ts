/**
 * @framepilot/ai-sdk/references/profile — the structured result of analyzing a reference
 * once (plan/system-mission P3.3).
 *
 * The model never reads the raw numbers; it reads `constraints` — a dozen lines in an
 * editor's vocabulary rendered deterministically from the measurements. Controllers read
 * the numbers. One profile per content hash, computed once, reused across turns and
 * sessions. Nothing here guesses: a field the analysis could not measure is absent.
 */
import { z } from 'zod/v4';
import { referenceDirectives, renderDirectives, renderIgnoredReferences } from './directives.js';
import type { ReferenceRole } from './role.js';

export const ReferenceVideoProfileSchema = z.object({
  durationS: z.number().nonnegative(),
  fps: z.number().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  shotCount: z.number().int().nonnegative(),
  medianShotS: z.number().nonnegative().optional(),
  shotLengthP10S: z.number().nonnegative().optional(),
  shotLengthP90S: z.number().nonnegative().optional(),
  cutsPerMinute: z.number().nonnegative().optional(),
  /** 0..1 fraction of the duration with speech, when a transcript was available. */
  speechShare: z.number().min(0).max(1).optional(),
  music: z
    .object({ bpm: z.number().positive().optional(), beatCount: z.number().int().nonnegative() })
    .optional(),
  color: z
    .object({
      /** Mean luma 0..1. */
      brightness: z.number().min(0).max(1).optional(),
      /** Luma spread 0..1 (std dev). */
      contrast: z.number().min(0).max(1).optional(),
      /** Mean chroma 0..1. */
      saturation: z.number().min(0).max(1).optional(),
      /** Warm (>0) / cool (<0) bias, −1..1. */
      temperature: z.number().min(-1).max(1).optional(),
    })
    .optional(),
});
export type ReferenceVideoProfile = z.infer<typeof ReferenceVideoProfileSchema>;

export const ReferenceImageProfileSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  hasAlpha: z.boolean().optional(),
  dominantColors: z.array(z.string()).max(6).optional(),
  color: ReferenceVideoProfileSchema.shape.color,
});
export type ReferenceImageProfile = z.infer<typeof ReferenceImageProfileSchema>;

export const ReferenceProfileSchema = z.object({
  id: z.string().min(1),
  role: z.enum([
    'style',
    'pacing',
    'caption-style',
    'color',
    'brand-logo',
    'thumbnail',
    'b-roll',
    'character',
    'design',
  ]),
  kind: z.enum(['video', 'image']),
  fileName: z.string().min(1),
  /** SHA-256 of the file bytes — the cache key. */
  contentHash: z.string().min(8),
  analyzedAt: z.string().min(1),
  video: ReferenceVideoProfileSchema.optional(),
  image: ReferenceImageProfileSchema.optional(),
  /** Editor-vocabulary lines the planner cites; ≤ 12, rendered by {@link renderConstraints}. */
  constraints: z.array(z.string()).max(12),
});
export type ReferenceProfile = z.infer<typeof ReferenceProfileSchema>;

const round1 = (n: number): string => (Math.round(n * 10) / 10).toFixed(1);

function paceWord(medianShotS: number): string {
  if (medianShotS < 1) return 'rapid-fire';
  if (medianShotS < 2.5) return 'fast';
  if (medianShotS < 5) return 'moderate';
  return 'slow, held';
}

function toneWords(color: NonNullable<ReferenceVideoProfile['color']>): string[] {
  const words: string[] = [];
  if (color.temperature !== undefined) {
    if (color.temperature > 0.15) words.push('warm');
    else if (color.temperature < -0.15) words.push('cool');
    else words.push('neutral');
  }
  if (color.saturation !== undefined) {
    if (color.saturation < 0.2) words.push('desaturated');
    else if (color.saturation > 0.5) words.push('saturated');
  }
  if (color.contrast !== undefined) {
    if (color.contrast > 0.28) words.push('high-contrast');
    else if (color.contrast < 0.14) words.push('flat, low-contrast');
  }
  if (color.brightness !== undefined) {
    if (color.brightness < 0.3) words.push('dark');
    else if (color.brightness > 0.7) words.push('bright');
  }
  return words;
}

/**
 * Render the constraints the model reads from a profile's measurements. Deterministic;
 * every line names a number or a measured quality, never an inference the data lacks.
 */
export function renderConstraints(args: {
  readonly role: ReferenceRole;
  readonly kind: 'video' | 'image';
  readonly fileName: string;
  readonly video?: ReferenceVideoProfile;
  readonly image?: ReferenceImageProfile;
}): string[] {
  const lines: string[] = [];
  const { role, video, image } = args;
  if (video) {
    if (video.shotCount > 1 && video.medianShotS !== undefined) {
      lines.push(
        `Pacing: ${paceWord(video.medianShotS)} — median shot ${round1(video.medianShotS)}s` +
          (video.shotLengthP10S !== undefined && video.shotLengthP90S !== undefined
            ? ` (most shots ${round1(video.shotLengthP10S)}–${round1(video.shotLengthP90S)}s)`
            : '') +
          (video.cutsPerMinute !== undefined
            ? `, ${Math.round(video.cutsPerMinute)} cuts/min`
            : ''),
      );
    } else if (video.shotCount <= 1) {
      lines.push(`Pacing: one continuous take over ${round1(video.durationS)}s — no cuts to match`);
    }
    if (video.music?.bpm !== undefined)
      lines.push(`Music: about ${Math.round(video.music.bpm)} BPM with a clear beat`);
    if (video.speechShare !== undefined) {
      lines.push(
        video.speechShare > 0.5
          ? 'Dialogue-led: speech covers most of the runtime'
          : 'Visual-led: little or no speech',
      );
    }
    if (video.width && video.height) {
      const orientation =
        video.width > video.height
          ? 'landscape'
          : video.width < video.height
            ? 'portrait'
            : 'square';
      lines.push(`Frame: ${orientation} ${video.width}×${video.height}`);
    }
    if (video.color) {
      const words = toneWords(video.color);
      if (words.length) lines.push(`Look: ${words.join(', ')}`);
    }
    if (role === 'pacing')
      lines.push('Apply: match the shot-length range above; do not copy content');
    if (role === 'style') lines.push('Apply: match pacing and look above; do not copy content');
    if (role === 'caption-style')
      lines.push(
        'Apply: match the caption placement and rhythm; captions should read at this pace',
      );
  }
  if (image) {
    lines.push(
      `Image: ${image.width}×${image.height}${image.hasAlpha ? ', transparent background' : ''}`,
    );
    if (image.dominantColors?.length)
      lines.push(`Palette: ${image.dominantColors.slice(0, 4).join(' ')}`);
    if (image.color) {
      const words = toneWords(image.color);
      if (words.length) lines.push(`Look: ${words.join(', ')}`);
    }
    if (role === 'brand-logo')
      lines.push(
        'Apply: place as an overlay (add_text_layer/add_clip on an overlay track), keep proportions, never stretch',
      );
    if (role === 'color')
      lines.push('Apply: grade toward this look (apply_color_grade); keep skin tones natural');
    if (role === 'thumbnail')
      lines.push('Apply: the opening frame and titles should echo this composition');
    if (role === 'b-roll') lines.push('Apply: place as a cutaway where the dialogue refers to it');
    if (role === 'character')
      lines.push(
        'Apply: keep this person framed and in focus; prefer shots where they are visible',
      );
    if (role === 'design') lines.push('Apply: titles and text follow this layout and typography');
  }
  return lines.slice(0, 12);
}

/** Build a profile from measurements; the constraints are derived, never supplied. */
export function buildReferenceProfile(args: {
  readonly id: string;
  readonly role: ReferenceRole;
  readonly kind: 'video' | 'image';
  readonly fileName: string;
  readonly contentHash: string;
  readonly analyzedAt: string;
  readonly video?: ReferenceVideoProfile;
  readonly image?: ReferenceImageProfile;
}): ReferenceProfile {
  return ReferenceProfileSchema.parse({
    ...args,
    constraints: renderConstraints(args),
  });
}

/**
 * The block the context builder shows the model for the active references.
 *
 * Three parts, in the order a plan needs them: what was measured (the constraint lines,
 * verbatim — the same text the sidebar shows the editor, so the two cannot drift), the
 * numeric targets derived from those measurements, and the instruction that the plan
 * must SAY which lines it is applying (P4.2). The last part is what turns a reference from
 * decoration into something the run can be held to: a plan that cites nothing can be told
 * so, and one that cites a line the analysis never produced is checkable prose rather than
 * a claim nobody can settle.
 *
 * The "NOT applied" lines are rendered from {@link referenceDirectives}, not left to the
 * model to notice. A reference this product has no route for is measured all the same, and
 * a run that quietly drops it teaches the editor that attaching things does nothing.
 */
export function summarizeReferences(profiles: readonly ReferenceProfile[]): string {
  if (profiles.length === 0) return '';
  const lines = ['References the editor attached (analyzed once; cite them when you apply them):'];
  for (const p of profiles) {
    lines.push(`- ${p.id} · ${p.fileName} · ${p.role}`);
    for (const c of p.constraints) lines.push(`  ${c}`);
  }
  const directives = referenceDirectives(profiles);
  const targets = renderDirectives(directives);
  if (targets !== '') lines.push('Targets taken from those measurements:', targets);
  const ignored = renderIgnoredReferences(directives);
  if (ignored !== '') lines.push('Measured but not driving anything:', ignored);
  lines.push(
    'In your plan, name the reference id and the line you are applying for each step that ' +
      'follows one, and say which listed lines you are not applying and why.',
  );
  return lines.join('\n');
}
