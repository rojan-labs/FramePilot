/**
 * Resolve the target of a mask request, or say the editor has to (AM2.1; plan 11 rule 2).
 *
 * Pure: detections, the frames they were looked for on, and whatever optional evidence the host
 * could gather go in; a ranked candidate list and ONE of five statuses comes out. The host
 * executor does the measuring (`apps/desktop/electron/ai/masking-executor.ts`); everything that
 * decides lives here, where it can be tested against the gates in plan 06:
 *
 * - unambiguous requests pick the labelled target (≥ 99%),
 * - ambiguous ones ASK (≥ 97%) — and a confident wrong pick counts as a failure, not an ask,
 *   so every tie, every unverifiable class and every identity question resolves to asking.
 *
 * The score is the plan's product: grounding × agreement × persistence. It RANKS; it never
 * decides on its own. A decision needs a margin, a geometric selector that one candidate wins
 * clearly, or a single candidate of a class the detector can actually vouch for.
 */
import { candidateIdFor, requirePick, type MaskCandidateLabel } from './candidate-id.js';
import type { MaskCandidate, MaskTargetStatus, MaskTargetsResult } from './contracts.js';
import type { NormalizedBox } from './shape-fit.js';
import {
  ALL_WORDS,
  EXCEPTION_PHRASES,
  FACE_WORDS,
  OBJECT_WORDS,
  OUT_OF_VOCABULARY_WORDS,
  PERSON_WORDS,
  ROLE_WORDS,
  SELECTOR_WORDS,
  STOP_WORDS,
} from './target-vocabulary.js';

/** One detector hit, as the worker protocol reports it. */
export interface TargetDetection {
  readonly frame: number;
  readonly label: MaskCandidateLabel;
  readonly box: NormalizedBox;
  readonly confidence: number;
}

export type TargetClass = MaskCandidateLabel | 'out_of_vocabulary' | 'unknown';
export type TargetSelector = (typeof SELECTOR_WORDS)[string];

/** What the editor's words ask for. */
export interface TargetRequest {
  readonly targetClass: TargetClass;
  /** Every match rather than one ("everyone's faces"). */
  readonly all: boolean;
  readonly selector?: TargetSelector;
  /** WHO matters ("everyone except the host"): only identity can answer it. */
  readonly identity: boolean;
  /** Descriptive words the geometry cannot check ("red", "tall") — appearance needs a re-ranker. */
  readonly appearance: readonly string[];
}

