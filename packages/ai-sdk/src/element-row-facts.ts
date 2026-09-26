/**
 * What the model reads about each element on the timeline (plan/elements EL8.2, 07 §5).
 *
 * A sticker or shape row in the timeline summary carries a compact description — which element,
 * where it sits in the units its own tool takes, and its In/Out/Loop — so "move the fire sticker
 * left" or "make the box red" can be planned without a `get_clips` or `get_frame` first:
 *
 *   `sticker "Fire" at 75%, 25%, 30% high · in: pop · loop: pulse`
 *   `shape rounded-rect · outline #FFD400 · box 50, 50, 48×27`
 *
 * Positions use `add_sticker`'s centre-and-height and `add_shape`'s box and ends, so a number the
 * model reads is one it can pass straight back.
 */
import {
  clipAnimation,
  elementKindOf,
  elementRectAt,
  shapeClipParams,
} from '@framepilot/editor-core';
import type { Clip, Project } from '@framepilot/timeline-schema';

const percent = (fraction: number): string => `${String(Math.round(fraction * 100))}%`;
const number = (value: unknown): string =>
  typeof value === 'number' ? String(Math.round(value * 10) / 10) : '?';

/** A sticker's name from its catalogue id (`thumbs_up` → `Thumbs up`). */
function stickerName(remoteId: string | undefined): string {
  const words = (remoteId ?? '').replace(/_/g, ' ').trim();
  return words === '' ? 'Sticker' : words.charAt(0).toUpperCase() + words.slice(1);
}

function animationWords(clip: Clip): string[] {
  const animation = clipAnimation(clip);
  return [
    animation.in === null ? '' : `in: ${animation.in.kind ?? 'transition'}`,
    animation.out === null ? '' : `out: ${animation.out.kind ?? 'transition'}`,
    animation.loop === null ? '' : `loop: ${animation.loop.preset}`,
  ].filter((words) => words !== '');
}

function shapeWords(clip: Clip): string[] {
  const params = shapeClipParams(clip);
  if (params === null) return [];
  const colours = [
    typeof params.fill === 'string' ? `fill ${params.fill}` : '',
    typeof params.stroke === 'string' ? `outline ${params.stroke}` : '',
  ].filter((words) => words !== '');
  const place =
    typeof params.x1 === 'number'
      ? `ends ${number(params.x1)}, ${number(params.y1)} → ${number(params.x2)}, ${number(params.y2)}`
      : `box ${number(params.x)}, ${number(params.y)}, ${number(params.width)}×${number(params.height)}`;
  return [
    `shape ${params.shape}`,
    ...(colours.length === 0 ? [] : [colours.join(', ')]),
    ...(typeof params.label === 'string' ? [`label "${params.label}"`] : []),
    place,
  ];
}

/** The row words for element clip `clip`, or `undefined` when it is not an element. */
export function elementFactFor(project: Project, clip: Clip): string | undefined {
  const kind = elementKindOf(clip, project.assets);
  if (kind === null) return undefined;
  if (kind === 'shape') return [...shapeWords(clip), ...animationWords(clip)].join(' · ');
  const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
  const name = `sticker "${stickerName(asset?.source?.remoteId)}"`;
  const rect = elementRectAt(project, clip.id, clip.start);
  const place =
    rect === null
      ? name
      : `${name} at ${percent(rect.x + rect.width / 2)}, ${percent(rect.y + rect.height / 2)}, ${percent(rect.height)} high`;
  return [place, ...animationWords(clip)].join(' · ');
}

/**
 * Merge every element clip's words into the row facts the timeline summary renders.
 *
 * @param facts - The row facts so far (picture words, repeat markers, masks), if any.
 * @returns `facts` itself when the timeline holds no element; otherwise a new map.
 */
export function withElementFacts(
  project: Project,
  facts: ReadonlyMap<string, string> | undefined,
): ReadonlyMap<string, string> | undefined {
  let merged: Map<string, string> | undefined;
  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) {
      const fact = elementFactFor(project, clip);
      if (fact === undefined) continue;
      merged ??= new Map(facts ?? []);
      const words = merged.get(clip.id);
      merged.set(clip.id, words === undefined || words === '' ? fact : `${words} · ${fact}`);
    }
  }
  return merged ?? facts;
}
