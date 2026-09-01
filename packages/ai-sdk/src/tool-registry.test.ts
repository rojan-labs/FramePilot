/**
 * Tests for the tool registry — the AI editing security boundary (PRD §8.3).
 * Every tool's schema validation and every mutating tool's operation output is
 * exercised; the resulting operations must pass the patch validator.
 */
import { describe, expect, it } from 'vitest';
import {
  COLOR_GRADE_PARAMETER_CONTRACTS,
  validatePatch,
  type Operation,
} from '@framepilot/editor-core';
import { ZodError } from 'zod/v4';
import { TOOL_REGISTRY, concurrencySafe, getTool, toolDescriptors } from './tool-registry.js';
import type { ToolContext } from './tool-context.js';
import { MAX_CLIPS_PER_BATCH } from './domain-tools/timeline.js';
import { makeProject } from './__fixtures__/project.js';

const ctx: ToolContext = { project: makeProject(), selection: { start: 1, end: 2 } };

const build = (name: string, args: Record<string, unknown>): Operation[] => {
  const tool = getTool(name);
  if (!tool?.buildOps) throw new Error(`no buildOps for ${name}`);
  return tool.buildOps(args, ctx);
};

describe('tool registry — shape', () => {
  it('exposes the PRD §8.3 tools with correct flags', () => {
    expect(getTool('trim_clip')?.mutates).toBe(true);
    expect(getTool('get_timeline')?.mutates).toBe(false);
    expect(getTool('render_preview')?.kind).toBe('action');
    expect(getTool('analyze_silence')?.kind).toBe('analysis');
    expect(getTool('analyze_silence')?.available).toBe(true);
    expect(getTool('analyze_silence')?.mutates).toBe(false);
    expect(getTool('detect_scenes')?.kind).toBe('analysis');
    // detect_faces was replaced by the pack-backed detect_subjects (2026-08).
    expect(getTool('detect_faces')).toBeUndefined();
    expect(getTool('detect_subjects')?.kind).toBe('analysis');
    expect(getTool('detect_subjects')?.available).toBe(true);
    expect(getTool('detect_subjects')?.mutates).toBe(false);
    expect(getTool('track_subject_automatically')?.kind).toBe('analysis');
    expect(getTool('generate_mask')?.available).toBe(false);
    expect(getTool('unknown_tool_xyz')).toBeUndefined();
  });

  it('every tool exposes a JSON Schema for the model', () => {
    for (const tool of TOOL_REGISTRY) {
      expect(tool.parameters).toMatchObject({ type: 'object' });
    }
  });

  it('accepts string-encoded numeric/boolean args (models that serialise numbers as strings)', () => {
    // Regression: NVIDIA/OpenAI-compatible models frequently emit `{"start":"5"}`
    // instead of `{"start":5}`, which previously failed add_clip/trim_clip wholesale
    // with "expected number, received string". Numeric strings must now coerce.
    expect(
      build('add_clip', {
        trackId: 'video_1',
        assetId: 'asset_intro',
        // A FREE range. The fixture lane holds clips across 0–10, and `add_clip`
        // now reroutes a colliding placement to a lane that has room — which is
        // the right behaviour and the wrong thing for a test about string
        // coercion to be entangled with.
        start: '10',
        end: '15.5',
        sourceStart: '0',
        sourceEnd: '5.5',
      }),
    ).toEqual([
      {
        type: 'add_clip',
        trackId: 'video_1',
        assetId: 'asset_intro',
        start: 10,
        end: 15.5,
        sourceStart: 0,
        sourceEnd: 5.5,
      },
    ]);
    // Booleans serialised as strings coerce too.
    expect(build('set_track_flags', { trackId: 'video_1', muted: 'true' })).toEqual([
      { type: 'set_track_flags', trackId: 'video_1', muted: true },
    ]);
    // The JSON Schema still advertises `number` so a well-behaved model sends numbers.
    expect(
      (getTool('add_clip')!.parameters as { properties: Record<string, { type?: string }> })
        .properties.start.type,
    ).toBe('number');
    // A genuinely non-numeric string is still rejected.
    expect(() => build('trim_clip', { clipId: 'clip_a', start: 'not-a-number', end: 2 })).toThrow();
    // An empty/blank string is left untouched (not coerced to 0) and is rejected.
    expect(() => build('trim_clip', { clipId: 'clip_a', start: '', end: 2 })).toThrow();
    // A string-encoded boolean's "false" form coerces too.
    expect(build('set_track_flags', { trackId: 'video_1', hidden: 'false' })).toEqual([
      { type: 'set_track_flags', trackId: 'video_1', hidden: false },
    ]);
  });

  it('set_track_flags builds an op carrying only the provided flag', () => {
    // Each flag exercised individually → both sides of every conditional spread and
    // each operand of the "at least one flag" refine.
    expect(build('set_track_flags', { trackId: 'video_1', muted: true })).toEqual([
      { type: 'set_track_flags', trackId: 'video_1', muted: true },
    ]);
    expect(build('set_track_flags', { trackId: 'video_1', locked: true })).toEqual([
      { type: 'set_track_flags', trackId: 'video_1', locked: true },
    ]);
    expect(build('set_track_flags', { trackId: 'video_1', hidden: true })).toEqual([
      { type: 'set_track_flags', trackId: 'video_1', hidden: true },
    ]);
  });

  it('set_track_flags rejects a call that sets no flag', () => {
    expect(() => build('set_track_flags', { trackId: 'video_1' })).toThrow();
  });

  it('toolDescriptors hides unavailable tools and can filter by mutation', () => {
    const names = toolDescriptors().map((t) => t.name);
    expect(names).not.toContain('detect_faces');
    expect(names).not.toContain('generate_mask');
    // Available analysis tools ARE advertised (their ffmpeg engine exists).
    expect(names).toContain('analyze_silence');
    expect(names).toContain('detect_scenes');
    expect(names).toContain('list_assets');
    expect(toolDescriptors((t) => t.mutates).every((t) => getTool(t.name)?.mutates)).toBe(true);
    expect(toolDescriptors((t) => !t.mutates).some((t) => t.name === 'get_timeline')).toBe(true);
  });

  it('descriptors omit the non-functional $schema dialect URI (per-turn token waste)', () => {
    // The parameters JSON is only advertised to a provider's tool interface, which
    // ignores $schema; stripping it saves ~14 tokens/tool on every turn with no
    // behavioural effect. Arg validation still runs off the Zod schema, not this JSON.
    for (const tool of toolDescriptors()) {
      expect(tool.parameters).not.toHaveProperty('$schema');
      expect(tool.parameters).toMatchObject({ type: 'object' });
    }
  });

  it('never advertises oneOf/anyOf/allOf at the top level of a tool schema', () => {
    // Anthropic's native Messages API rejects a tool `input_schema` that carries
    // `oneOf`/`anyOf`/`allOf` directly under `parameters` (as opposed to nested inside a
    // property) — see `map_time` and `professional_audio`, both of which used to advertise
    // exactly that and were flattened for it. This guards every tool, present and future,
    // against the same mistake.
    for (const tool of toolDescriptors()) {
      expect(tool.parameters).not.toHaveProperty('oneOf');
      expect(tool.parameters).not.toHaveProperty('anyOf');
      expect(tool.parameters).not.toHaveProperty('allOf');
    }
  });

  it('analysis tools are available, non-mutating, and schema-validated (no buildOps/read)', () => {
    for (const name of ['analyze_silence', 'detect_scenes']) {
      const tool = getTool(name)!;
      expect(tool.kind).toBe('analysis');
      expect(tool.available).toBe(true);
      expect(tool.mutates).toBe(false);
      expect(tool.buildOps).toBeUndefined();
      expect(tool.read).toBeUndefined();
      expect(tool.parameters).toMatchObject({ type: 'object' });
    }
    // Optional args validate; strict schema rejects unknown keys and bad ranges.
    expect(getTool('analyze_silence')!.parse({ assetId: 'a', minSilenceSeconds: 1 })).toEqual({
      assetId: 'a',
      minSilenceSeconds: 1,
    });
    expect(() => getTool('analyze_silence')!.parse({ nope: 1 })).toThrow(ZodError);
    expect(getTool('detect_scenes')!.parse({ threshold: 0.5 })).toEqual({ threshold: 0.5 });
    expect(() => getTool('detect_scenes')!.parse({ threshold: 2 })).toThrow(ZodError);
  });

  it('search_visual/describe_footage validate timeRange as an ordered [start, end] tuple', () => {
    expect(getTool('search_visual')!.parse({ query: 'x', timeRange: [2, 8] })).toMatchObject({
      timeRange: [2, 8],
    });
    expect(() => getTool('search_visual')!.parse({ query: 'x', timeRange: [8, 2] })).toThrow(
      ZodError,
    );
    expect(() => getTool('describe_footage')!.parse({ assetId: 'a1', timeRange: [8, 2] })).toThrow(
      ZodError,
    );
  });
});

