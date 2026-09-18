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
import type { CocoClassName } from '@framepilot/capability-packs';
import { candidateIdFor, requirePick, type MaskCandidateLabel } from './candidate-id.js';
import {
  MAX_CHOSEN_CANDIDATES,
  type MaskCandidate,
  type MaskTargetStatus,
  type MaskTargetsResult,
} from './contracts.js';
import type { NormalizedBox } from './shape-fit.js';
import {
  ALL_WORDS,
  COLOUR_ALIASES,
  COLOUR_WORDS,
  EXCEPTION_PHRASES,
  FACE_WORDS,
  GENERIC_OBJECT_WORDS,
  OUT_OF_VOCABULARY_WORDS,
  PERSON_WORDS,
  ROLE_WORDS,
  SELECTOR_WORDS,
  STOP_WORDS,
  objectClassesFor,
  singularObjectWord,
} from './target-vocabulary.js';

/** One detector hit, as the worker protocol reports it. */
export interface TargetDetection {
  readonly frame: number;
  readonly label: MaskCandidateLabel;
  readonly box: NormalizedBox;
  readonly confidence: number;
  /** The detector's COCO class (Subject Intelligence >= 1.1.0); absent from older packs. */
  readonly objectClass?: CocoClassName;
  /** The detector's conditional probability for `objectClass`. */
  readonly classScore?: number;
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
  /**
   * The COCO classes an object request can mean (AM2.5), from the head noun through
   * `OBJECT_CLASS_SYNONYMS`. Present only for object requests; a candidate FILTER, never a source.
   */
  readonly objectClasses?: ReadonlySet<CocoClassName>;
  /** The head noun as written ("car"), for the re-ranker's prompts. */
  readonly noun?: string;
}

/** Boxes on neighbouring frames belong to one thing when they overlap at least this much. */
const TRACK_IOU = 0.3;
/** A thing seen on fewer than this share of the sampled frames is detector flicker. */
const MIN_PERSISTENCE = 0.15;
/** …unless only a handful of frames were sampled, where one sighting is all there can be. */
const FLICKER_FILTER_MIN_FRAMES = 6;
/** Most candidates an ask lists; the picker shows thumbnails, not a wall of them. */
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

interface Token {
  readonly word: string;
  /** Written as a possessive ("the car's", "the players'"): it modifies the noun that follows. */
  readonly possessive: boolean;
}

