/**
 * Executable outcome evals for shapes and stickers (plan/elements EL4a, EL6a).
 *
 * Neither is an EditorCommand, so there is no controller to resolve: each case compiles with the
 * builder the Elements panel and the agent's tool share, which is exactly what the capability
 * advertises. The rendered half stages a still with alpha for the sticker, so the export draws
 * the same kind of file the library ships.
 */
import {
  applyPatch,
  buildAddShapeOps,
  buildAddStickerOps,
  invertPatch,
  isProjectOperation,
  setShapeParamsOp,
  shapeClipParams,
  stickerBaseScale,
  type Operation,
  type Patch,
} from '@framepilot/editor-core';
import { parseProject, presetShapeParams, type Project } from '@framepilot/timeline-schema';
import { captureEditorInteractionContext } from './editor-context/interaction-context.js';
import {
  outcomeIssues,
  type ProfessionalEvalCase,
  type ProfessionalEvalCompilation,
  type ProfessionalEvalFixture,
} from './professional-eval-runner.js';

const SHAPE_PRESET = 'rounded-rect/highlight';
const SHAPE_START_SECONDS = 2;
const SHAPE_END_SECONDS = 5;
const RESTYLED_FILL = '#22C55E';
const STICKER_START_SECONDS = 3;
const STICKER_END_SECONDS = 6;
/** The library pads 256 px of art into a 318 px file (see `elementArtFraction`). */
const STICKER_FILE_SIZE = 318;
const STICKER_ART_SIZE = 256;

const STICKER_ASSET = {
  id: 'element_fluent3d_fire',
  path: 'elements/fluent3d/fire.webp',
  kind: 'image',
  media: { width: STICKER_FILE_SIZE, height: STICKER_FILE_SIZE },
  source: {
    provider: 'fluent-emoji',
    remoteId: 'fire',
    license: 'mit',
    licenseUrl: 'https://github.com/microsoft/fluentui-emoji/blob/main/LICENSE',
    attributionRequired: false,
    attribution: 'Fluent Emoji by Microsoft (MIT)',
    creator: 'Microsoft',
    sourceUrl: 'https://github.com/microsoft/fluentui-emoji',
    fetchedAt: '2026-09-26T00:00:00.000Z',
  },
} as const;

