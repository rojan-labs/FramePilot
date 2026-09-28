/**
 * Titles from templates, and titles in caption typography, in the web editor: the patches the
 * Text panel builds and the CSS the preview draws a typed title with.
 */
import { describe, expect, it } from 'vitest';
import type { Timeline } from '@framepilot/timeline-schema';
import {
  DEFAULT_TITLE_TEMPLATE_ID,
  getTitleTemplate,
  type TitleTypography,
} from '@framepilot/timeline-schema/title-templates';
import { applyUserPatch, createEditorState, undoEdit } from './store.js';
import {
  DEFAULT_TEXT_PARAMS,
  addTitleFromTemplatePatch,
  applyTitleTemplatePatch,
  readTextParams,
  setTextParamsPatch,
  type TextOverlayParams,
} from './patch-builders.js';
import { demoAssetIds, demoTimeline } from './demo.js';
import { textOverlayStyle, titleTypographyCss } from './textOverlay.js';

const timeline: Timeline = {
  ...demoTimeline,
  tracks: [...demoTimeline.tracks, { id: 'overlay_1', type: 'overlay', clips: [] }],
};

function clipById(tl: Timeline, id: string) {
  return tl.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
}

function addTitle(templateId: string, start = 1, text?: string) {
  const state = createEditorState(timeline, demoAssetIds);
  const built = addTitleFromTemplatePatch(
    timeline,
    'overlay_1',
    templateId,
    start,
    start + 3,
    text,
  );
  expect(built).not.toBeNull();
  const next = applyUserPatch(state, built!.patch);
  expect(next.issues).toEqual([]);
  return { state: next, clipId: built!.clipId };
}

describe('addTitleFromTemplatePatch', () => {
  it('adds a title in the whole look, validated, as one undoable patch', () => {
    const { state, clipId } = addTitle('hook');
    const clip = clipById(state.timeline, clipId)!;
    const params = readTextParams(clip);
    const hook = getTitleTemplate('hook')!;
    expect(params).toMatchObject({
      text: hook.sampleText,
      fontFamily: hook.look.fontFamily,
      fontWeight: hook.look.fontWeight,
      color: hook.look.color,
      background: hook.look.background,
      yPercent: hook.look.yPercent,
      templateId: 'hook',
    });
    expect(params.typography).toEqual(hook.look.typography);
    const undone = undoEdit(state);
    expect(clipById(undone.timeline, clipId)).toBeUndefined();
  });

  it('starts with the text it is given', () => {
    const { state, clipId } = addTitle(DEFAULT_TITLE_TEMPLATE_ID, 1, 'Launch day');
    expect(readTextParams(clipById(state.timeline, clipId)!).text).toBe('Launch day');
  });

  it('stacks a second title at the same time on a new layer instead of refusing it', () => {
    const { state } = addTitle('heading', 1);
    const second = addTitleFromTemplatePatch(state.timeline, 'overlay_1', 'body', 2, 4)!;
    expect(second.patch.operations[0]?.type).toBe('add_layer');
    const next = applyUserPatch(state, second.patch);
    expect(next.issues).toEqual([]);
    expect(clipById(next.timeline, second.clipId)).toBeDefined();
  });

  it('refuses an unknown template, an unknown track and an empty span', () => {
    expect(addTitleFromTemplatePatch(timeline, 'overlay_1', 'nope', 0, 3)).toBeNull();
    expect(addTitleFromTemplatePatch(timeline, 'nope', 'heading', 0, 3)).toBeNull();
    expect(addTitleFromTemplatePatch(timeline, 'overlay_1', 'heading', 2, 2)).toBeNull();
  });
});

describe('applyTitleTemplatePatch', () => {
  it('restyles a title but keeps its text, place and wrap width', () => {
    const { state, clipId } = addTitle('heading', 1, 'Keep me');
    const moved = applyUserPatch(
      state,
      setTextParamsPatch(state.timeline, clipId, {
        xPercent: 20,
        yPercent: 30,
        boxWidthPercent: 40,
      })!,
    );
    const restyled = applyUserPatch(
      moved,
      applyTitleTemplatePatch(moved.timeline, clipId, 'retro-pop')!,
    );
    expect(restyled.issues).toEqual([]);
    const params = readTextParams(clipById(restyled.timeline, clipId)!);
    const retro = getTitleTemplate('retro-pop')!.look;
    expect(params).toMatchObject({
      text: 'Keep me',
      xPercent: 20,
      yPercent: 30,
      boxWidthPercent: 40,
      fontFamily: retro.fontFamily,
      color: retro.color,
      templateId: 'retro-pop',
    });
    expect(params.typography).toEqual(retro.typography);
  });

  it('refuses a clip that is not a title and an unknown template', () => {
    const { state, clipId } = addTitle('heading');
    expect(applyTitleTemplatePatch(state.timeline, 'clip_intro', 'heading')).toBeNull();
    expect(applyTitleTemplatePatch(state.timeline, clipId, 'nope')).toBeNull();
  });
});

describe('readTextParams typography', () => {
  it('ignores a typography that does not validate, as the engine does', () => {
    const clip = {
      effects: [{ id: 'e', type: 'text', params: { text: 'Hi', typography: { textOpacity: 9 } } }],
    };
    expect(readTextParams(clip).typography).toBeUndefined();
  });
});

describe('titleTypographyCss', () => {
  const typed = (typography: TitleTypography, extra = {}): TextOverlayParams => ({
    ...DEFAULT_TEXT_PARAMS,
    fontFamily: 'Anton',
    fontWeight: 400,
    ...extra,
    typography,
  });

  it('is null for a plain title, whose preview is unchanged', () => {
    expect(titleTypographyCss(DEFAULT_TEXT_PARAMS)).toBeNull();
    const style = textOverlayStyle(DEFAULT_TEXT_PARAMS, 2, 5);
    expect(style.width).toBe('80%');
    expect(style.fontFamily).toBe('Inter');
  });

  it('draws the caption CSS: family, case, tracking, outline, shadow and a hugging chip', () => {
    const style = textOverlayStyle(
      typed(
        {
          textTransform: 'uppercase',
          letterSpacing: 0.1,
          outlineColor: '#000000',
          outlineWidth: 2,
          shadow: { color: '#000000', blur: 0, offsetX: 0.05, offsetY: 0.07 },
          background: { radius: 0.2, paddingX: 0.5, paddingY: 0.25 },
        },
        { background: '#ff2e4d', boxWidthPercent: 60 },
      ),
      2,
      5,
    );
    expect(style).toMatchObject({
      fontFamily: 'Anton',
      textTransform: 'uppercase',
      letterSpacing: '0.1em',
      WebkitTextStroke: '0.25em #000000',
      textShadow: '0.05em 0.07em 0em #000000',
      backgroundColor: '#ff2e4d',
      borderRadius: '0.2em',
      padding: '0.25em 0.5em',
      width: 'max-content',
      maxWidth: '60%',
      fontSize: '8cqh',
      fontSynthesis: 'none',
    });
  });

  it('keeps a hollow title visible and its ring at the export width', () => {
    const hollow = titleTypographyCss(
      typed({ textOpacity: 0, outlineColor: '#ffffff', outlineWidth: 1.5 }),
    )!;
    expect(hollow.WebkitTextStroke).toBe('0.09375em #ffffff');
    const bare = titleTypographyCss(typed({ textOpacity: 0 }))!;
    expect(bare.WebkitTextStroke).toBe('1px #ffffff');
  });
});
