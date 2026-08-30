/**
 * @framepilot/ai-sdk/references/role — what a reference attachment is FOR (plan/system-mission P3.2).
 *
 * A reference video or image is useless to the planner until it has a role: a logo is an
 * overlay to place, a mood image is a grade target, a fast-cut reel is a pacing target. The
 * role is decided here, deterministically, from (a) the words the user wrote in the same
 * turn and (b) cheap facts about the file — never from a model call on every turn. When
 * neither settles it, the result says so (`ambiguous: true`) and the caller may ask once.
 * Pure: no I/O, no clock.
 */
export type ReferenceRole =
  | 'style'
  | 'pacing'
  | 'caption-style'
  | 'color'
  | 'brand-logo'
  | 'thumbnail'
  | 'b-roll'
  | 'character'
  | 'design';

export interface ReferenceRoleInput {
  readonly kind: 'video' | 'image';
  readonly fileName: string;
  readonly width?: number;
  readonly height?: number;
  /** PNG/WebP alpha channel present — the strongest cheap logo signal. */
  readonly hasAlpha?: boolean;
  /** What the user typed in the turn that attached the file (may be empty). */
  readonly promptText?: string;
}

export interface ReferenceRoleDecision {
  readonly role: ReferenceRole;
  /** 0..1 — 1 when the user named it, lower when inferred from the file alone. */
  readonly confidence: number;
  readonly reason: string;
  /** True when nothing in the words or the file settled it; the default was applied. */
  readonly ambiguous: boolean;
}

/** Word cues, checked in order — the first family with a hit wins. */
const CUES: readonly { readonly role: ReferenceRole; readonly words: readonly string[] }[] = [
  { role: 'brand-logo', words: ['logo', 'brand mark', 'watermark', 'our brand', 'wordmark'] },
  { role: 'caption-style', words: ['caption', 'subtitle', 'subtitles', 'captions', 'lower third'] },
  {
    role: 'color',
    words: [
      'grade',
      'grading',
      'color',
      'colour',
      'tone',
      'look like this',
      'palette',
      'warm',
      'cool',
    ],
  },
  {
    role: 'pacing',
    words: ['pacing', 'pace', 'rhythm', 'cut like', 'cuts like', 'speed', 'tempo', 'fast like'],
  },
  { role: 'thumbnail', words: ['thumbnail', 'cover image', 'poster frame'] },
  {
    role: 'character',
    words: ['character', 'this person', 'the presenter', 'the host', 'my face', 'the subject'],
  },
  {
    role: 'b-roll',
    words: ['b-roll', 'broll', 'cutaway', 'insert shot', 'use this footage', 'use this clip'],
  },
  {
    role: 'design',
    words: ['design', 'layout', 'template', 'font', 'typography', 'title card', 'graphic'],
  },
  {
    role: 'style',
    words: [
      'style',
      'feel like',
      'vibe',
      'aesthetic',
      'like this video',
      'like this reel',
      'like this',
    ],
  },
];

/** Small square-ish PNG with alpha reads as a logo before a word is said. */
const LOGO_MAX_EDGE = 1200;

export function decideReferenceRole(input: ReferenceRoleInput): ReferenceRoleDecision {
  const text = (input.promptText ?? '').toLowerCase();
  for (const cue of CUES) {
    const hit = cue.words.find((w) => text.includes(w));
    if (hit) {
      return {
        role: cue.role,
        confidence: 1,
        reason: `the request says "${hit}"`,
        ambiguous: false,
      };
    }
  }
  const name = input.fileName.toLowerCase();
  if (/logo|brand|watermark/.test(name)) {
    return {
      role: 'brand-logo',
      confidence: 0.8,
      reason: 'the file name says so',
      ambiguous: false,
    };
  }
  if (/thumb|cover|poster/.test(name)) {
    return {
      role: 'thumbnail',
      confidence: 0.7,
      reason: 'the file name says so',
      ambiguous: false,
    };
  }
  if (input.kind === 'image') {
    const w = input.width ?? 0;
    const h = input.height ?? 0;
    if (input.hasAlpha === true && w > 0 && h > 0 && Math.max(w, h) <= LOGO_MAX_EDGE) {
      return {
        role: 'brand-logo',
        confidence: 0.7,
        reason: 'a small image with a transparent background',
        ambiguous: false,
      };
    }
    return {
      role: 'style',
      confidence: 0.4,
      reason: 'an image with no stated purpose',
      ambiguous: true,
    };
  }
  return {
    role: 'style',
    confidence: 0.5,
    reason: 'a video with no stated purpose',
    ambiguous: true,
  };
}

/** One line per role, for the tile badge and the profile constraints. */
export const REFERENCE_ROLE_LABEL: Readonly<Record<ReferenceRole, string>> = Object.freeze({
  style: 'Style reference',
  pacing: 'Pacing reference',
  'caption-style': 'Caption style reference',
  color: 'Color reference',
  'brand-logo': 'Brand logo',
  thumbnail: 'Thumbnail reference',
  'b-roll': 'B-roll',
  character: 'Character reference',
  design: 'Design reference',
});