describe('read tools', () => {
  it('return project data from context', () => {
    // Not identity: the project is projected for the model (editor-only undo history
    // never enters the result/evidence/WAL path), and the bin is a TALLY rather than a
    // listing — `list_assets` returns the same array, and a run that calls both pays for
    // the ids twice (GAP-018).
    // The transcript is a tally for the same reason (GAP-018 again, measured in run
    // `145ec3f3`): it was 91% of this payload's characters, and the run re-read the
    // whole thing nine times. `get_mapped_transcript` returns the words windowed, and
    // as they play AFTER the edit.
    const { assets: _assets, transcript: _transcript, ...withoutAssets } = ctx.project;
    expect(getTool('get_project_state')?.read?.({}, ctx)).toEqual({
      ...withoutAssets,
      history: [],
      assetSummary: {
        total: 1,
        byKind: { video: 1 },
        note: 'Asset ids are not listed here — call list_assets for them.',
      },
      transcriptSummary: {
        words: 2,
        startSeconds: 0,
        endSeconds: 1,
        preview: 'hello world',
        note: 'Words are not listed here — call get_mapped_transcript for the transcript as it plays after your edits.',
      },
    });

    // An empty transcript says so, and names the call that creates one, rather than
    // reporting a zero the reader has to interpret.
    const noTranscript = { ...ctx, project: { ...ctx.project, transcript: [] } };
    expect(
      (getTool('get_project_state')?.read?.({}, noTranscript) as { transcriptSummary: unknown })
        .transcriptSummary,
    ).toEqual({
      words: 0,
      startSeconds: null,
      endSeconds: null,
      preview: '',
      note: 'This project has no transcript yet — call transcribe to create one.',
    });
    expect(getTool('get_timeline')?.read?.({}, ctx)).toBe(ctx.project.timeline);
    expect(getTool('get_transcript')?.read?.({}, ctx)).toBe(ctx.project.transcript);
    expect(getTool('get_selected_range')?.read?.({}, ctx)).toEqual({ start: 1, end: 2 });
  });

  it('get_timeline reads a window, like get_transcript already did', () => {
    // Run 4c9b5f82 asked for `{start: 0, end: 50}` and then `{start: 0, end: 37}`, was
    // told `Unrecognized keys: "start", "end"` both times, and spent two of its seventeen
    // model calls learning that a read it had every reason to expect did not exist.
    const ctx = { project: makeProject() };
    // The fixture's clips are 0-6s and 6-10s.
    const head = getTool('get_timeline')?.read?.({ end: 5 }, ctx) as {
      tracks: { clips: { id: string }[] }[];
    };
    expect(head.tracks[0]!.clips.map((clip) => clip.id)).toEqual(['clip_a']);
    const tail = getTool('get_timeline')?.read?.({ start: 7 }, ctx) as {
      tracks: { clips: { id: string }[] }[];
    };
    expect(tail.tracks[0]!.clips.map((clip) => clip.id)).toEqual(['clip_b']);
    // A window that touches both keeps both; no args is still the whole timeline, by
    // identity, so the common read allocates nothing.
    const both = getTool('get_timeline')?.read?.({ start: 5, end: 7 }, ctx) as {
      tracks: { clips: { id: string }[] }[];
    };
    expect(both.tracks[0]!.clips).toHaveLength(2);
    expect(getTool('get_timeline')?.read?.({}, ctx)).toBe(ctx.project.timeline);
  });

  it('get_selected_range returns null when there is no selection', () => {
    expect(getTool('get_selected_range')?.read?.({}, { project: makeProject() })).toBeNull();
  });

  it('load_skill returns the skill body from context (ADR 0057)', () => {
    const skill = { name: 'demo-skill', description: 'd', tools: [], body: '# playbook' };
    const skillCtx: ToolContext = {
      project: makeProject(),
      skills: new Map([['demo-skill', skill]]),
    };
    expect(getTool('load_skill')?.read?.({ name: 'demo-skill' }, skillCtx)).toBe(skill);
  });

  it('load_skill lists valid names for an unknown skill (and with no skills wired)', () => {
    const skill = { name: 'demo-skill', description: 'd', tools: [], body: 'b' };
    const skillCtx: ToolContext = {
      project: makeProject(),
      skills: new Map([['demo-skill', skill]]),
    };
    expect(getTool('load_skill')?.read?.({ name: 'nope' }, skillCtx)).toEqual({
      error: 'Unknown skill "nope".',
      available: ['demo-skill'],
    });
    expect(getTool('load_skill')?.read?.({ name: 'nope' }, { project: makeProject() })).toEqual({
      error: 'Unknown skill "nope".',
      available: [],
    });
  });

  it('list_assets returns the bin and filters by kind/folderId', () => {
    const project = makeProject({
      folders: [{ id: 'folder_broll', name: 'B-roll', parentId: null }],
      assets: [
        { id: 'asset_v', path: 'media/v.mp4', kind: 'video', folderId: 'folder_broll' },
        { id: 'asset_a', path: 'media/a.wav', kind: 'audio' },
        { id: 'asset_i', path: 'media/i.png', kind: 'image', folderId: 'folder_broll' },
      ],
    });
    const binCtx: ToolContext = { project };
    const all = getTool('list_assets')?.read?.({}, binCtx) as {
      assets: { id: string }[];
      folders: { id: string }[];
    };
    expect(all.assets.map((a) => a.id)).toEqual(['asset_v', 'asset_a', 'asset_i']);
    expect(all.folders.map((f) => f.id)).toEqual(['folder_broll']);

    const audio = getTool('list_assets')?.read?.({ kind: 'audio' }, binCtx) as {
      assets: { id: string }[];
    };
    expect(audio.assets.map((a) => a.id)).toEqual(['asset_a']);

    const inFolder = getTool('list_assets')?.read?.({ folderId: 'folder_broll' }, binCtx) as {
      assets: { id: string }[];
    };
    expect(inFolder.assets.map((a) => a.id)).toEqual(['asset_v', 'asset_i']);

    // Strict schema rejects an invalid kind and unknown keys.
    expect(() => getTool('list_assets')?.read?.({ kind: 'gif' }, binCtx)).toThrow(ZodError);
    expect(() => getTool('list_assets')?.read?.({ nope: 1 }, binCtx)).toThrow(ZodError);
  });

  it('reads a blank optional selector as "not provided", not as a filter', () => {
    // The bug this exists to prevent: a model sent {"kind":"video","folderId":""}, the
    // empty string filtered for a folder no asset can be in, and list_assets answered
    // "no assets" for a full media bin — so the agent asked the user to import footage
    // that was already imported.
    const project = makeProject({
      folders: [{ id: 'folder_broll', name: 'B-roll', parentId: null }],
      assets: [
        { id: 'asset_v', path: 'media/v.mp4', kind: 'video', folderId: 'folder_broll' },
        { id: 'asset_a', path: 'media/a.wav', kind: 'audio' },
      ],
    });
    const binCtx: ToolContext = { project };
    const blank = getTool('list_assets')?.read?.({ folderId: '' }, binCtx) as {
      assets: { id: string }[];
    };
    expect(blank.assets.map((a) => a.id)).toEqual(['asset_v', 'asset_a']);

    const blankAndKind = getTool('list_assets')?.read?.(
      { kind: 'video', folderId: '  ' },
      binCtx,
    ) as {
      assets: { id: string }[];
    };
    expect(blankAndKind.assets.map((a) => a.id)).toEqual(['asset_v']);

    // A padded real id still selects that folder.
    const padded = getTool('list_assets')?.read?.({ folderId: ' folder_broll ' }, binCtx) as {
      assets: { id: string }[];
    };
    expect(padded.assets.map((a) => a.id)).toEqual(['asset_v']);

    // Same tolerance on the other selector-shaped reads.
    const clips = getTool('get_clips')?.read?.({ trackId: '' }, binCtx) as { total: number };
    expect(clips.total).toBeGreaterThan(0);
    const styles = getTool('discover_caption_styles')?.read?.({ query: '' }, binCtx) as {
      templates: unknown[];
    };
    expect(styles.templates.length).toBeGreaterThan(0);
  });

  it('list_assets says the bin is non-empty when a filter matched nothing', () => {
    // "No asset matched your filter" and "this project has no media" are the same
    // `{assets: []}` to a reader; the agent read the first as the second.
    const project = makeProject({
      assets: [
        { id: 'asset_a', path: 'media/song.mp3', kind: 'audio' },
        { id: 'asset_i', path: 'media/still.jpg', kind: 'image' },
      ],
    });
    const binCtx: ToolContext = { project };
    const empty = getTool('list_assets')?.read?.({ kind: 'video' }, binCtx) as {
      assets: unknown[];
      note?: string;
    };
    expect(empty.assets).toEqual([]);
    expect(empty.note).toContain('NOT empty');
    expect(empty.note).toContain('2 asset(s)');
    expect(empty.note).toContain('1 audio, 1 image');

    // A genuinely empty bin says nothing extra — the reading is already correct.
    const emptyBin = getTool('list_assets')?.read?.({}, { project: makeProject({}) }) as {
      note?: string;
    };
    expect(emptyBin.note).toBeUndefined();
  });

  it('list_assets/get_project_state strip engine render media and project undo history', () => {
    // Peaks are one float per waveform bucket — thousands of numbers with no reasoning
    // value, which used to consume the whole evidence preview/recall budget and hide the
    // asset ids the read exists to deliver. See model-view.ts.
    const project = makeProject({
      assets: [
        {
          id: 'asset_v',
          path: 'media/v.mp4',
          kind: 'video',
          durationSeconds: 58,
          media: {
            proxyPath: '.framepilot-derived/e1/proxy.mp4',
            peaks: [0.0089, 0.0158, 0.0259],
            peaksPerSecond: 60,
            thumbnailPaths: ['.framepilot-derived/e1/t0.jpg'],
          },
        },
      ],
      history: [
        {
          patch: { patchId: 'large', operations: [] },
          inverse: { patchId: 'large:inverse', operations: [] },
          committedAt: 1,
        },
      ],
    });
    const mediaCtx: ToolContext = { project };

    const bin = getTool('list_assets')?.read?.({}, mediaCtx) as { assets: unknown[] };
    expect(bin.assets).toEqual([
      // `shape: 'unmeasured'` survives the strip on purpose: this asset carries derived
      // media but no dimensions, and that gap is exactly what silently disarmed both
      // letterbox safeguards. See model-view.ts.
      {
        id: 'asset_v',
        path: 'media/v.mp4',
        kind: 'video',
        durationSeconds: 58,
        shape: 'unmeasured',
      },
    ]);

    const state = getTool('get_project_state')?.read?.({}, mediaCtx) as {
      assets?: unknown[];
      assetSummary: { total: number; byKind: Record<string, number> };
      history: unknown;
    };
    // The bin is a tally here, not a listing (GAP-018) — but the stripping still has to
    // hold, which is what the `peaks` assertion below proves against the whole payload.
    expect(state.assets).toBeUndefined();
    expect(state.assetSummary).toMatchObject({ total: 1, byKind: { video: 1 } });
    expect(state.history).toEqual([]);
    // The stored project keeps its media — only the model-facing copy drops it.
    expect(project.assets[0]?.media?.peaks).toHaveLength(3);
    expect(project.history).toHaveLength(1);
    expect(JSON.stringify(state)).not.toContain('peaks');
  });

  // GAP-009 (run `fc10301a`). The renderer FITS a clip into the frame, so a landscape
  // source in a portrait sequence letterboxes unless the clip carries a crop. Nothing
  // carried an asset's shape, so the run placed 34 landscape photos in a 1080x1920 frame
  // against a brief reading "No black bars. No stretched photos." with no way to know.
  it('reports each measured asset as landscape, portrait or square', () => {
    const project = makeProject({
      assets: [
        {
          id: 'wide',
          path: 'media/w.jpeg',
          kind: 'image',
          media: { width: 4032, height: 3024 },
        },
        { id: 'tall', path: 'media/t.jpeg', kind: 'image', media: { width: 1080, height: 1920 } },
        { id: 'sq', path: 'media/s.jpeg', kind: 'image', media: { width: 800, height: 800 } },
        { id: 'unmeasured', path: 'media/u.jpeg', kind: 'image' },
      ],
    });
    const bin = getTool('list_assets')?.read?.({}, { project }) as {
      assets: { id: string; orientation?: string; aspect?: number }[];
    };
    expect(bin.assets.map((a) => [a.id, a.orientation])).toEqual([
      ['wide', 'landscape'],
      ['tall', 'portrait'],
      ['sq', 'square'],
      // Still never guessed square — but no longer merely absent. An omission reads as
      // "nothing to worry about"; `shape: 'unmeasured'` reads as the open question it is.
      ['unmeasured', undefined],
    ]);
    expect(bin.assets[0]?.aspect).toBe(1.333);
    expect(bin.assets.map((a) => a.shape)).toEqual([undefined, undefined, undefined, 'unmeasured']);
  });

  it('warns that landscape sources will letterbox in a portrait project', () => {
    const project = makeProject({
      resolution: { width: 1080, height: 1920 },
      assets: [
        { id: 'p1', path: 'media/1.jpeg', kind: 'image', media: { width: 4032, height: 3024 } },
        { id: 'p2', path: 'media/2.jpeg', kind: 'image', media: { width: 4032, height: 3024 } },
      ],
    });
    const bin = getTool('list_assets')?.read?.({}, { project }) as { letterbox?: string };
    expect(bin.letterbox).toContain('2 of these are landscape');
    expect(bin.letterbox).toContain('1080x1920');
    expect(bin.letterbox).toContain('set_clip_crop');
  });

  it('says nothing about letterboxing when the frame is not portrait', () => {
    const project = makeProject({
      resolution: { width: 1920, height: 1080 },
      assets: [
        { id: 'p1', path: 'media/1.jpeg', kind: 'image', media: { width: 4032, height: 3024 } },
      ],
    });
    expect(
      (getTool('list_assets')?.read?.({}, { project }) as { letterbox?: string }).letterbox,
    ).toBeUndefined();
  });

  it('says the shape is UNKNOWN when nothing has been measured, rather than nothing', () => {
    // This note used to stay silent here, on the reasoning that silence is the honest
    // reading of "unknown". It is not: silence reads as "fine". A talking-head run got this
    // empty result for a landscape source in a portrait project, placed it bare, and
    // exported it pillarboxed under a passing review.
    const project = makeProject({
      resolution: { width: 1080, height: 1920 },
      assets: [{ id: 'p1', path: 'media/1.jpeg', kind: 'image' }],
    });
    const letterbox = (getTool('list_assets')?.read?.({}, { project }) as { letterbox?: string })
      .letterbox;
    expect(letterbox).toContain('1 have not been measured');
    expect(letterbox).toContain('p1');
    expect(letterbox).toContain('no crop is applied automatically');
  });

  it('says nothing about an unmeasured AUDIO asset — sound has no shape', () => {
    const project = makeProject({
      resolution: { width: 1080, height: 1920 },
      assets: [{ id: 'music', path: 'media/m.mp3', kind: 'audio' }],
    });
    const bin = getTool('list_assets')?.read?.({}, { project }) as {
      assets: { shape?: string }[];
      letterbox?: string;
    };
    expect(bin.assets[0]?.shape).toBeUndefined();
    expect(bin.letterbox).toBeUndefined();
  });

  it('list_assets collapses provenance to the one fact the model can act on', () => {
    // Licence URLs, creator URLs and fetch timestamps are not reasoning material — the
    // model never opens a licence page. "This track obliges a credit" is, because the
    // model can say it out loud in its summary. See model-view.ts and ADR 0138.
    const project = makeProject({
      assets: [
        {
          id: 'asset_credit',
          path: 'media/bed.mp3',
          kind: 'audio',
          source: {
            provider: 'openverse',
            remoteId: 'ov-1',
            license: 'cc-by',
            licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
            attributionRequired: true,
            attribution: '"Bed" by Ada is licensed under CC BY 4.0.',
            creator: 'Ada',
            fetchedAt: '2026-08-23T12:00:00.000Z',
          },
        },
        {
          id: 'asset_cc0',
          path: 'media/sting.mp3',
          kind: 'audio',
          source: {
            provider: 'openverse',
            remoteId: 'ov-2',
            license: 'cc0',
            attributionRequired: false,
            fetchedAt: '2026-08-23T12:00:00.000Z',
          },
        },
        { id: 'asset_imported', path: 'media/cam.mp4', kind: 'video' },
      ],
    });

    const bin = getTool('list_assets')?.read?.({}, { project }) as {
      assets: Array<Record<string, unknown>>;
    };
    expect(bin.assets[0]?.attributionRequired).toBe(true);
    // Absent means "nothing to credit", never "unknown" — a CC0 track and a file the
    // user dragged in are both genuinely free of obligation, so neither is flagged.
    expect(bin.assets[1]).not.toHaveProperty('attributionRequired');
    expect(bin.assets[2]).not.toHaveProperty('attributionRequired');
    expect(JSON.stringify(bin)).not.toContain('creativecommons.org');
    // The stored project keeps the full record — only the model-facing copy collapses it.
    expect(project.assets[0]?.source?.attribution).toContain('Ada');
  });

  it('read_edit_signals describes every supplied signal in TIME order, with no verdicts', () => {
    const result = getTool('read_edit_signals')?.read?.(
      {
        chapters: [{ t0: 0, t1: 30, title: 'Setup' }],
        highlights: [{ t0: 5, t1: 6, label: 'moment', score: 0.8 }],
        silences: [{ start: 1, end: 3 }],
        sceneCuts: [10, 20],
        // Accepted and ignored: which move a vertical target deserves is the agent's call.
        verticalTarget: true,
      },
      ctx,
    ) as { kind: string; t0: number; observation: string; from: string }[];
    expect(result.map((s) => s.kind)).toEqual([
      'chapter',
      'silence',
      'highlight',
      'scene_change',
      'scene_change',
    ]);
    // Time order, not a ranking — ranking would be the judgement this tool no longer makes.
    expect(result.map((s) => s.t0)).toEqual([...result.map((s) => s.t0)].sort((a, b) => a - b));
    // No move, no score, no canned rationale anywhere in the payload.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('punch_in');
    expect(serialized).not.toContain('score');
    expect(serialized).not.toContain('makes it land');
    // A supplied signal says it was supplied: a chapter the caller never read from the
    // footage is still only the caller's own claim.
    expect(result.find((s) => s.kind === 'chapter')).toMatchObject({ from: 'supplied' });
    expect(result.find((s) => s.kind === 'chapter')?.observation).toContain('1 highlight(s)');
  });

  it('read_edit_signals returns nothing when nothing was gathered', () => {
    expect(getTool('read_edit_signals')?.read?.({}, ctx)).toEqual([]);
  });
});