function graphicsEvalProject(withSticker: boolean): Project {
  return parseProject({
    id: 'professional_graphics_eval',
    name: 'Professional graphics eval',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [
      { id: 'hero_asset', path: 'hero.mp4', kind: 'video', durationSeconds: 20 },
      ...(withSticker ? [STICKER_ASSET] : []),
    ],
    timeline: {
      revision: 2,
      tracks: [
        {
          id: 'v1',
          type: 'video',
          clips: [
            {
              id: 'hero',
              assetId: 'hero_asset',
              trackId: 'v1',
              start: 0,
              end: 10,
              sourceStart: 0,
              sourceEnd: 10,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    },
    transcript: [],
    aiMemory: {},
    history: [],
  });
}

function fixtureFor(project: Project): ProfessionalEvalFixture {
  const interaction = captureEditorInteractionContext({
    project,
    projectRevision: 7,
    playheadSeconds: SHAPE_START_SECONDS,
    selectedClipIds: [],
  });
  return { project, interaction };
}

/** A patch and its exact inverse from builder operations, as the panel and the tool commit it. */
function compiled(
  project: Project,
  reason: string,
  operations: readonly Operation[],
  resolution: readonly string[],
): ProfessionalEvalCompilation {
  const patch: Patch = {
    patchId: `graphics_eval_${reason.replace(/\W+/g, '_')}` as Patch['patchId'],
    createdBy: 'agent',
    reason,
    operations: [...operations],
  };
  return {
    status: 'compiled',
    patch,
    inversePatch: invertPatch(project.timeline, patch),
    resolution,
  };
}

function shapeParams(): Readonly<Record<string, unknown>> {
  const params = presetShapeParams(SHAPE_PRESET);
  if (params === undefined) {
    throw new Error(`The shape preset ${SHAPE_PRESET} is not in the catalogue.`);
  }
  return params;
}

function addShape(fixture: ProfessionalEvalFixture): ProfessionalEvalCompilation {
  const placed = buildAddShapeOps(
    fixture.project.timeline,
    shapeParams(),
    SHAPE_START_SECONDS,
    SHAPE_END_SECONDS,
  );
  return compiled(fixture.project, 'Add shape Highlight box', placed.operations, [
    `preset=${SHAPE_PRESET}`,
    `lane=${placed.trackId}`,
  ]);
}

/** A project that already holds the shape, so the restyle case edits an existing clip. */
function shapeStyleFixture(): ProfessionalEvalFixture {
  const project = graphicsEvalProject(false);
  const added = addShape(fixtureFor(project));
  if (added.status !== 'compiled') throw new Error('The shape to restyle could not be added.');
  return fixtureFor({ ...project, timeline: applyPatch(project.timeline, added.patch) });
}

function shapeClipOf(project: Project) {
  return project.timeline.tracks
    .flatMap((track) => track.clips)
    .find((clip) => shapeClipParams(clip) !== null);
}

function restyleShape(fixture: ProfessionalEvalFixture): ProfessionalEvalCompilation {
  const clip = shapeClipOf(fixture.project);
  if (clip === undefined) return { status: 'failed', failures: ['no shape to restyle'] };
  return compiled(
    fixture.project,
    'Restyle shape',
    [setShapeParamsOp(clip.id, { fill: RESTYLED_FILL })],
    [`clip=${clip.id}`],
  );
}

function addSticker(fixture: ProfessionalEvalFixture): ProfessionalEvalCompilation {
  const asset = fixture.project.assets.find((candidate) => candidate.id === STICKER_ASSET.id);
  if (asset === undefined) return { status: 'failed', failures: ['no sticker in the bin'] };
  const placed = buildAddStickerOps(
    fixture.project,
    asset,
    STICKER_START_SECONDS,
    STICKER_END_SECONDS,
    { artFraction: STICKER_ART_SIZE / STICKER_FILE_SIZE },
  );
  // The sticker is already in the bin (main copied it in), so placing it is timeline work alone.
  const operations = placed.operations.filter((op): op is Operation => !isProjectOperation(op));
  if (operations.length !== placed.operations.length) {
    return { status: 'failed', failures: ['placing a sticker already in the bin added it again'] };
  }
  return compiled(fixture.project, 'Add sticker Fire', operations, [
    `element=${STICKER_ASSET.id}`,
    `lane=${placed.trackId}`,
  ]);
}

function expectShapeAdded(persisted: Project): readonly string[] {
  const clip = shapeClipOf(persisted);
  const lane = persisted.timeline.tracks.find((track) => track.id === clip?.trackId);
  return outcomeIssues([
    { label: 'shape clip present', actual: clip !== undefined, expected: true },
    { label: 'shape lane type', actual: lane?.type, expected: 'overlay' },
    { label: 'shape start', actual: clip?.start, expected: SHAPE_START_SECONDS },
    { label: 'shape end', actual: clip?.end, expected: SHAPE_END_SECONDS },
    {
      label: 'shape params',
      actual: JSON.stringify(clip === undefined ? null : shapeClipParams(clip)),
      expected: JSON.stringify(shapeParams()),
    },
  ]);
}

function expectShapeRestyled(persisted: Project): readonly string[] {
  const clip = shapeClipOf(persisted);
  const params = clip === undefined ? null : shapeClipParams(clip);
  return outcomeIssues([
    { label: 'fill restyled', actual: params?.['fill'], expected: RESTYLED_FILL },
    { label: 'stroke kept', actual: params?.['stroke'], expected: shapeParams()['stroke'] },
    { label: 'box kept', actual: params?.['width'], expected: shapeParams()['width'] },
  ]);
}

function expectStickerAdded(persisted: Project): readonly string[] {
  const clip = persisted.timeline.tracks
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.assetId === STICKER_ASSET.id);
  const lane = persisted.timeline.tracks.find((track) => track.id === clip?.trackId);
  const scale = clip?.keyframes.find((k) => k.time === 0 && k.property === 'scale')?.value;
  return outcomeIssues([
    { label: 'sticker clip present', actual: clip !== undefined, expected: true },
    { label: 'sticker lane type', actual: lane?.type, expected: 'overlay' },
    { label: 'sticker start', actual: clip?.start, expected: STICKER_START_SECONDS },
    {
      label: 'sticker art at its default height',
      actual: scale,
      expected: stickerBaseScale(
        persisted.resolution,
        STICKER_ASSET.media,
        STICKER_ART_SIZE / STICKER_FILE_SIZE,
      ),
    },
  ]);
}

export const GRAPHICS_EVAL_CASES: readonly ProfessionalEvalCase[] = [
  {
    fixtureId: 'graphics.shape-add.outcome',
    capabilityId: 'graphics.shape.add',
    setup: () => fixtureFor(graphicsEvalProject(false)),
    resolveAndCompile: addShape,
    expectOutcome: expectShapeAdded,
  },
  {
    fixtureId: 'graphics.shape-style.outcome',
    capabilityId: 'graphics.shape.style',
    setup: shapeStyleFixture,
    resolveAndCompile: restyleShape,
    expectOutcome: expectShapeRestyled,
  },
  {
    fixtureId: 'graphics.sticker-add.outcome',
    capabilityId: 'graphics.sticker.add',
    setup: () => fixtureFor(graphicsEvalProject(true)),
    resolveAndCompile: addSticker,
    expectOutcome: expectStickerAdded,
  },
];
