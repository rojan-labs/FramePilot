/**
 * What the caption tools say when the speech or the request cannot reach the screen.
 *
 * Desktop run `001be135`: the project transcript belonged to the recap video, every clip of
 * which was on a muted track, while the narration heard was a voiceover nobody had
 * transcribed — so honest mapping leaves nothing to caption, and the tools must say why.
 * The same run re-sent `keepTogether` phrases that matched nothing, and read a font list
 * that never said which fonts could draw Devanagari.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import type { ToolContext } from '../tool-context.js';
import { getTool } from '../tool-registry.js';
import { ToolRefusalError } from '../tool-refusal.js';
import { keepTogetherNote } from './captions.js';

const RECAP = 'asset_ro';
const VOICEOVER = 'asset_ro_voiceover';

function recapProject(options: { readonly muted: boolean }): Project {
  const words = ['अब', 'क्योंकि', 'लूफी', 'यहाँ', 'पे', 'गियर', 'फोर', 'मोड', 'है।'].map(
    (word, i) => ({ word, start: i * 0.5, end: i * 0.5 + 0.4, assetId: RECAP }),
  );
  return parseProject({
    id: 'recap',
    name: 'Recap',
    version: 1,
    fps: 30,
    resolution: { width: 1080, height: 1920 },
    assets: [
      { id: VOICEOVER, path: '/media/ro_voiceover.m4a', kind: 'audio', durationSeconds: 10 },
      { id: RECAP, path: '/media/ro_2.mp4', kind: 'video', durationSeconds: 10 },
    ],
    folders: [],
    timeline: {
      tracks: [
        {
          id: 'track_v1',
          type: 'video',
          muted: options.muted,
          clips: [
            {
              id: 'clip_a',
              assetId: RECAP,
              trackId: 'track_v1',
              start: 0,
              end: 10,
              sourceStart: 0,
              sourceEnd: 10,
              effects: [],
              keyframes: [],
            },
          ],
        },
        {
          id: 'track_vo',
          type: 'audio',
          clips: [
            {
              id: 'clip_vo',
              assetId: VOICEOVER,
              trackId: 'track_vo',
              start: 0,
              end: 10,
              sourceStart: 0,
              sourceEnd: 10,
              effects: [],
              keyframes: [],
            },
          ],
        },
        { id: 'track_captions', type: 'caption', clips: [] },
      ],
    },
    transcript: words,
    markers: [],
    aiMemory: {},
    history: [],
  });
}

const ctx = (doc: Project): ToolContext => ({ project: doc }) as unknown as ToolContext;

function captionTheEdit(doc: Project, args: Record<string, unknown> = {}): unknown {
  const tool = getTool('caption_the_edit');
  if (!tool?.buildOps) throw new Error('caption_the_edit is not a mutate tool');
  return tool.buildOps({ trackId: 'track_captions', ...args }, ctx(doc));
}

function read(name: string, doc: Project, args: unknown = {}): Record<string, unknown> {
  const tool = getTool(name);
  if (!tool?.read) throw new Error(`${name} is not a read tool`);
  return tool.read(args, ctx(doc)) as Record<string, unknown>;
}

describe('caption_the_edit over speech nobody hears', () => {
  it('names the muted asset and the audible one to transcribe instead of "no speech survives"', () => {
    let refusal: unknown;
    try {
      captionTheEdit(recapProject({ muted: true }));
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ToolRefusalError);
    const message = (refusal as Error).message;
    expect(message).toContain('nobody hears them');
    expect(message).toContain('"ro_2.mp4" (asset_ro)');
    expect(message).toContain('"ro_voiceover.m4a" (asset_ro_voiceover)');
    expect(message).toContain('transcribe { assetId: "asset_ro_voiceover" }');
    expect(message).not.toContain('No speech survives');
  });

  it('refuses over an EXISTING caption track too, instead of replacing its cues with nothing', () => {
    // Desktop run 001be135's caption track held 324 cues; with the footage muted, a
    // re-caption would have deleted every one and added none.
    const muted = recapProject({ muted: true });
    const withCues: Project = {
      ...muted,
      timeline: {
        ...muted.timeline,
        tracks: muted.timeline.tracks.map((track) =>
          track.id === 'track_captions'
            ? {
                ...track,
                clips: [
                  {
                    id: 'cue_1',
                    assetId: '__caption__',
                    trackId: 'track_captions',
                    start: 0,
                    end: 2,
                    sourceStart: 0,
                    sourceEnd: 2,
                    effects: [],
                    keyframes: [],
                    captionCue: { text: 'अब क्योंकि', words: [] },
                  },
                ],
              }
            : track,
        ),
      },
    };
    expect(() => captionTheEdit(withCues)).toThrow(ToolRefusalError);
  });

  it('captions as before when the speech is heard', () => {
    const ops = captionTheEdit(recapProject({ muted: false })) as { type: string }[];
    expect(ops.some((op) => op.type === 'add_caption_layer')).toBe(true);
  });
});

describe('get_mapped_transcript over speech nobody hears', () => {
  it('carries the same note when no word maps, and none when the speech is heard', () => {
    const silent = read('get_mapped_transcript', recapProject({ muted: true }));
    expect(silent.words).toEqual([]);
    expect(String(silent.note)).toContain('transcribe { assetId: "asset_ro_voiceover" }');
    const heard = read('get_mapped_transcript', recapProject({ muted: false }));
    expect((heard.words as unknown[]).length).toBeGreaterThan(0);
    expect(heard.note).toBeUndefined();
  });
});

describe('keepTogetherNote', () => {
  const doc = recapProject({ muted: false });

  it('names the phrases that matched nothing and the single words, and only those', () => {
    const note = keepTogetherNote('caption_the_edit', doc, {
      trackId: 'track_captions',
      keepTogether: ['गियर फोर', 'गयर फोर', 'लूफी', 'Gear Four', ''],
    });
    expect(note).toContain('keepTogether did nothing for "गयर फोर", "Gear Four"');
    expect(note).toContain('get_mapped_transcript');
    expect(note).toContain('"लूफी" is a single word');
    expect(note).not.toContain('"गियर फोर"');
  });

  it('is silent when every phrase is spoken, without keepTogether, or for another tool', () => {
    expect(keepTogetherNote('caption_the_edit', doc, { keepTogether: ['गियर फोर मोड'] })).toBe('');
    expect(keepTogetherNote('caption_the_edit', doc, { trackId: 'track_captions' })).toBe('');
    expect(keepTogetherNote('caption_the_edit', doc, null)).toBe('');
    expect(keepTogetherNote('auto_emphasize_captions', doc, { keepTogether: ['x y'] })).toBe('');
  });
});

describe('discover_caption_styles', () => {
  it('lists the scripts each bundled font can draw', () => {
    const fonts = read('discover_caption_styles', recapProject({ muted: false })).fonts as {
      family: string;
      scripts: string[];
    }[];
    const scriptsOf = (family: string): string[] | undefined =>
      fonts.find((font) => font.family === family)?.scripts;
    expect(scriptsOf('Poppins')).toContain('devanagari');
    expect(scriptsOf('Bebas Neue')).not.toContain('devanagari');
    expect(fonts.every((font) => font.scripts.includes('latin'))).toBe(true);
  });
});