describe('discover_transitions', () => {
  interface Result {
    matched: number;
    returned: number;
    categories: { id: string; label: string }[];
    transitions: {
      kind: string;
      category: string;
      params: { name: string; min: number; max: number; default: number }[];
    }[];
  }

  const discover = (args: Record<string, unknown>): Result =>
    getTool('discover_transitions')?.read?.(args, ctx) as Result;

  it('returns the catalog with a default cap', () => {
    const result = discover({});
    // Every browse tool caps by default (discover_effects's precedent): dumping
    // every entry with every param would spend the context window on transitions
    // the model will not use.
    expect(result.matched).toBeGreaterThan(20);
    expect(result.returned).toBe(20);
  });

  it('honours an explicit limit', () => {
    expect(discover({ limit: 3 }).returned).toBe(3);
  });

  it('searches by name/feel, not just the raw catalog order', () => {
    const result = discover({ query: 'cross dissolve' });
    expect(result.transitions.map((t) => t.kind)).toContain('cross-dissolve');
  });

  it('filters by category', () => {
    const result = discover({ category: 'basic', limit: 80 });
    expect(result.transitions.length).toBeGreaterThan(0);
    for (const t of result.transitions) expect(t.category).toBe('basic');
  });

  it('filters to the popular and recommended shelves', () => {
    for (const shelf of ['popular', 'recommended'] as const) {
      const result = discover({ shelf, limit: 80 });
      expect(result.transitions.length).toBeGreaterThan(0);
      expect(result.transitions.map((t) => t.kind)).toContain('cross-dissolve');
    }
  });

  it('lists every category so the model can navigate', () => {
    expect(discover({}).categories.length).toBeGreaterThan(0);
  });

  it("reports the kind's default when the entry does not override the param", () => {
    // `cross-dissolve` carries no `params` override, so its `hold` has to come
    // from the `dissolve` render kind's own default (0), not from the catalog
    // entry — the same "own default vs kind default" distinction discover_effects
    // draws for effect params.
    const result = discover({ category: 'basic', limit: 80 });
    const cross = result.transitions.find((t) => t.kind === 'cross-dissolve');
    const hold = cross?.params.find((p) => p.name === 'hold');
    expect(hold?.default).toBe(0);
  });

  it("reports the entry's OWN override over the kind default", () => {
    // `soft-dissolve` overrides `hold` to 0.45 — reporting the kind default (0)
    // would make the model think it was applying a plain cross dissolve.
    const result = discover({ category: 'basic', limit: 80 });
    const soft = result.transitions.find((t) => t.kind === 'soft-dissolve');
    const hold = soft?.params.find((p) => p.name === 'hold');
    expect(hold?.default).toBe(0.45);
  });

  it('returns an empty result for a miss rather than throwing', () => {
    const result = discover({ query: 'zzzznotathing' });
    expect(result.matched).toBe(0);
    expect(result.transitions).toEqual([]);
  });
});