function tokenize(text: string): Token[] {
  return text
    .toLowerCase()
    .split(/[^a-z'’]+/u)
    .map((raw) => ({
      word: raw.replace(/[’']s$/u, '').replace(/[’']/gu, ''),
      possessive: /(?:[’']s|s[’'])$/u.test(raw),
    }))
    .filter((token) => token.word.length > 0);
}

/** Pronouns that, before another noun, say whose it is ("her hair") rather than who. */
const POSSESSIVE_PRONOUNS: ReadonlySet<string> = new Set(['her', 'his', 'their', 'its']);
/** Words that end a pronoun's phrase: "her and the dog", "her on the left" are about her. */
const PHRASE_BOUNDARIES: ReadonlySet<string> = new Set([
  'and',
  'or',
  'with',
  'on',
  'in',
  'at',
  'to',
  'from',
  'by',
  'near',
  'next',
  'beside',
  'behind',
  'except',
  'but',
]);

function classOf(word: string): TargetClass | undefined {
  if (FACE_WORDS.has(word)) return 'face';
  if (PERSON_WORDS.has(word) || ROLE_WORDS.has(word)) return 'person';
  if (objectClassesFor(word) !== undefined) return 'object';
  if (OUT_OF_VOCABULARY_WORDS.has(word)) return 'out_of_vocabulary';
  return undefined;
}

/** A colour word in its canonical spelling, or `undefined`. */
export function colourOf(word: string): string | undefined {
  const canonical = COLOUR_ALIASES[word] ?? word;
  return COLOUR_WORDS.includes(canonical) ? canonical : undefined;
}

/**
 * Whether the word at `index` only describes the next word: "the orange car" is a car, and
 * "orange" is its colour, not the fruit.
 */
function isColourAdjective(tokens: readonly Token[], index: number): boolean {
  const next = tokens[index + 1];
  return (
    colourOf(tokens[index]!.word) !== undefined &&
    next !== undefined &&
    classOf(next.word) !== undefined
  );
}

/** A plural object noun ("cars", "buses", "things") asks for every match. */
function isPluralObjectWord(word: string): boolean {
  if (GENERIC_OBJECT_WORDS.has(word)) return word.endsWith('s');
  const singular = singularObjectWord(word);
  return singular !== undefined && singular !== word;
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
 * A class word that only says WHOSE the target is: "the car's plate", "her hair". The noun it
 * modifies is the target, so a possessive can never be the head — "her hair" masking all of her
 * was a confident wrong pick in the AM5 eval.
 */
function isModifier(
  tokens: readonly Token[],
  index: number,
  classed: readonly (TargetClass | undefined)[],
): boolean {
  const token = tokens[index]!;
  if (token.possessive) return true;
  if (!POSSESSIVE_PRONOUNS.has(token.word)) return false;
  for (let next = index + 1; next < tokens.length; next += 1) {
    if (PHRASE_BOUNDARIES.has(tokens[next]!.word)) return false;
    if (classed[next] !== undefined) return true;
  }
  return false;
}

/**
 * Read a request into a class, a quantifier, a selector and whether identity is needed.
 *
 * A face wins wherever it appears ("her face", "the man's face"): it is always the head of the
 * phrase. Otherwise the FIRST class word that is not a possessive is the head ("the man holding
 * the phone" is a man; "the car's plate" is a plate). A request whose only class words are
 * possessives names something the vocabulary does not know, so it asks for a click.
 */
export function parseTargetRequest(description: string): TargetRequest {
  const tokens = tokenize(description);
  const classed = tokens.map((token, index) =>
    isColourAdjective(tokens, index) ? undefined : classOf(token.word),
  );
  const heads = classed.map((value, index) =>
    value === undefined || isModifier(tokens, index, classed) ? undefined : value,
  );
  const targetClass: TargetClass =
    classed.find((value) => value === 'face') ??
    heads.find((value) => value !== undefined) ??
    'unknown';
  const headIndex = heads.findIndex((value) => value === targetClass);
  const head = tokens[headIndex]?.word ?? '';
  const all =
    tokens.some(({ word }) => ALL_WORDS.has(word)) ||
    PLURAL_ALL.has(head) ||
    (targetClass === 'object' && isPluralObjectWord(head));
  const selector = tokens
    .map(({ word }) => SELECTOR_WORDS[word])
    .find((value) => value !== undefined);
  const lowered = description.toLowerCase();
  const identity =
    EXCEPTION_PHRASES.some((phrase) => phrase.test(lowered)) ||
    tokens.some(({ word }) => ROLE_WORDS.has(word));
  const appearance = tokens
    .filter(
      ({ word }, index) =>
        classed[index] === undefined &&
        !STOP_WORDS.has(word) &&
        !ALL_WORDS.has(word) &&
        SELECTOR_WORDS[word] === undefined &&
        !EXCEPTION_PHRASES.some((phrase) => phrase.test(word)),
    )
    .map(({ word }) => word);
  const objectClasses = targetClass === 'object' ? objectClassesFor(head) : undefined;
  return {
    targetClass,
    all,
    ...(selector === undefined ? {} : { selector }),
    identity,
    appearance,
    ...(objectClasses === undefined ? {} : { objectClasses: new Set(objectClasses), noun: head }),
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
  /**
   * SigLIP appearance score in 0..1 per candidate id, when `visual-embed` could score crops
   * (AM2.5: the share of a colour-classification the named colour gets). It RE-RANKS among
   * candidates the detector has already classed; it never vouches for a class or adds a
   * candidate, so an unclassed object still asks however high it scores.
   */
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

/**
 * The tier-1 `subjectKind` vocabulary (`workers/visual-embed` prompt bank) as detector labels.
 * `place`, `text`, `none` and anything a newer bank adds have no entry, and so no opinion.
 */
const LEDGER_LABEL: Readonly<Record<string, MaskCandidateLabel>> = {
  person: 'person',
  people: 'person',
  object: 'object',
  screen: 'object',
  animal: 'object',
  food: 'object',
  vehicle: 'object',
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
  /** Every class the detector gave this thing across its sightings; empty from an older pack. */
  readonly observedClasses: ReadonlySet<CocoClassName>;
}

/**
 * The class a track is: the one with the most class evidence (summed `classScore`) across its
 * sightings, ties broken by name so the answer is deterministic. `undefined` when no hit had one.
 */
function dominantClass(hits: readonly TargetDetection[]): CocoClassName | undefined {
  const evidence = new Map<CocoClassName, number>();
  for (const hit of hits) {
    if (hit.objectClass === undefined) continue;
    evidence.set(hit.objectClass, (evidence.get(hit.objectClass) ?? 0) + (hit.classScore ?? 0));
  }
  let best: CocoClassName | undefined;
  for (const [name, total] of [...evidence].sort(([a], [b]) => a.localeCompare(b))) {
    if (best === undefined || total > evidence.get(best)!) best = name;
  }
  return best;
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
    const objectClass = dominantClass(track.hits);
    const observedClasses = new Set(
      track.hits.flatMap((hit) => (hit.objectClass === undefined ? [] : [hit.objectClass])),
    );
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
      ...(objectClass === undefined ? {} : { objectClass }),
      grounding,
      observedClasses,
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
      ...(detection.objectClass === undefined ? {} : { objectClass: detection.objectClass }),
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

type ClassFilter =
  | {
      readonly status: 'resolved';
      readonly eligible: readonly Ranked[];
      /** True when the pack named no classes: the label alone cannot say it is a car. */
      readonly classUnverified: boolean;
    }
  | { readonly status: 'ambiguous_target' | 'no_candidates'; readonly shown: readonly Ranked[] };

/**
 * Keep only the objects whose detected class the request's noun can mean (AM2.5).
 *
 * A FILTER, never a source: it can only remove candidates. A pack that reports no classes
 * (Subject Intelligence 1.0) leaves every object in and marks the class unverified, which is the
 * pre-AM2.5 behaviour — ask. A thing the detector called a matching class on some frames and
 * something else on most is plausibly meant and not clearly meant, so the editor picks.
 */
function byObjectClass(request: TargetRequest, labelled: readonly Ranked[]): ClassFilter {
  const wanted = request.objectClasses;
  if (request.targetClass !== 'object' || wanted === undefined) {
    return { status: 'resolved', eligible: labelled, classUnverified: false };
  }
  if (labelled.some((candidate) => candidate.observedClasses.size === 0)) {
    return { status: 'resolved', eligible: labelled, classUnverified: true };
  }
  const plausible = labelled.filter((candidate) =>
    [...candidate.observedClasses].some((name) => wanted.has(name)),
  );
  if (plausible.length === 0) return { status: 'no_candidates', shown: [] };
  const confident = plausible.filter(
    (candidate) => candidate.objectClass !== undefined && wanted.has(candidate.objectClass),
  );
  if (confident.length !== plausible.length)
    return { status: 'ambiguous_target', shown: plausible };
  return { status: 'resolved', eligible: confident, classUnverified: false };
}

function decide(request: TargetRequest, ranked: readonly Ranked[], hasReranker: boolean): Decision {
  const ask = (status: MaskTargetStatus, shown: readonly Ranked[]): Decision => ({
    status,
    shown,
    chosen: [],
  });
  if (request.targetClass === 'out_of_vocabulary' || request.targetClass === 'unknown')
    return ask('needs_click', []);
  const labelled = ranked.filter((candidate) => candidate.label === request.targetClass);
  // WHO is a question only the editor (or, with consent, identity clusters they have named) can
  // answer. v1 always shows the faces; consent changes what the picker can remember, not who
  // picks. Asked BEFORE the class check: "everyone except the host" names people, and a
  // close-up where the detector boxed only faces is still a question about those faces.
  if (request.identity) {
    const faces = ranked.filter((candidate) => candidate.label === 'face');
    const people = faces.length > 0 ? faces : labelled;
    return people.length === 0 ? ask('no_candidates', []) : ask('needs_face_selection', people);
  }
  if (labelled.length === 0) return ask('no_candidates', []);
  const filtered = byObjectClass(request, labelled);
  if (filtered.status !== 'resolved') return ask(filtered.status, filtered.shown);
  const { eligible, classUnverified } = filtered;
  const grounded = (candidate: Ranked): boolean =>
    !hasReranker || candidate.grounding >= RERANK_MIN_GROUNDING;
  if (request.all) {
    if (classUnverified || request.appearance.length > 0) return ask('ambiguous_target', eligible);
    const every = eligible.filter(grounded);
    if (every.length === 0) return ask('no_candidates', []);
    // "All" is a promise. At the detector's per-frame cap the crowd may be bigger than what was
    // seen, and some faces would silently stay unmasked, so the editor decides.
    if (every.length >= MAX_CHOSEN_CANDIDATES) return ask('ambiguous_target', eligible);
    return { status: 'resolved', shown: eligible, chosen: every };
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
  const { grounding: _grounding, observedClasses: _observed, ...rest } = candidate;
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
  // A resolution lists everything it chose, so the host has every box it will be asked for —
  // "blur all the faces" in a crowd of 20 used to choose only the first 12 (AM5 eval).
  const shown = decision.shown
    .slice(0, Math.max(MAX_CANDIDATES, decision.chosen.length))
    .map(strip);
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
    chosenCandidateIds: decision.chosen.map((candidate) => candidate.candidateId),
    reranker: hasReranker ? 'siglip' : 'none',
    engine: input.engine,
  };
}
