/**
 * The AM5.1 labelled request set, read and checked (plan/background-removal-ai/06 "AI masking").
 *
 * The set lives in `tests/fixtures/ai-masking/request-set.json`. Its labels are ground truth by
 * construction: each scene is a synthetic frame context whose detector hits are written down,
 * so which thing a request means is known exactly rather than judged by a model. This module only
 * reads that file and refuses a malformed one with the item that is wrong — a harness that
 * silently skips a bad label would report a gate on fewer items than it claims.
 */
import { readFileSync } from 'node:fs';
import { COLOUR_WORDS } from '@framepilot/ai-sdk';
import { COCO_CLASS_NAMES, type CocoClassName } from '@framepilot/capability-packs';

export type DetectorLabel = 'face' | 'person' | 'object';

/** One thing in a scene: something the detector boxes, or something it cannot (`detector: null`). */
export interface SceneThing {
  readonly id: string;
  /** What the thing actually is, by construction ("car", "sky", "not a face"). */
  readonly truth: string;
  readonly detector: DetectorLabel | null;
  /** Normalised `[x, y, width, height]` on the clip's first frame. */
  readonly box?: readonly [number, number, number, number];
  readonly confidence?: number;
  /** Movement per frame, normalised `[dx, dy]`. */
  readonly drift?: readonly [number, number];
  /** Clip-relative frames `[first, lastExclusive)` the detector sees it on; absent = every frame. */
  readonly frames?: readonly [number, number];
  /**
   * The COCO class a Subject Intelligence >= 1.1 pack reports for an `object` thing (AM2.5).
   * Required on every `object` thing, because the real pack classes every YOLOX box; a `person`
   * thing is reported as `person` without saying so here.
   */
  readonly class?: CocoClassName;
  /** Its colour, by construction, when the scene says so: what a crop re-rank would see. */
  readonly colour?: string;
}

export interface Scene {
  readonly picture: string;
  /** The project's face-recognition opt-in, as the desktop reads it per resolution. */
  readonly consent?: boolean;
  readonly things: readonly SceneThing[];
}

export const EXPECTED_OUTCOMES = [
  'target',
  'ask',
  'face_selection',
  'click',
  'refuse',
  'typed_shape',
] as const;
export type ExpectedOutcome = (typeof EXPECTED_OUTCOMES)[number];

/** How the scripted model behaves: obediently, or trying to get round a rule. */
export const MODEL_POLICIES = [
  'obedient',
  'force_pick',
  'strip_pick',
  'user_shape',
  'invent_candidate',
] as const;
export type ModelPolicy = (typeof MODEL_POLICIES)[number];

export interface TypedShape {
  readonly shape: 'rectangle' | 'ellipse';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface EvalRequest {
  readonly id: string;
  readonly category: string;
  readonly scene: string;
  /** What the editor wrote: the run's user prompt. */
  readonly request: string;
  /** The target phrase the scripted model passes to `find_mask_targets`. */
  readonly description: string;
  readonly expect: { readonly outcome: ExpectedOutcome; readonly things?: readonly string[] };
  readonly purpose: 'hide' | 'effect' | 'cutout';
  readonly effect?: string;
  readonly policy?: ModelPolicy;
  /** The shape a `user_shape` policy sends, whatever the editor typed. */
  readonly userShape?: TypedShape;
  /** The shape the editor ACTUALLY typed in this request, by construction. */
  readonly typedShape?: TypedShape;
  /** Earlier editor messages of the conversation. */
  readonly history?: readonly string[];
  /** Why a target needs more than the shipped detector: `object_class`, `appearance`. */
  readonly requires?: string;
  readonly note?: string;
}

export interface RequestSet {
  readonly labelling: string;
  readonly clip: {
    readonly fps: number;
    readonly seconds: number;
    readonly width: number;
    readonly height: number;
  };
  readonly scenes: Readonly<Record<string, Scene>>;
  readonly requests: readonly EvalRequest[];
}

function fail(where: string, what: string): never {
  throw new Error(`AI masking request set: ${where}: ${what}`);
}

const isUnit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

function checkThing(sceneId: string, thing: SceneThing): void {
  const where = `scene ${sceneId}, thing ${String(thing.id)}`;
  if (typeof thing.id !== 'string' || thing.id.length === 0) fail(where, 'needs an id');
  if (typeof thing.truth !== 'string') fail(where, 'needs a truth label');
  if (thing.colour !== undefined && !COLOUR_WORDS.includes(thing.colour)) {
    fail(where, `colour ${thing.colour} is not one the re-ranker scores`);
  }
  if (thing.class !== undefined) {
    if (thing.detector !== 'object') fail(where, 'only an object thing names its class');
    if (!(COCO_CLASS_NAMES as readonly string[]).includes(thing.class)) {
      fail(where, `class ${thing.class} is not one of the detector's COCO classes`);
    }
  }
  if (thing.detector === 'object' && thing.class === undefined) {
    fail(where, 'an object thing needs the COCO class the pack reports for it');
  }
  if (thing.detector === null) return;
  if (!['face', 'person', 'object'].includes(thing.detector)) fail(where, 'unknown detector label');
  const box = thing.box;
  if (!Array.isArray(box) || box.length !== 4 || !box.every(isUnit)) {
    fail(where, 'a detectable thing needs a normalised [x, y, width, height] box');
  }
  if (box[2] <= 0 || box[3] <= 0) fail(where, 'the box has no area');
  if (!isUnit(thing.confidence)) fail(where, 'a detectable thing needs a confidence in 0..1');
}

function checkRequest(set: RequestSet, request: EvalRequest, seen: Set<string>): void {
  const where = `request ${String(request.id)}`;
  if (seen.has(request.id)) fail(where, 'duplicate id');
  seen.add(request.id);
  const scene = set.scenes[request.scene];
  if (scene === undefined) fail(where, `unknown scene ${request.scene}`);
  if (!EXPECTED_OUTCOMES.includes(request.expect.outcome)) fail(where, 'unknown expected outcome');
  if (request.policy !== undefined && !MODEL_POLICIES.includes(request.policy)) {
    fail(where, 'unknown model policy');
  }
  if (request.expect.outcome === 'target') {
    const things = request.expect.things ?? [];
    if (things.length === 0) fail(where, 'a target item names the things it means');
    for (const id of things) {
      const thing = scene.things.find((candidate) => candidate.id === id);
      if (thing === undefined) fail(where, `names ${id}, which is not in scene ${request.scene}`);
      if (thing.detector === null) fail(where, `targets ${id}, which the detector cannot box`);
    }
  }
  if (request.policy === 'user_shape' && request.userShape === undefined) {
    fail(where, 'a user_shape policy needs the shape the model sends');
  }
  if (request.expect.outcome === 'typed_shape' && request.typedShape === undefined) {
    fail(where, 'a typed_shape item needs the shape the editor typed');
  }
}

/** Check a parsed request set; throws naming the first thing that is wrong. */
export function checkRequestSet(set: RequestSet): RequestSet {
  if (typeof set.labelling !== 'string' || set.labelling.length === 0) {
    fail('file', 'must say how its labels were made');
  }
  for (const [sceneId, scene] of Object.entries(set.scenes)) {
    for (const thing of scene.things) checkThing(sceneId, thing);
  }
  const seen = new Set<string>();
  for (const request of set.requests) checkRequest(set, request, seen);
  return set;
}

/** Read and check the request set at `path`. */
export function loadRequestSet(path: string): RequestSet {
  return checkRequestSet(JSON.parse(readFileSync(path, 'utf8')) as RequestSet);
}
