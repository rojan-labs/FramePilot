/**
 * The AI-side half of the 2026-09-24 edit-quality pass (plan EQ5–EQ11): what the captured
 * desktop runs of 2026-09-19…23 needed and did not have.
 *
 * - `measure_subject` — where the cut-out subject sits, and where a title reads behind it;
 * - title widths per bundled family (the tool side of the fit lives in `masking.test.ts`);
 * - cutaway transitions — `list_edit_boundaries`, `add_transitions`, `verify_transitions`;
 * - the buried-picture self-check no longer points at the A-roll under a cut-out.
 */
import { describe, expect, it } from 'vitest';
import { applyOperation, type Operation } from '@framepilot/editor-core';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { getTool } from './tool-registry.js';
import type { ToolContext } from './tool-context.js';
import { subjectLayoutBody, unwrapSubjectLayout } from './sidecar-executor.js';
import { isMeasuredFont, largestFittingSizePercent, titleDrawnWidthPx } from './overlay-fit.js';
import { TITLE_REFERENCE_FRAME, TITLE_REFERENCE_WIDTHS } from './title-metrics.generated.js';
import { verifyTransitions } from './verify.js';
import { hiddenPictureClips } from './domain-tools/picture-layers.js';
import { transitionsNote } from './domain-tools/transition-planning.js';

/** A 9:16 talking head: the A-roll runs 0–20 s; two b-roll inserts sit over it. */
function talkingHead(): Project {
  const clip = (id: string, trackId: string, assetId: string, start: number, end: number) => ({
    id,
    trackId,
    assetId,
    start,
    end,
    sourceStart: 0,
    sourceEnd: end - start,
    effects: [],
    keyframes: [],
  });
  return parseProject({
    id: 'p',
    name: 'Talking head',
    version: 1,
    fps: 30,
    resolution: { width: 1080, height: 1920 },
    assets: [
      {
        id: 'talk',
        path: 'talk.mp4',
        kind: 'video',
        durationSeconds: 30,
        media: { width: 1920, height: 1080 },
      },
      {
        id: 'phone',
        path: 'phone.mp4',
        kind: 'video',
        durationSeconds: 10,
        media: { width: 1080, height: 1920 },
      },
      {
        id: 'code',
        path: 'code.mp4',
        kind: 'video',
        durationSeconds: 10,
        media: { width: 1080, height: 1920 },
      },
    ],
    timeline: {
      tracks: [
        {
          id: 'broll',
          type: 'video',
          clips: [clip('phone_1', 'broll', 'phone', 4, 6), clip('code_1', 'broll', 'code', 10, 13)],
        },
        { id: 'aroll', type: 'video', clips: [clip('talk_1', 'aroll', 'talk', 0, 20)] },
      ],
    },
    transcript: [],
    aiMemory: {},
    history: [],
  });
}

const ctxOf = (project: Project): ToolContext => ({ project });

function build(name: string, args: Record<string, unknown>, project: Project): Operation[] {
  const tool = getTool(name);
  if (!tool?.buildOps) throw new Error(`no buildOps for ${name}`);
  return tool.buildOps(args, ctxOf(project));
}