describe('mutating tools — build valid operations', () => {
  it('trim_clip / split_clip', () => {
    expect(build('trim_clip', { clipId: 'clip_a', start: 0, end: 4 })).toEqual([
      { type: 'trim_clip', clipId: 'clip_a', start: 0, end: 4 },
    ]);
    expect(build('split_clip', { clipId: 'clip_a', at: 3 })).toEqual([
      { type: 'split_clip', clipId: 'clip_a', at: 3 },
    ]);
  });

  it('delete_range / ripple_delete / move_clip', () => {
    expect(build('delete_range', { trackId: 'video_1', start: 0, end: 2 })[0]?.type).toBe(
      'delete_range',
    );
    expect(build('ripple_delete', { trackId: 'video_1', start: 0, end: 2 })[0]?.type).toBe(
      'ripple_delete',
    );
    expect(build('move_clip', { clipId: 'clip_b', toTrackId: 'video_1', toStart: 7 })[0]).toEqual({
      type: 'move_clip',
      clipId: 'clip_b',
      toTrackId: 'video_1',
      toStart: 7,
    });
  });

  it('add_clip / add_text_layer / add_caption_layer', () => {
    expect(
      build('add_clip', {
        trackId: 'video_1',
        assetId: 'asset_1',
        start: 10,
        end: 10.46,
        // Regression: image assets commonly advertise a 5s display duration. A model
        // used to copy that into sourceEnd while placing a sub-second beat interval,
        // producing a clip the patch validator rejected. Legacy sourceEnd is accepted
        // but the tool boundary derives the internally consistent value.
        sourceEnd: 5,
      })[0],
    ).toEqual({
      type: 'add_clip',
      trackId: 'video_1',
      assetId: 'asset_1',
      start: 10,
      end: 10.46,
      sourceStart: 0,
      sourceEnd: 0.46000000000000085,
    });
    // `add_text_layer` resolves its own lane, so the overlay op is not always
    // first: when the named track has no room over the range (here `video_1`
    // already holds a clip across it) the tool opens a lane and the overlay
    // follows it, in one patch.
    const textOps = build('add_text_layer', { trackId: 'video_1', text: 'Hi', start: 10, end: 11 });
    expect(textOps.find((op) => op.type === 'add_text_overlay')).toMatchObject({
      type: 'add_text_overlay',
      text: 'Hi',
    });
    // The cue's range is fixed by the transcript (the words at 0–1s), and `video_1`
    // is holding `clip_a` across it — a cue cannot share a lane with the clip it
    // captions. So the placement opens a lane, and the cue follows it in the same
    // patch. What the cue SAYS, and where it came from, is unchanged.
    const cueOps = build('add_caption_layer', { trackId: 'video_1', start: 0, end: 1 });
    const lane = cueOps[0] as { type: string; layerId: string };
    expect(lane.type).toBe('add_layer');
    expect(cueOps.slice(1)).toEqual([
      {
        type: 'add_caption_layer',
        trackId: lane.layerId,
        start: 0,
        end: 1,
        clipId: `caption_${lane.layerId}_0`,
      },
      {
        type: 'set_caption_cue',
        clipId: `caption_${lane.layerId}_0`,
        captionCue: {
          text: 'hello world',
          words: [
            { word: 'hello', start: 0, end: 0.5 },
            { word: 'world', start: 0.5, end: 1 },
          ],
          derivedFromRevision: 0,
          source: { assetId: 'asset_1', clipId: 'clip_a', start: 0, end: 1 },
        },
      },
    ]);
    expect(getTool('add_caption_layer')?.description).toContain('ONE short');
    expect(getTool('add_caption_layer')?.description).toContain('never more than 12');
    // The rejection names the bulk tool that would have avoided it: a model that
    // over-reaches here should be steered to caption_the_edit, not left to guess
    // its way through one hand-placed cue at a time.
    expect(() => build('add_caption_layer', { trackId: 'video_1', start: 0, end: 195.32 })).toThrow(
      /one readable cue.*caption_the_edit/,
    );
  });

  it('caption_the_edit captions the whole edit in one call', () => {
    // The gap this closes: a captured run spent 107 add_caption_layer calls
    // hand-segmenting one 47s video, hit the >12-word and cross-boundary
    // rejections doing it, and then — when a later cut made the cues stale —
    // deleted all 106 and re-added them. deriveCaptionCues already did all of
    // this correctly in editor-core; only the UI could reach it.
    const withCaptionTrack = (captionClips: unknown[] = []): ToolContext => ({
      project: makeProject({
        transcript: [
          { word: 'if', start: 0, end: 0.2 },
          { word: 'you', start: 0.2, end: 0.4 },
          { word: 'want', start: 0.4, end: 0.7 },
          { word: 'to', start: 0.7, end: 0.9 },
          { word: 'craft', start: 0.9, end: 1.3 },
          { word: 'videos.', start: 1.3, end: 1.8 },
          { word: 'here', start: 2.6, end: 2.9 },
          { word: 'is', start: 2.9, end: 3.1 },
          { word: 'how.', start: 3.1, end: 3.5 },
        ],
        timeline: {
          tracks: [
            {
              id: 'video_1',
              type: 'video',
              clips: [
                {
                  id: 'clip_a',
                  assetId: 'asset_1',
                  trackId: 'video_1',
                  start: 0,
                  end: 6,
                  sourceStart: 0,
                  sourceEnd: 6,
                  effects: [],
                  keyframes: [],
                },
              ],
            },
            { id: 'caption_1', type: 'caption', clips: captionClips },
          ],
        },
      }),
      selection: { start: 1, end: 2 },
    });

    const tool = getTool('caption_the_edit');
    if (!tool?.buildOps) throw new Error('no buildOps for caption_the_edit');
    const operations = tool.buildOps({ trackId: 'caption_1' }, withCaptionTrack());

    // One call, every cue — and more than one cue, which is the whole point.
    const cues = operations.filter((op) => op.type === 'add_caption_layer');
    expect(cues.length).toBeGreaterThan(1);
    expect(operations.filter((op) => op.type === 'set_caption_cue')).toHaveLength(cues.length);
    expect(operations.some((op) => op.type === 'delete_range')).toBe(false);

    // Every cue stays inside the footage, runs forward, and never overlaps the
    // one before it — the errors the hand-placed path kept being rejected for.
    for (const cue of cues) {
      expect(cue.start).toBeGreaterThanOrEqual(0);
      expect(cue.end).toBeLessThanOrEqual(6);
      expect(cue.end).toBeGreaterThan(cue.start);
    }
    for (let i = 1; i < cues.length; i += 1) {
      expect(cues[i]!.start).toBeGreaterThanOrEqual(cues[i - 1]!.end - 1e-9);
    }

    // Each cue carries provenance, so a later edit can tell it went stale
    // instead of leaving staleness to be assumed (ADR 0076).
    for (const op of operations.filter((o) => o.type === 'set_caption_cue')) {
      expect(op.captionCue.words.length).toBeGreaterThan(0);
      expect(op.captionCue.source?.assetId).toBe('asset_1');
    }

    // The whole batch is one valid patch — one undo takes all of it back.
    const result = validatePatch(
      withCaptionTrack().project.timeline,
      { operations },
      { assetIds: ['asset_1'] },
    );
    expect(result.valid).toBe(true);
  });

  it('caption_the_edit clears existing cues back-to-front, so a re-run repairs', () => {
    // Re-running IS the repair path for whatever verify_captions reports stale.
    const captionClip = (id: string, start: number, end: number): unknown => ({
      id,
      assetId: '__caption__',
      trackId: 'caption_1',
      start,
      end,
      sourceStart: 0,
      sourceEnd: end - start,
      effects: [],
      keyframes: [],
    });
    const ctxWithCues: ToolContext = {
      project: makeProject({
        timeline: {
          tracks: [
            {
              id: 'video_1',
              type: 'video',
              clips: [
                {
                  id: 'clip_a',
                  assetId: 'asset_1',
                  trackId: 'video_1',
                  start: 0,
                  end: 6,
                  sourceStart: 0,
                  sourceEnd: 6,
                  effects: [],
                  keyframes: [],
                },
              ],
            },
            {
              id: 'caption_1',
              type: 'caption',
              clips: [captionClip('old_1', 0, 0.5), captionClip('old_2', 0.5, 1)],
            },
          ],
        },
      }),
      selection: { start: 1, end: 2 },
    };

    const operations = getTool('caption_the_edit')!.buildOps!(
      { trackId: 'caption_1' },
      ctxWithCues,
    );
    const clears = operations.filter((op) => op.type === 'delete_range');
    expect(clears).toHaveLength(2);
    // Back-to-front: each range must still be present in the timeline the
    // validator replays against as the clears apply in order.
    expect(clears[0]!.start).toBeGreaterThan(clears[1]!.start);
    // And every clear precedes every re-add.
    expect(operations.indexOf(clears[1]!)).toBeLessThan(
      operations.findIndex((op) => op.type === 'add_caption_layer'),
    );
  });

  it('caption_the_edit refuses an unknown track, a non-caption track, and no transcript', () => {
    const tool = getTool('caption_the_edit');
    if (!tool?.buildOps) throw new Error('no buildOps for caption_the_edit');
    expect(() => tool.buildOps?.({ trackId: 'nope' }, ctx)).toThrow(/Unknown track/);
    expect(() => tool.buildOps?.({ trackId: 'video_1' }, ctx)).toThrow(/not a caption track/);

    const noTranscript: ToolContext = {
      project: makeProject({
        transcript: [],
        timeline: { tracks: [{ id: 'caption_1', type: 'caption', clips: [] }] },
      }),
      selection: { start: 1, end: 2 },
    };
    expect(() => tool.buildOps?.({ trackId: 'caption_1' }, noTranscript)).toThrow(
      /no transcript yet/,
    );
  });

  it('add_caption_layer rejects a range whose mapped words cross an edit boundary', () => {
    // clip_a covers timeline 0–6, clip_b covers 6–10; a word in each range makes
    // this one cue's mapped words span both clips.
    const crossBoundaryCtx: ToolContext = {
      project: makeProject({
        transcript: [
          { word: 'hello', start: 0, end: 0.5 },
          { word: 'world', start: 6, end: 6.4 },
        ],
      }),
      selection: { start: 1, end: 2 },
    };
    const tool = getTool('add_caption_layer');
    expect(() =>
      tool?.buildOps?.({ trackId: 'video_1', start: 0, end: 6.5 }, crossBoundaryCtx),
    ).toThrow(/cannot cross an edit boundary/);
  });

  it('add_caption_layer allows a legal range with no mapped words (no source provenance)', () => {
    // Free range: the fixture lane is occupied 0–10 and a colliding cue is now
    // rerouted to a lane with room, which would shift the op indices below.
    const ops = build('add_caption_layer', { trackId: 'video_1', start: 12, end: 12.05 });
    expect(ops[1]).toMatchObject({
      type: 'set_caption_cue',
      captionCue: { text: '', words: [] },
    });
    expect(ops[1]).not.toHaveProperty('captionCue.source');
  });

  it('add_track defaults to an overlay layer in front with a generated id', () => {
    // Fixture has two tracks (video_1, audio_1), so the deterministic id is layer_<role>_3.
    expect(build('add_track', {})).toEqual([
      { type: 'add_layer', layerId: 'layer_overlay_3', layerType: 'overlay', atIndex: 0 },
    ]);
  });

  it('add_track honours an explicit type, atIndex, and id', () => {
    expect(build('add_track', { type: 'audio', atIndex: 2, id: 'music_bed' })).toEqual([
      { type: 'add_layer', layerId: 'music_bed', layerType: 'audio', atIndex: 2 },
    ]);
  });

  it('add_track coerces a string-encoded atIndex', () => {
    expect(build('add_track', { type: 'video', atIndex: '1' })).toEqual([
      { type: 'add_layer', layerId: 'layer_video_3', layerType: 'video', atIndex: 1 },
    ]);
  });

  it('add_track rejects an unknown role and a negative atIndex', () => {
    expect(() => build('add_track', { type: 'sticker' })).toThrow();
    expect(() => build('add_track', { atIndex: -1 })).toThrow();
  });

  it('add_track skips a generated id that already exists', () => {
    // Two tracks → the first candidate is layer_overlay_3; occupy it so the id
    // generator must increment past the collision to layer_overlay_4.
    const collidingCtx: ToolContext = {
      project: makeProject({
        timeline: {
          tracks: [
            { id: 'video_1', type: 'video', clips: [] },
            { id: 'layer_overlay_3', type: 'overlay', clips: [] },
          ],
        },
      }),
    };
    expect(getTool('add_track')?.buildOps?.({}, collidingCtx)).toEqual([
      { type: 'add_layer', layerId: 'layer_overlay_4', layerType: 'overlay', atIndex: 0 },
    ]);
  });

  it('add_track ops pass the patch validator and create a usable track', () => {
    const ops = build('add_track', { id: 'overlay_2' });
    const result = validatePatch(ctx.project.timeline, { operations: ops });
    expect(result.valid).toBe(true);
  });

  it('add_keyframes derives ids and defaults easing', () => {
    const ops = build('add_keyframes', {
      clipId: 'clip_a',
      keyframes: [{ time: 0, property: 'scale', value: 1 }],
    });
    expect(ops[0]).toMatchObject({ type: 'add_keyframes', clipId: 'clip_a' });
    const op = ops[0] as Extract<Operation, { type: 'add_keyframes' }>;
    expect(op.keyframes[0]).toMatchObject({ property: 'scale', easing: 'linear' });
    expect(op.keyframes[0]?.id).toContain('clip_a');
  });

  it('add_keyframes honours an explicit easing', () => {
    const ops = build('add_keyframes', {
      clipId: 'clip_a',
      keyframes: [{ time: 1, property: 'opacity', value: 0, easing: 'ease-in' }],
    });
    const op = ops[0] as Extract<Operation, { type: 'add_keyframes' }>;
    expect(op.keyframes[0]?.easing).toBe('ease-in');
  });

  it('punch_in defaults to the whole clip and a 1→1.2 scale ramp', () => {
    const ops = build('punch_in', { clipId: 'clip_a' });
    expect(ops[0]).toMatchObject({ type: 'add_keyframes', clipId: 'clip_a' });
    const op = ops[0] as Extract<Operation, { type: 'add_keyframes' }>;
    expect(op.keyframes).toHaveLength(2);
    // clip_a runs 0..6 → the punch-in window spans the clip.
    expect(op.keyframes[0]).toMatchObject({
      property: 'scale',
      value: 1,
      time: 0,
      easing: 'ease-in-out',
    });
    expect(op.keyframes[1]).toMatchObject({ property: 'scale', value: 1.2, time: 6 });
  });

  it('punch_in honours an explicit window, scales, and easing', () => {
    const ops = build('punch_in', {
      clipId: 'clip_a',
      startTime: 1,
      endTime: 3,
      fromScale: 1.1,
      toScale: 1.5,
      easing: 'ease-out',
    });
    const op = ops[0] as Extract<Operation, { type: 'add_keyframes' }>;
    expect(op.keyframes[0]).toMatchObject({ time: 1, value: 1.1, easing: 'ease-out' });
    expect(op.keyframes[1]).toMatchObject({ time: 3, value: 1.5 });
  });

  it('punch_in falls back to a default window for an unknown clip', () => {
    const ops = build('punch_in', { clipId: 'ghost' });
    const op = ops[0] as Extract<Operation, { type: 'add_keyframes' }>;
    expect(op.keyframes[1]!.time).toBeCloseTo(1.5); // DEFAULT_PUNCH_IN_SECONDS
  });

  it('punch_in repairs a collapsed window (start ≥ end)', () => {
    const ops = build('punch_in', { clipId: 'clip_a', startTime: 5, endTime: 3 });
    const op = ops[0] as Extract<Operation, { type: 'add_keyframes' }>;
    expect(op.keyframes[0]!.time).toBe(5);
    expect(op.keyframes[1]!.time).toBeCloseTo(6.5); // 5 + DEFAULT_PUNCH_IN_SECONDS
  });

  it('apply_color_grade defaults type/params and accepts overrides', () => {
    const def = build('apply_color_grade', { clipId: 'clip_a' })[0];
    expect(def).toMatchObject({ type: 'apply_color_grade', clipId: 'clip_a' });
    const grade = def as Extract<Operation, { type: 'apply_color_grade' }>;
    expect(grade.effect).toMatchObject({ type: 'color_grade', params: {} });

    const lut = build('apply_color_grade', {
      clipId: 'clip_a',
      type: 'lut',
      params: { name: 'teal' },
    })[0] as Extract<Operation, { type: 'apply_color_grade' }>;
    expect(lut.effect).toMatchObject({ type: 'lut', params: { name: 'teal' } });
  });

  // GAP-013 (run `fc10301a`). The brief said "evaluate multiple suitable tracks and select
  // the strongest one", listing clear beat, build-up, drop and beat separation as the
  // criteria. Search results carry a title, a duration and a licence — Openverse publishes
  // no tempo, and its `genres`/`category` come back null in practice — so that judgement
  // cannot be made from them. The run reported a track as "a high-energy cinematic drum
  // track built for adventure" having heard nothing and measured nothing.
  it('says that music results carry no tempo, and names the route that does', () => {
    const description = getTool('search_music')?.description ?? '';
    expect(description).toMatch(/NO tempo, key, energy or section structure/);
    expect(description).toContain('detect_beats');
    // And that changing your mind is cheap, so the honest route is not the expensive one.
    expect(description).toMatch(/undo removes the track/);
  });

  // GAP-017 (run `fc10301a`). Every grade parameter name and bound was enforced on both
  // sides of the boundary and NONE was advertised: the description was "Apply a color
  // grade to a clip." and `params` an untyped record, so a model could only learn the
  // contract by guessing and being refused. That run loaded the color-grading playbook —
  // which instructs this tool and speaks of keeping corrections "within ±0.3" — and
  // applied no grade at all.
  it('advertises every grade parameter and its real range, from the contract itself', () => {
    const description = getTool('apply_color_grade')?.description ?? '';
    for (const [name, { min, max }] of Object.entries(COLOR_GRADE_PARAMETER_CONTRACTS)) {
      expect(description).toContain(`${name} (${String(min)}..${String(max)})`);
    }
    // The other kind, and where transforms actually come from.
    expect(description).toContain('params.path');
    expect(description).toMatch(/add_keyframes|punch_in/);
  });

  // GAP-004 (run `fc10301a`). Laying out 61 photos meant 61 `add_clip` calls against a
  // 30-step budget, interleaved with a re-read per batch. The run managed 34 in four apply
  // turns and the batches decayed 12 → 9 → 8 → 5 as reasoning ate the output reservation.
  // Per-clip granularity is right for fixing one shot and wrong for building a sequence.
  it('remove_keyframes can clear a property or drop one keyframe, so animation is reversible', () => {
    // Without this tool the agent could only ever ADD motion: asked to "stop the
    // zoom on that shot" it had `add_keyframes` and nothing else, so the request
    // had no tool that could answer it.
    expect(
      build('remove_keyframes', { clipId: 'clip_a', targets: [{ property: 'scale' }] }),
    ).toEqual([{ type: 'remove_keyframes', clipId: 'clip_a', targets: [{ property: 'scale' }] }]);
    expect(
      build('remove_keyframes', { clipId: 'clip_a', targets: [{ property: 'scale', time: 2 }] }),
    ).toEqual([
      { type: 'remove_keyframes', clipId: 'clip_a', targets: [{ property: 'scale', time: 2 }] },
    ]);
  });

  it('omits `time` entirely rather than sending undefined, which means "clear all"', () => {
    // `applyRemoveKeyframes` treats a target with no `time` as "clear the whole
    // property", so the key has to be absent — not present-and-undefined, which
    // survives a JSON round trip differently.
    const [op] = build('remove_keyframes', { clipId: 'clip_a', targets: [{ property: 'x' }] }) as [
      { targets: readonly Record<string, unknown>[] },
    ];
    expect('time' in op.targets[0]!).toBe(false);
  });

  it('never relocates PICTURE off the lane it was aimed at, even when it collides', () => {
    // `picture-occupancy.ts`: the preview flattens picture clips from every track
    // into one chain while the export composites stacked layers, so two picture
    // clips overlapping IN TIME render one way and preview another (blocker #1,
    // SUC-P1) — "overlap is measured in time, not by layer". Moving a colliding
    // video to another lane therefore does not avoid the problem, it creates it and
    // hides it until export. The refusal has to stand for picture, so the op keeps
    // the named lane and the validator rejects it exactly as before.
    const ops = build('add_clip', {
      trackId: 'video_1',
      assetId: 'asset_1',
      start: 1,
      end: 3,
    });
    expect(ops.some((op) => op.type === 'add_layer')).toBe(false);
    expect(ops[0]).toMatchObject({ type: 'add_clip', trackId: 'video_1' });
  });

  it('add_clips places a whole sequence in one patch, by add_clip’s rules', () => {
    // Placed past the fixture's own clips (which fill 0–10), so the batch stays on
    // the named lane and this test stays about batching rather than placement.
    const batch = build('add_clips', {
      trackId: 'video_1',
      clips: [
        { assetId: 'asset_1', start: 10, end: 11.5 },
        { assetId: 'asset_1', start: 11.5, end: 12, sourceStart: 4 },
      ],
    });
    expect(batch).toEqual([
      {
        type: 'add_clip',
        trackId: 'video_1',
        assetId: 'asset_1',
        start: 10,
        end: 11.5,
        sourceStart: 0,
        sourceEnd: 1.5,
      },
      {
        type: 'add_clip',
        trackId: 'video_1',
        assetId: 'asset_1',
        start: 11.5,
        end: 12,
        sourceStart: 4,
        // Derived from the timeline span, exactly as the singular tool derives it — a
        // batch that placed clips by different rules would be worse than no batch.
        sourceEnd: 4.5,
      },
    ]);
  });

  it('add_clips produces exactly what the same placements would through add_clip', () => {
    const placements = [
      { assetId: 'asset_1', start: 10, end: 11 },
      { assetId: 'asset_1', start: 11, end: 12.25, sourceStart: 3 },
      { assetId: 'asset_1', start: 12.25, end: 13 },
    ];
    expect(build('add_clips', { trackId: 'video_1', clips: placements })).toEqual(
      placements.flatMap((clip) => build('add_clip', { trackId: 'video_1', ...clip })),
    );
  });

  it('add_clips refuses an empty batch rather than proposing nothing', () => {
    expect(() => build('add_clips', { trackId: 'video_1', clips: [] })).toThrow();
  });

  // A batch is still N operations against the turn's blast-radius bound. Rejecting an
  // over-long batch at the schema — where the description states the limit — beats
  // `Turn rejected: 120 operations exceeds the per-turn cap`, which names no fix and
  // invites the model to re-send the same batch.
  it('refuses a batch longer than one turn could apply, and states the limit', () => {
    // Past the fixture's clips, so every entry stays on the named lane and the op
    // count is one per entry rather than one plus a lane.
    const entry = (i: number) => ({ assetId: 'asset_1', start: 10 + i, end: 10 + i + 0.5 });
    const atCap = Array.from({ length: MAX_CLIPS_PER_BATCH }, (_, i) => entry(i));
    expect(build('add_clips', { trackId: 'video_1', clips: atCap })).toHaveLength(
      MAX_CLIPS_PER_BATCH,
    );
    expect(() =>
      build('add_clips', { trackId: 'video_1', clips: [...atCap, entry(MAX_CLIPS_PER_BATCH)] }),
    ).toThrow();
    expect(getTool('add_clips')?.description).toContain(String(MAX_CLIPS_PER_BATCH));
  });

  it('adjust_audio / add_transition / add_mask / track_object', () => {
    expect(build('adjust_audio', { clipId: 'clip_a', gainDb: -3 })[0]).toEqual({
      type: 'adjust_audio',
      clipId: 'clip_a',
      gainDb: -3,
    });
    expect(
      build('add_transition', {
        trackId: 'video_1',
        fromClipId: 'clip_a',
        toClipId: 'clip_b',
        kind: 'fade',
        durationSeconds: 0.5,
      })[0]?.type,
    ).toBe('add_transition');
    expect(build('add_mask', { clipId: 'clip_a', shape: 'ellipse' })[0]).toEqual({
      type: 'add_mask',
      clipId: 'clip_a',
      shape: 'ellipse',
    });
    expect(build('track_object', { clipId: 'clip_a', target: 'face' })[0]).toEqual({
      type: 'track_object',
      clipId: 'clip_a',
      target: 'face',
    });
  });

  it('track_object tracks an arbitrary picked region', () => {
    const op = build('track_object', {
      clipId: 'clip_a',
      target: 'object',
      region: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 },
      engine: 'manual',
    })[0];
    expect(op).toEqual({
      type: 'track_object',
      clipId: 'clip_a',
      target: 'object',
      region: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 },
      engine: 'manual',
    });
  });

  it('produced operations pass the patch validator', () => {
    const ops = [
      ...build('trim_clip', { clipId: 'clip_a', start: 0, end: 4 }),
      ...build('adjust_audio', { clipId: 'clip_b', gainDb: -2 }),
    ];
    const result = validatePatch(
      ctx.project.timeline,
      { operations: ops },
      {
        assetIds: ['asset_1'],
      },
    );
    expect(result.valid).toBe(true);
  });
});