/** Boxes on neighbouring frames belong to one thing when they overlap at least this much. */
const TRACK_IOU = 0.3;
/** A thing seen on fewer than this share of the sampled frames is detector flicker. */
const MIN_PERSISTENCE = 0.15;
/** …unless only a handful of frames were sampled, where one sighting is all there can be. */
const FLICKER_FILTER_MIN_FRAMES = 6;
/** Most candidates one result lists; the picker shows thumbnails, not a wall of them. */
const MAX_CANDIDATES = 12;
/** A positional selector wins when the winner's centre leads by this share of the frame. */
const POSITION_MARGIN = 0.1;
/** A size selector wins when the winner's area is this many times the runner-up's. */
const AREA_MARGIN_RATIO = 1.5;
/** A re-ranked winner must beat the runner-up's grounding by this ratio… */
const RERANK_MARGIN_RATIO = 1.25;
/** …and be a plausible match in absolute terms, or "best of a bad lot" would be chosen. */
const RERANK_MIN_GROUNDING = 0.5;
/** Ledger disagreement demotes a candidate without removing it: tier-1 labels are themselves estimates. */
const LEDGER_DISAGREEMENT = 0.85;

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[’']s\b/gu, '')
    .split(/[^a-z]+/u)
    .filter((word) => word.length > 0);

function classOf(word: string): TargetClass | undefined {
  if (FACE_WORDS.has(word)) return 'face';
  if (PERSON_WORDS.has(word) || ROLE_WORDS.has(word)) return 'person';
  if (OBJECT_WORDS.has(word)) return 'object';
  if (OUT_OF_VOCABULARY_WORDS.has(word)) return 'out_of_vocabulary';
  return undefined;
}

/** Plural nouns ask for every match: "faces", "cars", "people". */
const PLURAL_ALL: ReadonlySet<string> = new Set([
  'faces',
  'heads',
  'people',
  'persons',
  'men',
  'women',
  'kids',
  'children',
]);

/**
 * Read a request into a class, a quantifier, a selector and whether identity is needed.
 *
 * A face wins wherever it appears ("her face", "the man's face"): it is always the head of the
 * phrase. Otherwise the FIRST class word is the head ("the man holding the phone" is a man).
 */
export function parseTargetRequest(description: string): TargetRequest {
  const tokens = words(description);
  const classed = tokens.map(classOf);
  const targetClass: TargetClass =
    classed.find((value) => value === 'face') ??
    classed.find((value) => value !== undefined) ??
    'unknown';
  const headIndex = classed.findIndex((value) => value === targetClass);
  const head = tokens[headIndex] ?? '';
  const all =
    tokens.some((word) => ALL_WORDS.has(word)) ||
    PLURAL_ALL.has(head) ||
    (targetClass === 'object' && head.endsWith('s') && OBJECT_WORDS.has(head.slice(0, -1)));
  const selector = tokens.map((word) => SELECTOR_WORDS[word]).find((value) => value !== undefined);
  const lowered = description.toLowerCase();
  const identity =
    EXCEPTION_PHRASES.some((phrase) => phrase.test(lowered)) ||
    tokens.some((word) => ROLE_WORDS.has(word));
  const appearance = tokens.filter(
    (word) =>
      classOf(word) === undefined &&
      !STOP_WORDS.has(word) &&
      !ALL_WORDS.has(word) &&
      SELECTOR_WORDS[word] === undefined &&
      !EXCEPTION_PHRASES.some((phrase) => phrase.test(word)),
  );
  return {
    targetClass,
    all,
    ...(selector === undefined ? {} : { selector }),
    identity,
    appearance,
  };
}

function iou(a: NormalizedBox, b: NormalizedBox): number {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const overlap = Math.max(0, right - x) * Math.max(0, bottom - y);
  const union = a.width * a.height + b.width * b.height - overlap;
  return union <= 0 ? 0 : overlap / union;
}

interface Sighting {
  readonly label: MaskCandidateLabel;
  readonly hits: TargetDetection[];
}

/** Group detections into things that persist: greedy IoU association in frame order. */
function sightings(detections: readonly TargetDetection[]): Sighting[] {
  const ordered = [...detections].sort(
    (a, b) =>
      a.frame - b.frame || b.confidence - a.confidence || a.box.x - b.box.x || a.box.y - b.box.y,
  );
  const tracks: Sighting[] = [];
  for (const detection of ordered) {
    let best: Sighting | undefined;
    let bestOverlap = TRACK_IOU;
    for (const track of tracks) {
      const last = track.hits[track.hits.length - 1]!;
      // One thing is on one frame once: a second hit on the same frame is a second thing.
      if (track.label !== detection.label || last.frame === detection.frame) continue;
      const overlap = iou(last.box, detection.box);
      if (overlap >= bestOverlap) {
        best = track;
        bestOverlap = overlap;
      }
    }
    if (best === undefined) tracks.push({ label: detection.label, hits: [detection] });
    else best.hits.push(detection);
  }
  return tracks;
}

/** Optional evidence the host gathered. Every field is optional: absent means "not measured". */
export interface MaskTargetEvidence {
  /** SigLIP text-image similarity in 0..1 per candidate id, when `visual-embed` could score crops. */
  readonly rerank?: ReadonlyMap<string, number>;
  /** The shot ledger's subject kind for the clip ("person", "product", …), when indexed. */
  readonly ledgerSubjectKind?: string;
  /** Identity cluster per candidate id. Present ONLY with face-recognition consent. */
  readonly identities?: ReadonlyMap<string, string>;
}

export interface ResolveTargetsInput {
  readonly clipId: string;
  readonly assetId: string;
  readonly description: string;
  readonly fps: number;
  /** Every frame the detector looked at, hits or not — the denominator of persistence. */
  readonly sampledFrames: readonly number[];
  readonly detections: readonly TargetDetection[];
  readonly evidence?: MaskTargetEvidence;
  readonly engine: string;
}

const LEDGER_LABEL: Readonly<Record<string, MaskCandidateLabel>> = {
  person: 'person',
  people: 'person',
  face: 'face',
  product: 'object',
  object: 'object',
};

function agreement(label: MaskCandidateLabel, ledgerSubjectKind: string | undefined): number {
  if (ledgerSubjectKind === undefined) return 1;
  const expected = LEDGER_LABEL[ledgerSubjectKind.toLowerCase()];
  if (expected === undefined) return 1;
  // A face belongs to a person: a "person" shot agrees with both.
  if (expected === 'person' && label === 'face') return 1;
  return expected === label ? 1 : LEDGER_DISAGREEMENT;
}

interface Ranked extends MaskCandidate {
  readonly grounding: number;
}

/** Every persistent thing on the sampled frames, as a candidate, best score first. */
export function rankCandidates(input: ResolveTargetsInput): Ranked[] {
  const sampled = Math.max(1, new Set(input.sampledFrames).size);
  const ranked: Ranked[] = [];
  for (const track of sightings(input.detections)) {
    const persistence = Math.min(1, track.hits.length / sampled);
    if (sampled >= FLICKER_FILTER_MIN_FRAMES && persistence < MIN_PERSISTENCE) continue;
    const best = track.hits.reduce((winner, hit) =>
      hit.confidence > winner.confidence ? hit : winner,
    );
    const candidateId = candidateIdFor({
      assetId: input.assetId,
      frame: best.frame,
      label: track.label,
      box: best.box,
    });
    const confidence = track.hits.reduce((sum, hit) => sum + hit.confidence, 0) / track.hits.length;
    const grounding = input.evidence?.rerank?.get(candidateId) ?? confidence;
    const identity = input.evidence?.identities?.get(candidateId);
    ranked.push({
      candidateId,
      label: track.label,
      score: Math.min(
        1,
        Math.max(
          0,
          grounding * agreement(track.label, input.evidence?.ledgerSubjectKind) * persistence,
        ),
      ),
      box: best.box,
      sourceTime: best.frame / input.fps,
      persistence,
      ...(identity === undefined ? {} : { identity }),
      grounding,
    });
  }
  return ranked.sort((a, b) => b.score - a.score || a.candidateId.localeCompare(b.candidateId));
}

/** The candidates on ONE frame, for resolving a recalled id by re-detecting that frame. */
export function candidatesOnFrame(
  input: Pick<ResolveTargetsInput, 'assetId' | 'fps' | 'detections'>,
  frame: number,
): MaskCandidate[] {
  return input.detections
    .filter((detection) => detection.frame === frame)
    .map((detection) => ({
      candidateId: candidateIdFor({
        assetId: input.assetId,
        frame,
        label: detection.label,
        box: detection.box,
      }),
      label: detection.label,
      score: detection.confidence,
      box: detection.box,
      sourceTime: frame / input.fps,
      persistence: 1,
    }));
}

const centreX = (candidate: MaskCandidate): number => candidate.box.x + candidate.box.width / 2;
const centreY = (candidate: MaskCandidate): number => candidate.box.y + candidate.box.height / 2;
const area = (candidate: MaskCandidate): number => candidate.box.width * candidate.box.height;

/** The candidate a geometric selector names — only when it wins clearly. */
function selected(candidates: readonly Ranked[], selector: TargetSelector): Ranked | undefined {
  const metric = (candidate: Ranked): number => {
    switch (selector) {
      case 'left':
        return -centreX(candidate);
      case 'right':
        return centreX(candidate);
      case 'top':
        return -centreY(candidate);
      case 'bottom':
        return centreY(candidate);
      case 'center':
        return -Math.hypot(centreX(candidate) - 0.5, centreY(candidate) - 0.5);
      case 'largest':
        return area(candidate);
      default:
        return -area(candidate);
    }
  };
  const ordered = [...candidates].sort((a, b) => metric(b) - metric(a));
  const [winner, runnerUp] = ordered;
  if (winner === undefined) return undefined;
  if (runnerUp === undefined) return winner;
  if (selector === 'largest' || selector === 'smallest') {
    const [big, small] =
      selector === 'largest' ? [area(winner), area(runnerUp)] : [area(runnerUp), area(winner)];
    return big >= small * AREA_MARGIN_RATIO ? winner : undefined;
  }
  return metric(winner) - metric(runnerUp) >= POSITION_MARGIN ? winner : undefined;
}

interface Decision {
  readonly status: MaskTargetStatus;
  readonly shown: readonly Ranked[];
  readonly chosen: readonly Ranked[];
}

function decide(request: TargetRequest, ranked: readonly Ranked[], hasReranker: boolean): Decision {
  const ask = (status: MaskTargetStatus, shown: readonly Ranked[]): Decision => ({
    status,
    shown,
    chosen: [],
  });
  if (request.targetClass === 'out_of_vocabulary' || request.targetClass === 'unknown')
    return ask('needs_click', []);
  const eligible = ranked.filter((candidate) => candidate.label === request.targetClass);
  // WHO is a question only the editor (or, with consent, identity clusters they have named) can
  // answer. v1 always shows the faces; consent changes what the picker can remember, not who
  // picks. Asked BEFORE the class check: "everyone except the host" names people, and a
  // close-up where the detector boxed only faces is still a question about those faces.
  if (request.identity) {
    const faces = ranked.filter((candidate) => candidate.label === 'face');
    const people = faces.length > 0 ? faces : eligible;
    return people.length === 0 ? ask('no_candidates', []) : ask('needs_face_selection', people);
  }
  if (eligible.length === 0) return ask('no_candidates', []);
  // The detector reports every non-person class as `object`, so the class of an object is
  // unverified unless a re-ranker scored the crop against the editor's words.
  const classUnverified = request.targetClass === 'object' && !hasReranker;
  const grounded = (candidate: Ranked): boolean =>
    !hasReranker || candidate.grounding >= RERANK_MIN_GROUNDING;
  if (request.all) {
    if (classUnverified || request.appearance.length > 0) return ask('ambiguous_target', eligible);
    const every = eligible.filter(grounded);
    return every.length === 0
      ? ask('no_candidates', [])
      : { status: 'resolved', shown: eligible, chosen: every };
  }
  if (classUnverified) return ask('ambiguous_target', eligible);
  if (request.selector !== undefined) {
    const winner = selected(eligible.filter(grounded), request.selector);
    return winner === undefined
      ? ask('ambiguous_target', eligible)
      : { status: 'resolved', shown: eligible, chosen: [winner] };
  }
  const [first, second] = eligible;
  if (second === undefined) {
    // One of its class — but "the man in the red coat" with one man on screen is still that man
    // only if nothing contradicts it, and without a re-ranker nothing can. A class match with
    // no rival is the detector vouching for what it CAN vouch for, which is the class.
    return grounded(first!)
      ? { status: 'resolved', shown: eligible, chosen: [first!] }
      : ask('ambiguous_target', eligible);
  }
  if (!hasReranker || request.appearance.length === 0) return ask('ambiguous_target', eligible);
  const decisive =
    first!.grounding >= RERANK_MIN_GROUNDING &&
    first!.grounding >= second.grounding * RERANK_MARGIN_RATIO;
  return decisive
    ? { status: 'resolved', shown: eligible, chosen: [first!] }
    : ask('ambiguous_target', eligible);
}

const strip = (candidate: Ranked): MaskCandidate => {
  const { grounding: _grounding, ...rest } = candidate;
  return rest;
};

/**
 * Rank the candidates and decide: resolved, or one of the four ways of asking.
 *
 * Candidates the editor has to choose between carry pick-required ids, which `create_mask`
 * accepts only from the editor's own message — so an ask cannot be bypassed by the model.
 */
export function resolveMaskTargets(input: ResolveTargetsInput): MaskTargetsResult {
  const request = parseTargetRequest(input.description);
  const hasReranker = input.evidence?.rerank !== undefined;
  const decision = decide(request, rankCandidates(input), hasReranker);
  const asking = decision.status !== 'resolved';
  const shown = decision.shown.slice(0, MAX_CANDIDATES).map(strip);
  const chosenIds = new Set(decision.chosen.map((candidate) => candidate.candidateId));
  return {
    kind: 'mask_targets',
    clipId: input.clipId,
    description: input.description,
    status: decision.status,
    // Only a CHOSEN candidate keeps a plain id. Everything else the result lists — every
    // candidate of an ask, and the runners-up of a resolution — needs the editor's pick, so the
    // model cannot mask the person on the right after the resolver chose the one on the left.
    candidates: shown.map((candidate) =>
      !asking && chosenIds.has(candidate.candidateId)
        ? candidate
        : { ...candidate, candidateId: requirePick(candidate.candidateId) },
    ),
    chosenCandidateIds: decision.chosen
      .slice(0, MAX_CANDIDATES)
      .map((candidate) => candidate.candidateId),
    reranker: hasReranker ? 'siglip' : 'none',
    engine: input.engine,
  };
}