describe('measure_subject — the request and the reading', () => {
  it('sends the title in the engine’s own vocabulary, so the box it measures is the one that renders', () => {
    const body = subjectLayoutBody(talkingHead(), {
      clipId: 'talk_1',
      start: 0,
      end: 5,
      text: 'MOTION',
      style: { sizePercent: 11, fontFamily: 'Anton' },
    });
    expect(body).toMatchObject({
      clipId: 'talk_1',
      start: 0,
      end: 5,
      text: 'MOTION',
      textStyle: { fontSizePercent: 11, fontFamily: 'Anton' },
    });
    expect((body.textStyle as Record<string, unknown>).sizePercent).toBeUndefined();
  });

  it('reads as geometry an editor places by: head, face band, width per band, the title answer', () => {
    const outcome = unwrapSubjectLayout({
      clipId: 'talk_1',
      maskId: 'm',
      start: 0,
      end: 5.2,
      samples: 6,
      box: [0.1, 0.05, 0.9, 1],
      reach: [0, 0.02, 1, 1],
      headTop: 0.02,
      shoulders: 0.42,
      bands: Array.from({ length: 10 }, (_, i) => ({
        top: i / 10,
        bottom: (i + 1) / 10,
        widthCovered: i === 0 ? 0.63 : 0.96,
      })),
      textBehind: {
        yPercent: 6.6,
        occluded: 0.46,
        endsVisible: false,
        note: 'Zoom the picture out on this stretch.',
        width: 0.86,
        height: 0.13,
        sizePercent: 11,
        shrunkFrom: 20,
      },
    });
    expect(outcome.status).toBe('completed');
    const reading = (outcome.data as { reading: string }).reading;
    expect(reading).toContain('top of the head at 2%');
    expect(reading).toContain('shoulders at 42% — between the two is the face');
    expect(reading).toContain('0%–10% 63%');
    expect(reading).toContain('fitted from 20%, which ran out of the frame');
    expect(reading).toContain('Zoom the picture out');
  });

  it('says "behind" only when the engine found a placement that reads as behind', () => {
    const layout = (textBehind: Record<string, unknown>) =>
      (
        unwrapSubjectLayout({
          clipId: 'talk_1',
          start: 0,
          end: 1.5,
          samples: 6,
          reach: [0.05, 0.15, 0.85, 1],
          headTop: 0.15,
          bands: [{ top: 0, bottom: 0.1, widthCovered: 0 }],
          textBehind: { width: 0.6, height: 0.1, sizePercent: 9, occluded: 0.25, ...textBehind },
        }).data as { reading: string }
      ).reading;
    // The zoomed-out close-up: the word centred on the speaker, who sits left of centre.
    const behind = layout({
      readsBehind: true,
      endsVisible: true,
      xPercent: 38,
      yPercent: 21,
      note: 'Centred 38% across (on the subject, not the frame)…',
    });
    expect(behind).toContain('xPercent 38, yPercent 21 reads behind the subject (25% covered)');
    // A size the route changed to find a placement is named with the size it was.
    expect(
      layout({
        readsBehind: true,
        endsVisible: true,
        yPercent: 22,
        sizePercent: 14.5,
        resizedFrom: 12,
        note: '…',
      }),
    ).toContain('size 14.5% (changed from 12%, where no position read as behind)');
    // A fallback keeps its ends visible too; it must not be reported as behind.
    const fallback = layout({
      readsBehind: false,
      endsVisible: true,
      xPercent: 50,
      yPercent: 8.2,
      occluded: 0.03,
      note: 'No position reads cleanly as behind: …',
    });
    expect(fallback).not.toContain('reads behind the subject');
    expect(fallback).toContain('the closest is yPercent 8.2 (3% covered)');
  });

  it('refuses to invent a reading from an answer without bands', () => {
    expect(unwrapSubjectLayout({ clipId: 'talk_1' }).status).toBe('failed');
  });
});

describe('titles are fitted to the frame the export draws', () => {
  it('predicts every reference width the engine rasterized, to rounding', () => {
    // TITLE_REFERENCE_WIDTHS are `rasterize_text_overlay` widths written by the same
    // generator as the glyph table; tests/test_title_metrics.py pins the table to the fonts.
    for (const { family, word, size, px } of TITLE_REFERENCE_WIDTHS) {
      const fontPx = Math.floor((TITLE_REFERENCE_FRAME.height * size) / 100);
      const predicted = titleDrawnWidthPx(
        word,
        fontPx,
        family ? { fontFamily: family } : undefined,
      );
      expect(predicted, `${family || 'default'} ${word} ${size}%`).toBeGreaterThanOrEqual(
        px * 0.975,
      );
      expect(predicted, `${family || 'default'} ${word} ${size}%`).toBeLessThanOrEqual(
        px * 1.03 + 2,
      );
    }
  });

  it('lands on the size the engine fitted for the captured title', () => {
    // Live, 2026-09-24: `/analyze/subject-layout` fitted "MOTION" in Anton at 15.6 % of a
    // 1080×1920 frame; the previous family-factor estimate re-shrank it to 13.8 %.
    const frame = { width: 1080, height: 1920 };
    const anton = largestFittingSizePercent('MOTION', 92, frame, { fontFamily: 'Anton' })!;
    expect(anton).toBeGreaterThanOrEqual(15.4);
    expect(anton).toBeLessThanOrEqual(15.7);
    // And a short word in a script face — the old estimate let "WAIT" in Caveat through at
    // 24.4 % when 18.5 % is all that fits — is held inside the frame.
    const caveat = largestFittingSizePercent('WAIT', 92, frame, { fontFamily: 'Caveat' })!;
    expect(caveat).toBeLessThanOrEqual(18.6);
    const drawn = titleDrawnWidthPx('WAIT', Math.floor((1920 * caveat) / 100), {
      fontFamily: 'Caveat',
    });
    expect(drawn).toBeLessThanOrEqual(0.92 * 1080);
  });

  it('never reads a heavier cut narrower than a lighter one', () => {
    const light = titleDrawnWidthPx('MOTION', 200, { fontFamily: 'Montserrat', fontWeight: 400 });
    const heavy = titleDrawnWidthPx('MOTION', 200, { fontFamily: 'Montserrat', fontWeight: 900 });
    expect(heavy).toBeGreaterThan(light);
    expect(isMeasuredFont({ fontFamily: 'Anton' })).toBe(true);
    expect(isMeasuredFont({ fontFamily: 'Not A Font' })).toBe(false);
  });
});