describe('project (media-bin) tools — add_asset & manage_assets', () => {
  const buildProject = (name: string, args: Record<string, unknown>, c = ctx) => {
    const tool = getTool(name);
    if (!tool?.buildOps) throw new Error(`no buildOps for ${name}`);
    return tool.buildOps(args, c);
  };

  it('add_asset derives a deterministic id from the path', () => {
    const ops = buildProject('add_asset', { path: 'media/new clip.mp4', kind: 'video' });
    expect(ops).toEqual([
      {
        type: 'add_asset',
        asset: { id: 'asset_media_new_clip_mp4', path: 'media/new clip.mp4', kind: 'video' },
      },
    ]);
  });

  // The captured failure. The model had lost every stock `remoteId` to log compaction and
  // guessed a path instead; nothing looked at it, so the patch validated, the card showed a
  // checkmark, and the project gained a reference to a file that cannot exist. A dead end
  // the run can act on beats a success it cannot.
  // Traversal is deliberately NOT tested here: it is owned by the layers that resolve paths
  // (the MCP session's sandbox, the desktop commit check), because a string test for ".."
  // cannot see through `a/b/../../../etc` or a symlink.
  it('add_asset refuses a path the model invented rather than was handed', () => {
    for (const path of ['stock://pexels/20349219', '///', '  ', 'clip']) {
      expect(() => buildProject('add_asset', { path, kind: 'video' })).toThrow();
    }
  });

  it('names add_stock in the refusal, so the model knows where the real path comes from', () => {
    expect(() => buildProject('add_asset', { path: 'stock://pexels/20349219' })).toThrow(
      /add_stock/,
    );
  });

  it('manage_assets plan accepts folders-only or assignments-only', () => {
    expect(buildProject('manage_assets', { folders: [{ id: 'f', name: 'F' }] })).toEqual([
      { type: 'create_folder', folderId: 'f', name: 'F', parentId: null },
    ]);
    expect(
      buildProject('manage_assets', { assignments: [{ assetId: 'asset_1', folderId: null }] }),
    ).toEqual([{ type: 'move_asset', assetId: 'asset_1', folderId: null }]);
  });

  it('add_asset honors an explicit id, folderId and duration', () => {
    const ops = buildProject('add_asset', {
      path: 'gen/voice.wav',
      kind: 'audio',
      id: 'vo_1',
      folderId: 'folder_audio',
      durationSeconds: 12,
    });
    expect(ops).toEqual([
      {
        type: 'add_asset',
        asset: {
          id: 'vo_1',
          path: 'gen/voice.wav',
          kind: 'audio',
          durationSeconds: 12,
          folderId: 'folder_audio',
        },
      },
    ]);
  });

  it('add_asset output is a valid, applicable patch', () => {
    const ops = buildProject('add_asset', { path: 'media/b.mp4' });
    const project = ctx.project;
    const result = validatePatch(
      project.timeline,
      { operations: ops },
      {
        assetIds: project.assets.map((a) => a.id),
        folders: project.folders,
      },
    );
    expect(result.valid).toBe(true);
  });

  it('manage_assets by-kind groups existing assets into kind folders', () => {
    const ops = buildProject('manage_assets', { strategy: 'by-kind' });
    expect(ops).toContainEqual({
      type: 'create_folder',
      folderId: 'folder_video',
      name: 'Video',
      parentId: null,
    });
    expect(ops).toContainEqual({
      type: 'move_asset',
      assetId: 'asset_1',
      folderId: 'folder_video',
    });
  });

  it('manage_assets defaults to by-kind when no plan is provided', () => {
    expect(buildProject('manage_assets', {})).toEqual(
      buildProject('manage_assets', { strategy: 'by-kind' }),
    );
  });

  it('manage_assets by-kind skips an existing folder and an already-filed asset', () => {
    const filed = makeProject({
      assets: [
        {
          id: 'asset_1',
          path: 'a.mp4',
          kind: 'video',
          durationSeconds: 5,
          folderId: 'folder_video',
        },
      ],
      folders: [{ id: 'folder_video', name: 'Video', parentId: null }],
    });
    const ops = buildProject('manage_assets', { strategy: 'by-kind' }, { project: filed });
    expect(ops).toEqual([]); // nothing to create, nothing to move
  });

  it('manage_assets applies an explicit semantic plan', () => {
    const ops = buildProject('manage_assets', {
      folders: [{ id: 'broll', name: 'B-roll' }],
      assignments: [{ assetId: 'asset_1', folderId: 'broll' }],
    });
    expect(ops).toEqual([
      { type: 'create_folder', folderId: 'broll', name: 'B-roll', parentId: null },
      { type: 'move_asset', assetId: 'asset_1', folderId: 'broll' },
    ]);
  });

  it('manage_assets plan honors nested parentId and root (null) assignment', () => {
    const ops = buildProject('manage_assets', {
      folders: [{ id: 'child', name: 'City', parentId: 'broll' }],
      assignments: [{ assetId: 'asset_1', folderId: null }],
    });
    expect(ops).toEqual([
      { type: 'create_folder', folderId: 'child', name: 'City', parentId: 'broll' },
      { type: 'move_asset', assetId: 'asset_1', folderId: null },
    ]);
  });

  it('add_asset / manage_assets are flagged mutating and exposed over the surface', () => {
    expect(getTool('add_asset')?.mutates).toBe(true);
    expect(getTool('manage_assets')?.kind).toBe('mutate');
    const names = toolDescriptors((t) => t.mutates).map((t) => t.name);
    expect(names).toContain('add_asset');
    expect(names).toContain('manage_assets');
  });

  it('reject bad args (strict schema)', () => {
    expect(() => buildProject('add_asset', { path: 'x', kind: 'gif' })).toThrow(ZodError);
    expect(() => buildProject('manage_assets', { strategy: 'random' })).toThrow(ZodError);
  });
});