describe('cutaway transitions', () => {
  it('lists where each insert enters and leaves over the A-roll', () => {
    const records = getTool('list_edit_boundaries')?.read?.({}, ctxOf(talkingHead())) as Record<
      string,
      unknown
    >[];
    const cutaways = records.filter((record) => record.cutaway !== undefined);
    expect(cutaways.map((c) => [c.clipId, c.cutaway, c.at, c.beneathClipId])).toEqual([
      ['phone_1', 'in', 4, 'talk_1'],
      ['phone_1', 'out', 6, 'talk_1'],
      ['code_1', 'in', 10, 'talk_1'],
      ['code_1', 'out', 13, 'talk_1'],
    ]);
  });

  it('treats them when asked for a reason, with an exit that can actually leave', () => {
    const project = talkingHead();
    const ops = build('add_transitions', { reason: 'energy', includeCutaways: true }, project);
    const layer = ops.filter((op) => op.type === 'add_layer_transition');
    expect(layer).toHaveLength(4);
    const after = ops.reduce((current, op) => applyOperation(current, op), project.timeline);
    const verified = verifyTransitions({ ...project, timeline: after });
    expect(verified.issues).toEqual([]);
    expect(verified.transitionCount).toBe(4);
  });

  it('keeps them hard on auto, and says why in the result', () => {
    const project = talkingHead();
    const ops = build('add_transitions', { includeCutaways: true }, project);
    expect(ops.filter((op) => op.type === 'add_layer_transition')).toEqual([]);
    const note = transitionsNote('add_transitions', ctxOf(project), { includeCutaways: true });
    expect(note).toContain('4 cutaway edge(s) left as hard cuts');
    expect(note).toContain('cuts in and out on the word');
  });

  it('names the untreated edges instead of reporting "no cuts in scope"', () => {
    // The captured runs: a b-roll-heavy short, "add transitions", and three answers that
    // the edit had only one real cut.
    const note = transitionsNote('add_transitions', ctxOf(talkingHead()), { reason: 'soften' });
    expect(note).not.toContain('no cuts in scope');
    expect(note).toContain('4 cutaway edge(s)');
    expect(note).toContain('includeCutaways');
  });

  it('reports what each treated edge got', () => {
    const note = transitionsNote('add_transitions', ctxOf(talkingHead()), {
      reason: 'energy',
      includeCutaways: true,
    });
    expect(note).toContain('4 cutaway transition(s)');
    expect(note).toContain('into phone_1');
    expect(note).toContain('out of code_1');
  });

  it('flags a layer ramp longer than the insert can hold', () => {
    const project = talkingHead();
    const timeline = applyOperation(project.timeline, {
      type: 'add_layer_transition',
      clipId: 'phone_1',
      edge: 'in',
      kind: 'cross-dissolve',
      durationSeconds: 0.5,
    });
    const stretched = {
      ...timeline,
      tracks: timeline.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) =>
          clip.id !== 'phone_1'
            ? clip
            : {
                ...clip,
                effects: clip.effects.map((effect) =>
                  effect.type === 'transition'
                    ? { ...effect, params: { ...effect.params, durationSeconds: 1.5 } }
                    : effect,
                ),
              },
        ),
      })),
    };
    const verified = verifyTransitions({ ...project, timeline: stretched });
    expect(verified.issues.map((issue) => issue.clipId)).toContain('phone_1');
  });
});

describe('the buried-picture check and a cut-out sandwich', () => {
  it('does not call the A-roll under its own front copy buried', () => {
    const project = talkingHead();
    const sandwich: Project = {
      ...project,
      timeline: {
        ...project.timeline,
        tracks: [
          {
            id: 'talk_1__subject_track',
            type: 'video',
            muted: true,
            clips: [
              {
                ...project.timeline.tracks[1]!.clips[0]!,
                id: 'talk_1__subject',
                trackId: 'talk_1__subject_track',
              },
            ],
          },
          ...project.timeline.tracks,
        ],
      },
    };
    expect(hiddenPictureClips(sandwich).map((clip) => clip.clipId)).not.toContain('talk_1');
  });
});