describe('transcribe (plan H0.1) — host-owned speech-to-text', () => {
  const parseTranscribe = (args: Record<string, unknown>) => {
    const tool = getTool('transcribe');
    if (!tool) throw new Error('no transcribe tool');
    return tool.parse(args);
  };

  it('accepts only optional asset identity', () => {
    expect(parseTranscribe({})).toEqual({});
    expect(parseTranscribe({ assetId: 'asset_1' })).toEqual({ assetId: 'asset_1' });
  });

  it('rejects model-supplied words and unknown fields', () => {
    expect(() => parseTranscribe({ words: [] })).toThrow(ZodError);
    expect(() => parseTranscribe({ assetId: 'asset_1', bogus: true })).toThrow(ZodError);
  });

  it('is host-executed analysis rather than an in-process mutation', () => {
    expect(getTool('transcribe')?.mutates).toBe(false);
    expect(getTool('transcribe')?.kind).toBe('analysis');
    expect(toolDescriptors((tool) => tool.kind === 'analysis').map((tool) => tool.name)).toContain(
      'transcribe',
    );
  });
});

describe('per-clip styling edits (schema v5–v8) — caption/speed/crop/blend', () => {
  const captionCtx: ToolContext = {
    project: makeProject({
      timeline: {
        tracks: [...ctx.project.timeline.tracks, { id: 'caption_1', type: 'caption', clips: [] }],
      },
    }),
    selection: ctx.selection,
  };

  const buildCaption = (name: string, args: Record<string, unknown>): Operation[] => {
    const tool = getTool(name);
    if (!tool?.buildOps) throw new Error(`no buildOps for ${name}`);
    return tool.buildOps(args, captionCtx);
  };

  it('discovers all bundled fonts and filterable production templates', () => {
    const tool = getTool('discover_caption_styles');
    if (!tool?.read) throw new Error('no discover_caption_styles read');
    const result = tool.read({ query: 'karaoke', limit: 3 }, captionCtx) as {
      fonts: { family: string }[];
      templates: { templateId: string }[];
    };
    expect(result.fonts.length).toBeGreaterThanOrEqual(20);
    expect(result.fonts.map((font) => font.family)).toContain('Inter');
    expect(result.templates.length).toBeLessThanOrEqual(3);
    expect(result.templates.some((template) => template.templateId === 'karaoke')).toBe(true);
  });

  it('filters discovered templates by category', () => {
    const tool = getTool('discover_caption_styles');
    if (!tool?.read) throw new Error('no discover_caption_styles read');
    const result = tool.read({ category: 'karaoke', limit: 45 }, captionCtx) as {
      templates: { templateId: string; category: string }[];
    };
    expect(result.templates.length).toBeGreaterThan(0);
    expect(result.templates.every((template) => template.category === 'karaoke')).toBe(true);
  });

  it('sets a complete track-wide caption composition as one reversible operation', () => {
    const style = {
      templateId: 'headline',
      fontFamily: 'Montserrat',
      xPercent: 31,
      yPercent: 72,
      rotation: -4,
      fontScale: 1.4,
      lineHeight: 0.95,
      safeArea: true,
    };
    const operations = buildCaption('set_track_caption_style', {
      trackId: 'caption_1',
      captionStyle: style,
    });
    expect(operations).toEqual([
      { type: 'set_track_caption_style', trackId: 'caption_1', captionStyle: style },
    ]);
    expect(validatePatch(captionCtx.project.timeline, { operations }).valid).toBe(true);
  });

  it('AI auto emphasis grounds keywords from existing caption clips, not just the transcript', () => {
    // "sunrise" only exists on an already-authored caption cue, not in the
    // project transcript — grounding must search caption clip vocabulary too.
    const withCaptionClip: ToolContext = {
      project: makeProject({
        timeline: {
          tracks: [
            ...ctx.project.timeline.tracks,
            {
              id: 'caption_1',
              type: 'caption',
              clips: [
                {
                  id: 'caption_clip_1',
                  assetId: 'asset_1',
                  trackId: 'caption_1',
                  start: 0,
                  end: 1,
                  sourceStart: 0,
                  sourceEnd: 1,
                  effects: [],
                  keyframes: [],
                  captionCue: {
                    // "today" is in the display text but not in the word timings,
                    // so grounding must also fall back to the raw cue text.
                    text: 'a golden sunrise today',
                    words: [
                      { word: 'a', start: 0, end: 0.2 },
                      { word: 'golden', start: 0.2, end: 0.6 },
                      { word: 'sunrise', start: 0.6, end: 1 },
                    ],
                  },
                },
                {
                  // No captionCue: exercises the "no cue yet" fallback path
                  // alongside a sibling clip that does have one.
                  id: 'caption_clip_2',
                  assetId: 'asset_1',
                  trackId: 'caption_1',
                  start: 1,
                  end: 2,
                  sourceStart: 1,
                  sourceEnd: 2,
                  effects: [],
                  keyframes: [],
                },
              ],
            },
          ],
        },
      }),
      selection: ctx.selection,
    };
    const tool = getTool('auto_emphasize_captions');
    if (!tool?.buildOps) throw new Error('no buildOps for auto_emphasize_captions');
    const operations = tool.buildOps(
      { trackId: 'caption_1', keywords: ['SUNRISE'] },
      withCaptionClip,
    );
    expect(operations).toEqual([
      {
        type: 'set_track_caption_style',
        trackId: 'caption_1',
        captionStyle: {
          accent: { mode: 'keywords', keywords: ['sunrise'], color: '#ffd60a', fontScale: 1.18 },
        },
      },
    ]);
  });

  it('auto_emphasize_captions grounds a spoken phrase, and still rejects an unspoken one', () => {
    // From a captured run: the editor says "make founders stop scrolling", the
    // model asked to emphasise "stop scrolling", and grounding against a BAG of
    // single words rejected it twice — a rule the model could not satisfy, over
    // a phrase that is plainly spoken. Grounding follows word ORDER instead.
    const tool = getTool('auto_emphasize_captions');
    if (!tool?.buildOps) throw new Error('no buildOps for auto_emphasize_captions');
    const spoken: ToolContext = {
      project: makeProject({
        transcript: [
          { word: 'make', start: 0, end: 0.3 },
          { word: 'founders', start: 0.3, end: 0.7 },
          { word: 'stop', start: 0.7, end: 1 },
          { word: 'scrolling', start: 1, end: 1.4 },
        ],
        timeline: {
          fps: 30,
          duration: 2,
          tracks: [{ id: 'caption_1', type: 'caption', clips: [] }],
        },
      }),
      selection: captionCtx.selection,
    };

    expect(tool.buildOps({ trackId: 'caption_1', keywords: ['stop scrolling'] }, spoken)).toEqual([
      {
        type: 'set_track_caption_style',
        trackId: 'caption_1',
        captionStyle: {
          accent: {
            mode: 'keywords',
            keywords: ['stop scrolling'],
            color: '#ffd60a',
            fontScale: 1.18,
          },
        },
      },
    ]);

    // Invented text is still refused, and so is a phrase whose words are all
    // spoken but never consecutively — that is not a phrase the editor said.
    expect(() =>
      tool.buildOps?.({ trackId: 'caption_1', keywords: ['scrolling founders'] }, spoken),
    ).toThrow(/not present in the caption text or transcript/);
    expect(() =>
      tool.buildOps?.({ trackId: 'caption_1', keywords: ['buy my course'] }, spoken),
    ).toThrow(/not present in the caption text or transcript/);
  });

  it('auto_emphasize_captions rejects keywords with no letters/numbers, and duplicates', () => {
    const tool = getTool('auto_emphasize_captions');
    if (!tool?.buildOps) throw new Error('no buildOps for auto_emphasize_captions');
    expect(() => tool.buildOps?.({ trackId: 'caption_1', keywords: ['!!!'] }, captionCtx)).toThrow(
      /must contain a letter or number/,
    );
    expect(() =>
      tool.buildOps?.({ trackId: 'caption_1', keywords: ['world', 'World'] }, captionCtx),
    ).toThrow(/must be unique/);
  });

  it('auto_emphasize_captions falls back to the existing track style for color/fontScale', () => {
    const tool = getTool('auto_emphasize_captions');
    if (!tool?.buildOps) throw new Error('no buildOps for auto_emphasize_captions');

    // The per-call style block is gone (P2.2): design changes go through
    // set_track_caption_style, so the only fallback is the track's existing accent.
    expect(() =>
      tool.buildOps?.(
        {
          trackId: 'caption_1',
          keywords: ['world'],
          style: { accent: { mode: 'keywords', keywords: [] } },
        },
        captionCtx,
      ),
    ).toThrow();

    // Neither top-level nor style.accent given: falls back to the track's existing style.
    const trackWithExistingAccent: ToolContext = {
      project: makeProject({
        timeline: {
          tracks: [
            ...ctx.project.timeline.tracks,
            {
              id: 'caption_1',
              type: 'caption',
              clips: [],
              captionStyle: {
                accent: { mode: 'keywords', keywords: [], color: '#abcdef', fontScale: 1.6 },
              },
            },
          ],
        },
      }),
      selection: ctx.selection,
    };
    const fromTrackStyle = tool.buildOps(
      { trackId: 'caption_1', keywords: ['world'] },
      trackWithExistingAccent,
    );
    expect(fromTrackStyle[0]).toMatchObject({
      captionStyle: { accent: { color: '#abcdef', fontScale: 1.6 } },
    });
  });

  it('auto_emphasize_captions rejects an unknown or non-caption track', () => {
    const tool = getTool('auto_emphasize_captions');
    if (!tool?.buildOps) throw new Error('no buildOps for auto_emphasize_captions');
    expect(() => tool.buildOps?.({ trackId: 'ghost', keywords: ['world'] }, captionCtx)).toThrow(
      /Unknown track/,
    );
    expect(() => tool.buildOps?.({ trackId: 'video_1', keywords: ['world'] }, captionCtx)).toThrow(
      /is not a caption track/,
    );
  });

  it('AI auto emphasis grounds keywords and keeps the existing track design', () => {
    const operations = buildCaption('auto_emphasize_captions', {
      trackId: 'caption_1',
      keywords: ['WORLD'],
      color: '#ff3b30',
      fontScale: 1.35,
    });
    expect(operations).toEqual([
      {
        type: 'set_track_caption_style',
        trackId: 'caption_1',
        captionStyle: {
          accent: {
            mode: 'keywords',
            keywords: ['world'],
            color: '#ff3b30',
            fontScale: 1.35,
          },
        },
      },
    ]);
    expect(validatePatch(captionCtx.project.timeline, { operations }).valid).toBe(true);
    expect(() =>
      buildCaption('auto_emphasize_captions', {
        trackId: 'caption_1',
        keywords: ['invented'],
      }),
    ).toThrow(/not present/);
  });

  it('rejects unknown templates and fonts that cannot render consistently', () => {
    expect(() =>
      buildCaption('set_track_caption_style', {
        trackId: 'caption_1',
        captionStyle: { templateId: 'imaginary' },
      }),
    ).toThrow(/Unknown caption template/);
    expect(() =>
      build('set_caption_style', {
        clipId: 'clip_a',
        captionStyle: { fontFamily: 'Local Mystery Font' },
      }),
    ).toThrow(/not bundled/);
    expect(() =>
      build('set_caption_style', {
        clipId: 'clip_a',
        captionStyle: {
          accent: { mode: 'keywords', keywords: ['world'], fontFamily: 'Accent Mystery Font' },
        },
      }),
    ).toThrow(/not bundled/);
  });

  it('set_caption_style builds an op carrying the animated style, and null clears it', () => {
    const style = {
      fontFamily: 'Inter',
      textColor: '#fff',
      position: 'bottom' as const,
      xPercent: 38,
      yPercent: 64,
      rotation: -6,
      maxWidthPercent: 70,
      textAlign: 'left' as const,
      lineHeight: 0.95,
      safeArea: true,
      highlight: { enabled: true, color: '#ff0', animation: 'karaoke-fill' as const },
    };
    expect(build('set_caption_style', { clipId: 'clip_a', captionStyle: style })).toEqual([
      { type: 'set_caption_style', clipId: 'clip_a', captionStyle: style },
    ]);
    expect(build('set_caption_style', { clipId: 'clip_a', captionStyle: null })).toEqual([
      { type: 'set_caption_style', clipId: 'clip_a', captionStyle: null },
    ]);
    // A malformed highlight animation is rejected by the reused CaptionStyleSchema.
    expect(() =>
      build('set_caption_style', {
        clipId: 'clip_a',
        captionStyle: { highlight: { animation: 'spin' } },
      }),
    ).toThrow(ZodError);
  });

  it('set_clip_speed builds an op; accepts a string-encoded speed and null reset', () => {
    expect(build('set_clip_speed', { clipId: 'clip_a', speed: 2 })).toEqual([
      { type: 'set_clip_speed', clipId: 'clip_a', speed: 2 },
    ]);
    // Numeric string coerces (NVIDIA/OpenAI-style serialisation).
    expect(build('set_clip_speed', { clipId: 'clip_a', speed: '0.5' })).toEqual([
      { type: 'set_clip_speed', clipId: 'clip_a', speed: 0.5 },
    ]);
    expect(build('set_clip_speed', { clipId: 'clip_a', speed: null })).toEqual([
      { type: 'set_clip_speed', clipId: 'clip_a', speed: null },
    ]);
    // Non-positive speed is rejected.
    expect(() => build('set_clip_speed', { clipId: 'clip_a', speed: 0 })).toThrow(ZodError);
  });

  it('set_clip_crop builds an op with a rect, and null clears the crop', () => {
    const crop = { x: 0.25, y: 0, width: 0.5, height: 1 };
    expect(build('set_clip_crop', { clipId: 'clip_a', crop })).toEqual([
      { type: 'set_clip_crop', clipId: 'clip_a', crop },
    ]);
    expect(build('set_clip_crop', { clipId: 'clip_a', crop: null })).toEqual([
      { type: 'set_clip_crop', clipId: 'clip_a', crop: null },
    ]);
    // A rect spilling past the source frame is rejected by the reused CropRectSchema.
    expect(() =>
      build('set_clip_crop', { clipId: 'clip_a', crop: { x: 0.8, y: 0, width: 0.5, height: 1 } }),
    ).toThrow(ZodError);
  });

  it('set_clip_blend_mode builds an op, and null resets to normal', () => {
    expect(build('set_clip_blend_mode', { clipId: 'clip_a', blendMode: 'screen' })).toEqual([
      { type: 'set_clip_blend_mode', clipId: 'clip_a', blendMode: 'screen' },
    ]);
    expect(build('set_clip_blend_mode', { clipId: 'clip_a', blendMode: null })).toEqual([
      { type: 'set_clip_blend_mode', clipId: 'clip_a', blendMode: null },
    ]);
    expect(() => build('set_clip_blend_mode', { clipId: 'clip_a', blendMode: 'glow' })).toThrow(
      ZodError,
    );
  });

  it('the styling ops pass the patch validator on a real clip', () => {
    const ops = [
      ...build('set_caption_style', {
        clipId: 'clip_a',
        captionStyle: { position: 'top' },
      }),
      ...build('set_clip_crop', { clipId: 'clip_a', crop: { x: 0, y: 0, width: 0.5, height: 1 } }),
      ...build('set_clip_blend_mode', { clipId: 'clip_a', blendMode: 'multiply' }),
    ];
    expect(validatePatch(ctx.project.timeline, { operations: ops }).valid).toBe(true);
  });

  it('exposes the new styling tools with their scope categories', () => {
    for (const [name, cap] of [
      ['set_caption_style', 'captions'],
      ['set_track_caption_style', 'captions'],
      ['auto_emphasize_captions', 'captions'],
      ['set_clip_speed', 'timing'],
      ['set_clip_crop', 'reframe'],
      ['set_clip_blend_mode', 'compositing'],
    ] as const) {
      expect(getTool(name)?.mutates).toBe(true);
      expect(getTool(name)?.capabilities).toContain(cap);
      expect(toolDescriptors((t) => t.mutates).map((t) => t.name)).toContain(name);
    }
  });
});

describe('markers / chapters (schema v9)', () => {
  const buildMarker = (name: string, args: Record<string, unknown>) => {
    const tool = getTool(name);
    if (!tool?.buildOps) throw new Error(`no buildOps for ${name}`);
    return tool.buildOps(args, ctx);
  };

  it('add_marker derives a deterministic id and omits absent label/color', () => {
    expect(buildMarker('add_marker', { time: 3 })).toEqual([
      { type: 'add_marker', id: 'marker_3000_', time: 3 },
    ]);
  });

  it('add_marker keeps an explicit id, label (chapter) and color', () => {
    expect(
      buildMarker('add_marker', { time: 12, label: 'Intro', color: '#f00', id: 'm1' }),
    ).toEqual([{ type: 'add_marker', id: 'm1', time: 12, label: 'Intro', color: '#f00' }]);
  });

  it('remove_marker builds a reversible removal op', () => {
    expect(buildMarker('remove_marker', { id: 'm1' })).toEqual([
      { type: 'remove_marker', id: 'm1' },
    ]);
  });

  it('reject bad args (strict schema)', () => {
    expect(() => buildMarker('add_marker', { time: -1 })).toThrow(ZodError);
    expect(() => buildMarker('add_marker', { time: 1, label: '' })).toThrow(ZodError);
    expect(() => buildMarker('remove_marker', {})).toThrow(ZodError);
  });

  it('are flagged mutating, categorized under markers, and exposed over the surface', () => {
    for (const name of ['add_marker', 'remove_marker']) {
      expect(getTool(name)?.mutates).toBe(true);
      expect(getTool(name)?.capabilities).toContain('markers');
      expect(toolDescriptors((t) => t.mutates).map((t) => t.name)).toContain(name);
    }
  });
});

describe('schema validation rejects bad input', () => {
  it('throws ZodError on missing required args', () => {
    expect(() => build('trim_clip', { clipId: 'clip_a' })).toThrow(ZodError);
  });

  it('throws ZodError on unknown extra args (strict)', () => {
    expect(() => build('trim_clip', { clipId: 'c', start: 0, end: 1, foo: 1 })).toThrow(ZodError);
  });

  it('throws ZodError on wrong types and bad enums', () => {
    expect(() => build('adjust_audio', { clipId: 'c', gainDb: 'loud' })).toThrow(ZodError);
    expect(() => build('add_mask', { clipId: 'c', shape: 'triangle' })).toThrow(ZodError);
  });

  it('every registered tool validates empty args and read tools return data', () => {
    for (const tool of TOOL_REGISTRY) {
      // No-arg tools accept {}; arg-bearing tools (e.g. load_skill) reject {} —
      // both exercise parse. Only no-arg read tools can be invoked with {}.
      let emptyArgsOk = true;
      try {
        tool.parse({});
      } catch (e) {
        emptyArgsOk = false;
        expect(e).toBeInstanceOf(ZodError);
      }
      if (tool.read && emptyArgsOk) expect(tool.read({}, ctx)).not.toBeUndefined();
    }
  });

  it('parse() on read/action/analysis/unavailable tools validates too', () => {
    expect(() => getTool('get_timeline')?.parse({ nope: 1 })).toThrow(ZodError);
    expect(() => getTool('render_preview')?.parse({ nope: 1 })).toThrow(ZodError);
    expect(() => getTool('detect_subjects')?.parse({ nope: 1 })).toThrow(ZodError);
    // intent is a required literal: an empty arg set is invalid.
    expect(() => getTool('detect_subjects')?.parse({})).toThrow(ZodError);
    // Analysis tools accept {} (all args optional) and reject unknown keys.
    expect(getTool('analyze_silence')?.parse({})).toEqual({});
    expect(() => getTool('detect_scenes')?.parse({ nope: 1 })).toThrow(ZodError);
  });
});

describe('token-friendly reads — get_timeline_summary / get_clips / get_clip / windowed transcript', () => {
  it('get_timeline_summary returns compact per-track stats, never clip bodies', () => {
    const summary = getTool('get_timeline_summary')?.read?.({}, ctx) as {
      durationSeconds: number;
      trackCount: number;
      clipCount: number;
      tracks: {
        id: string;
        clipCount: number;
        firstClipStart: number | null;
        lastClipEnd: number | null;
      }[];
      markerCount: number;
      transcriptWordCount: number;
    };
    expect(summary.durationSeconds).toBe(10);
    expect(summary.trackCount).toBe(2);
    expect(summary.clipCount).toBe(2);
    expect(summary.tracks[0]).toEqual({
      id: 'video_1',
      type: 'video',
      clipCount: 2,
      firstClipStart: 0,
      lastClipEnd: 10,
    });
    expect(summary.tracks[1]).toEqual({
      id: 'audio_1',
      type: 'audio',
      clipCount: 0,
      firstClipStart: null,
      lastClipEnd: null,
    });
    expect(summary.markerCount).toBe(0);
    expect(summary.transcriptWordCount).toBe(2);
    expect(JSON.stringify(summary)).not.toContain('sourceStart');
  });

  it('flags cropped and graded clips so reframing coverage is ONE call', () => {
    // The defect this closes: two captured runs reframed a handful of shots out of ~50 and
    // reported the job done, because checking coverage cost one deep read per clip.
    const project = makeProject();
    const [first] = project.timeline.tracks[0]!.clips;
    const withLook = {
      ...project,
      timeline: {
        ...project.timeline,
        tracks: project.timeline.tracks.map((track, index) =>
          index === 0
            ? {
                ...track,
                clips: track.clips.map((clip) =>
                  clip.id === first!.id
                    ? {
                        ...clip,
                        crop: { x: 0.34, y: 0, width: 0.3164, height: 1 },
                        effects: [
                          {
                            id: 'g1',
                            type: 'color_grade' as const,
                            params: { exposure: 0.1 },
                            keyframes: [],
                          },
                        ],
                      }
                    : clip,
                ),
              }
            : track,
        ),
      },
    };
    const rows = getTool('get_clips')?.read?.({}, { ...ctx, project: withLook } as never) as {
      clips: { id: string; cropped: boolean; graded: boolean }[];
    };
    expect(rows.clips.find((c) => c.id === first!.id)).toMatchObject({
      cropped: true,
      graded: true,
    });
    expect(rows.clips.filter((c) => !c.cropped)).toHaveLength(rows.clips.length - 1);
  });

  it('get_clips lists compact rows, filtered by track and window, paginated', () => {
    const all = getTool('get_clips')?.read?.({}, ctx) as {
      clips: { id: string }[];
      total: number;
      hasMore: boolean;
    };
    expect(all.total).toBe(2);
    expect(all.hasMore).toBe(false);
    expect(all.clips.map((c) => c.id)).toEqual(['clip_a', 'clip_b']);
    expect(all.clips[0]).toEqual({
      id: 'clip_a',
      trackId: 'video_1',
      assetId: 'asset_1',
      start: 0,
      end: 6,
      sourceStart: 0,
      sourceEnd: 6,
      // Crop had no cheap read at all before this: "which clips still need reframing" cost
      // one deep read per clip, so it was never asked.
      cropped: false,
      graded: false,
      effectCount: 0,
      keyframeCount: 0,
    });

    const windowed = getTool('get_clips')?.read?.({ start: 7, end: 9 }, ctx) as {
      clips: { id: string }[];
    };
    expect(windowed.clips.map((c) => c.id)).toEqual(['clip_b']);

    const paged = getTool('get_clips')?.read?.({ limit: 1 }, ctx) as {
      clips: { id: string }[];
      total: number;
      hasMore: boolean;
    };
    expect(paged.clips.map((c) => c.id)).toEqual(['clip_a']);
    expect(paged.total).toBe(2);
    expect(paged.hasMore).toBe(true);

    const page2 = getTool('get_clips')?.read?.({ limit: 1, offset: 1 }, ctx) as {
      clips: { id: string }[];
      hasMore: boolean;
    };
    expect(page2.clips.map((c) => c.id)).toEqual(['clip_b']);
    expect(page2.hasMore).toBe(false);

    const empty = getTool('get_clips')?.read?.({ trackId: 'audio_1' }, ctx) as { total: number };
    expect(empty.total).toBe(0);
  });

  it('surfaces optional track flags + clip speed, and breaks start ties by trackId', () => {
    const flagged = makeProject({
      timeline: {
        tracks: [
          {
            id: 'video_1',
            type: 'video',
            muted: true,
            locked: true,
            hidden: true,
            clips: [
              {
                id: 'clip_a',
                assetId: 'asset_1',
                trackId: 'video_1',
                start: 0,
                end: 6,
                sourceStart: 0,
                sourceEnd: 6,
                speed: 2,
                effects: [],
                keyframes: [],
              },
            ],
          },
          {
            id: 'audio_1',
            type: 'audio',
            clips: [
              {
                id: 'clip_c',
                assetId: 'asset_1',
                trackId: 'audio_1',
                start: 0,
                end: 4,
                sourceStart: 0,
                sourceEnd: 4,
                effects: [],
                keyframes: [],
              },
            ],
          },
        ],
      },
    });
    const flaggedCtx: ToolContext = { project: flagged, selection: { start: 1, end: 2 } };

    const summary = getTool('get_timeline_summary')?.read?.({}, flaggedCtx) as {
      tracks: { id: string; muted?: boolean; locked?: boolean; hidden?: boolean }[];
    };
    expect(summary.tracks[0]).toMatchObject({
      id: 'video_1',
      muted: true,
      locked: true,
      hidden: true,
    });

    const clips = getTool('get_clips')?.read?.({}, flaggedCtx) as {
      clips: { id: string; speed?: number }[];
    };
    expect(clips.clips.find((c) => c.id === 'clip_a')?.speed).toBe(2);
    // clip_a and clip_c both start at 0 on different tracks — the tie breaks by trackId.
    expect(clips.clips.map((c) => c.id)).toEqual(['clip_c', 'clip_a']);
  });

  it('get_clip returns the full clip with trackId, or an error steering to get_clips', () => {
    const found = getTool('get_clip')?.read?.({ clipId: 'clip_b' }, ctx) as {
      trackId: string;
      clip: { id: string; effects: unknown[] };
    };
    expect(found.trackId).toBe('video_1');
    expect(found.clip.id).toBe('clip_b');
    expect(found.clip.effects).toEqual([]);
    expect(getTool('get_clip')?.read?.({ clipId: 'nope' }, ctx)).toEqual({
      error: 'Unknown clip "nope". Use get_clips to list real ids.',
    });
  });

  it('get_transcript windows by start/end and stays whole-transcript with no args', () => {
    expect(getTool('get_transcript')?.read?.({}, ctx)).toBe(ctx.project.transcript);
    expect(getTool('get_transcript')?.read?.({ start: 0.5 }, ctx)).toEqual([
      { word: 'world', start: 0.5, end: 1 },
    ]);
    expect(getTool('get_transcript')?.read?.({ end: 0.5 }, ctx)).toEqual([
      { word: 'hello', start: 0, end: 0.5 },
    ]);
    expect(getTool('get_transcript')?.read?.({ start: 5, end: 9 }, ctx)).toEqual([]);
  });
});

describe('precise deletes & track tools — delete_clip / delete_clips / remove_track / move_track', () => {
  it('delete_clip builds an exact-span delete_range (and ripple_delete when asked)', () => {
    expect(build('delete_clip', { clipId: 'clip_a' })).toEqual([
      { type: 'delete_range', trackId: 'video_1', start: 0, end: 6 },
    ]);
    expect(build('delete_clip', { clipId: 'clip_b', ripple: true })).toEqual([
      { type: 'ripple_delete', trackId: 'video_1', start: 6, end: 10 },
    ]);
  });

  it('delete_clip rejects an unknown clip id with a model-facing message', () => {
    expect(() => build('delete_clip', { clipId: 'ghost' })).toThrow(
      /Unknown clip "ghost".*get_clips/,
    );
  });

  it('delete_clips batches per-clip ops, deduplicates ids, and ripples back-to-front', () => {
    expect(build('delete_clips', { clipIds: ['clip_a', 'clip_a'] })).toEqual([
      { type: 'delete_range', trackId: 'video_1', start: 0, end: 6 },
    ]);
    // With ripple, the later clip must be deleted first so earlier ranges stay valid.
    expect(build('delete_clips', { clipIds: ['clip_a', 'clip_b'], ripple: true })).toEqual([
      { type: 'ripple_delete', trackId: 'video_1', start: 6, end: 10 },
      { type: 'ripple_delete', trackId: 'video_1', start: 0, end: 6 },
    ]);
  });

  it('delete_clips ops pass the patch validator (non-ripple full pair)', () => {
    const ops = build('delete_clips', { clipIds: ['clip_b'] });
    expect(validatePatch(ctx.project.timeline, { operations: ops }).valid).toBe(true);
  });

  it('remove_track and move_track map to the layer operations', () => {
    expect(build('remove_track', { trackId: 'audio_1' })).toEqual([
      { type: 'remove_layer', layerId: 'audio_1' },
    ]);
    expect(build('move_track', { trackId: 'audio_1', toIndex: 0 })).toEqual([
      { type: 'move_layer', layerId: 'audio_1', toIndex: 0 },
    ]);
  });

  it('schema gate: bad args are rejected', () => {
    expect(() => build('delete_clips', { clipIds: [] })).toThrow(ZodError);
    expect(() => build('move_track', { trackId: 't' })).toThrow(ZodError);
    expect(() => getTool('get_clips')!.parse({ limit: 0 })).toThrow(ZodError);
    expect(() => getTool('get_clips')!.parse({ limit: 500 })).toThrow(ZodError);
  });
});

describe('concurrencySafe (E1, plan/ORCHESTRATION-EFFICIENCY-CC-PATTERNS.md)', () => {
  it('accepts read and analysis kinds with valid args', () => {
    expect(concurrencySafe(getTool('get_timeline')!, {})).toBe(true);
    expect(concurrencySafe(getTool('get_selected_range')!, {})).toBe(true);
    expect(concurrencySafe(getTool('analyze_silence')!, { assetId: 'asset_1' })).toBe(true);
  });

  it('never accepts mutate, action, ask, or unavailable kinds', () => {
    expect(concurrencySafe(getTool('trim_clip')!, { clipId: 'clip_a', start: 0, end: 1 })).toBe(
      false,
    );
    expect(concurrencySafe(getTool('render_preview')!, {})).toBe(false);
    expect(concurrencySafe(getTool('ask_user')!, { question: 'Which take do you prefer?' })).toBe(
      false,
    );
    expect(concurrencySafe(getTool('detect_subjects')!, {})).toBe(false);
    expect(concurrencySafe(getTool('track_subject_automatically')!, {})).toBe(false);
  });

  it('honors the per-tool serialOnly opt-out (load_skill pins into the run ledger)', () => {
    const loadSkill = getTool('load_skill')!;
    expect(loadSkill.kind).toBe('read');
    expect(loadSkill.serialOnly).toBe(true);
    expect(concurrencySafe(loadSkill, { name: 'captions' })).toBe(false);
  });

  it('a parse failure conservatively means not safe', () => {
    expect(concurrencySafe(getTool('get_timeline')!, { bogus: true })).toBe(false);
    expect(concurrencySafe(getTool('analyze_silence')!, { assetId: 42 })).toBe(false);
  });

  it('a throwing predicate input (hostile parse) is contained, never thrown', () => {
    const hostile = {
      ...getTool('get_timeline')!,
      parse: () => {
        throw new Error('schema exploded');
      },
    };
    expect(concurrencySafe(hostile, {})).toBe(false);
  });
});

describe('map_time — the timing arithmetic every "what plays when" question defers to', () => {
  it('answers a sequenceTime query directly, ignoring the whole-map default', () => {
    const result = getTool('map_time')?.read?.({ sequenceTime: 2 }, ctx) as {
      at: unknown;
      revision: number;
    };
    expect(result.at).toBeDefined();
    expect(typeof result.revision).toBe('number');
  });

  it('returns the whole timeline map when called with no arguments', () => {
    const result = getTool('map_time')?.read?.({}, ctx) as { spans: unknown };
    expect(result.spans).toBeDefined();
  });

  it("resolves sourceTime against the project's only asset when none is named", () => {
    const result = getTool('map_time')?.read?.({ sourceTime: 1 }, ctx) as {
      hits: unknown[];
      revision: number;
    };
    expect(Array.isArray(result.hits)).toBe(true);
  });

  it('resolves sourceTime against an explicitly named asset', () => {
    const result = getTool('map_time')?.read?.({ sourceTime: 1, assetId: 'asset_1' }, ctx) as {
      hits: unknown[];
    };
    expect(Array.isArray(result.hits)).toBe(true);
  });

  it('refuses a sourceTime query on a project with no assets to default to', () => {
    const emptyCtx: ToolContext = { project: makeProject({ assets: [] }), selection: null };
    expect(() => getTool('map_time')?.read?.({ sourceTime: 1 }, emptyCtx)).toThrow(/has no assets/);
  });
});

describe('get_mapped_transcript — windowing the edited-timeline transcript', () => {
  it('returns the full mapped transcript when no window is given', () => {
    const result = getTool('get_mapped_transcript')?.read?.({}, ctx) as {
      words: unknown[];
      runs: unknown[];
    };
    expect(result.words.length).toBeGreaterThan(0);
  });

  it('windows by start only, treating the open end as +infinity', () => {
    const result = getTool('get_mapped_transcript')?.read?.({ start: 0.5 }, ctx) as {
      words: { word: string }[];
    };
    expect(result.words.map((w) => w.word)).toEqual(['world']);
  });

  it('windows by end only, treating the open start as -infinity', () => {
    const result = getTool('get_mapped_transcript')?.read?.({ end: 0.5 }, ctx) as {
      words: { word: string }[];
    };
    expect(result.words.map((w) => w.word)).toEqual(['hello']);
  });

  it('describes each run by bounds and count, never by repeating its words', () => {
    // The payload used to be exactly twice the size of the information in it, because
    // `MappedTranscript.runs[].words` repeats every object already in `words`. On a real
    // project that was 81 words in 27 KB, and a run that needed the transcript spent six
    // turns paging it back out of the evidence store one recall budget at a time.
    const result = getTool('get_mapped_transcript')?.read?.({}, ctx) as {
      words: unknown[];
      runs: Record<string, unknown>[];
    };
    expect(result.runs.length).toBeGreaterThan(0);
    for (const run of result.runs) {
      expect(run).not.toHaveProperty('words');
      expect(typeof run.start).toBe('number');
      expect(typeof run.end).toBe('number');
      expect(typeof run.wordCount).toBe('number');
    }
    // Every word is owned by exactly one run, so the counts account for all of them.
    const counted = result.runs.reduce((sum, r) => sum + Number(r.wordCount), 0);
    expect(counted).toBe(result.words.length);
  });
});

describe('toolDescriptors byte-stable ordering (E3.3)', () => {
  it('descriptors are name-sorted regardless of registry insertion order', () => {
    const names = toolDescriptors().map((t) => t.name);
    expect(names).toEqual([...names].sort());
    const mutating = toolDescriptors((t) => t.mutates).map((t) => t.name);
    expect(mutating).toEqual([...mutating].sort());
  });

  it('two calls serialize byte-identically (the prompt-cache prefix invariant)', () => {
    expect(JSON.stringify(toolDescriptors())).toBe(JSON.stringify(toolDescriptors()));
  });
});
