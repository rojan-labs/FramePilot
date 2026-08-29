/**
 * @framepilot/ai-sdk/references/directives — the numbers a measured reference hands to
 * the run, and the ones it cannot (plan/system-mission P3.4, P4.2).
 *
 * `profile.ts` produces two things from one analysis: `constraints`, the dozen editor-
 * vocabulary lines the MODEL reads, and the raw measurements, which it does not. This
 * module is the second half of that split — it turns the measurements into typed targets
 * the deterministic side of the run consumes without a model turn in between:
 *
 * - a **shot-length target** the Critic grades the cut against (`critic.ts`
 *   `shot_length_target`), so "make it feel like this" becomes a number the run is told it
 *   is missing while it can still act on it, rather than a vibe nobody checks;
 * - a **tempo** (BPM) and a **grade target**, carried as directives the plan must cite.
 *
 * It is equally explicit about what a reference CANNOT drive today. A logo is measured and
 * then ignored, because nothing here places an overlay from a reference file; saying so in
 * the plan is the honest answer and is what P4.2 asks the plan to state. `ignored` carries
 * that reason per reference, so the sidebar and the Critic read the same list the planner
 * was given rather than a silence.
 *
 * Pure: no I/O, no clock, no model call.
 */
import type { ReferenceProfile } from './profile.js';
import type { ReferenceRole } from './role.js';

/** A coarse look target, in the same 0..1 units the analysis measured. */
export interface ReferenceGradeTarget {
  readonly brightness?: number;
  readonly contrast?: number;
  readonly saturation?: number;
  readonly temperature?: number;
}

/** One constraint line, attributed to the reference it came from. */
export interface ReferenceCitation {
  readonly profileId: string;
  readonly line: string;
}

/** A reference that was measured and is not driving anything, and why. */
export interface IgnoredReference {
  readonly profileId: string;
  readonly role: ReferenceRole;
  readonly reason: string;
}

export interface ReferenceDirectives {
  /** Target median picture-clip length in seconds. */
  readonly medianShotSeconds?: number;
  /** The reference's own p10–p90 shot-length spread, when it was measured. */
  readonly shotLengthRangeSeconds?: readonly [number, number];
  readonly bpm?: number;
  readonly gradeTarget?: ReferenceGradeTarget;
  /** The exact constraint lines behind the targets above. */
  readonly applied: readonly ReferenceCitation[];
  readonly ignored: readonly IgnoredReference[];
}

/**
 * Why a role's measurements go nowhere yet.
 *
 * Each line names the missing capability rather than the missing intent — the measurement
 * exists in every case, and a run that says "I ignored your logo" without saying why reads
 * as a refusal. Delete an entry here the day its route lands; nothing else needs changing.
 */
const NO_ROUTE_REASON: Partial<Record<ReferenceRole, string>> = {
  'brand-logo':
    'no route places an overlay from a reference file — import the logo into the media bin and ask for it by name',
  'b-roll':
    'a reference is not a project asset — import the clip into the media bin to cut with it',
  thumbnail: 'nothing composes an opening frame from a still',
  character: 'no shot selector reads a face from a reference',
  design: 'no title layout is derived from a reference',
  'caption-style': 'the analysis does not measure captions inside a reference',
};

/** Roles whose pacing measurements are a target for THIS cut. */
const PACING_ROLES: readonly ReferenceRole[] = ['pacing', 'style'];
/** Roles whose colour measurements are a grade target. */
const GRADE_ROLES: readonly ReferenceRole[] = ['color', 'style'];

function gradeFrom(profile: ReferenceProfile): ReferenceGradeTarget | undefined {
  const color = profile.video?.color ?? profile.image?.color;
  if (!color) return undefined;
  const target: ReferenceGradeTarget = {
    ...(color.brightness === undefined ? {} : { brightness: color.brightness }),
    ...(color.contrast === undefined ? {} : { contrast: color.contrast }),
    ...(color.saturation === undefined ? {} : { saturation: color.saturation }),
    ...(color.temperature === undefined ? {} : { temperature: color.temperature }),
  };
  return Object.keys(target).length === 0 ? undefined : target;
}

/** The constraint line a target came from, so the citation is the model's own text. */
function lineMatching(profile: ReferenceProfile, prefix: string): string | undefined {
  return profile.constraints.find((line) => line.startsWith(prefix));
}

/**
 * Reduce the attached references to the targets the run acts on, and the honest remainder.
 *
 * First measurement wins per target: two pacing references are a contradiction the editor
 * has to settle, and averaging them would produce a number neither reference states.
 */
export function referenceDirectives(profiles: readonly ReferenceProfile[]): ReferenceDirectives {
  let medianShotSeconds: number | undefined;
  let shotLengthRangeSeconds: readonly [number, number] | undefined;
  let bpm: number | undefined;
  let gradeTarget: ReferenceGradeTarget | undefined;
  const applied: ReferenceCitation[] = [];
  const ignored: IgnoredReference[] = [];

  for (const profile of profiles) {
    let contributed = false;
    if (
      medianShotSeconds === undefined &&
      PACING_ROLES.includes(profile.role) &&
      profile.video !== undefined &&
      profile.video.shotCount > 1 &&
      profile.video.medianShotS !== undefined
    ) {
      medianShotSeconds = profile.video.medianShotS;
      const { shotLengthP10S: low, shotLengthP90S: high } = profile.video;
      if (low !== undefined && high !== undefined && high >= low) {
        shotLengthRangeSeconds = [low, high];
      }
      const line = lineMatching(profile, 'Pacing:');
      if (line) applied.push({ profileId: profile.id, line });
      contributed = true;
    }
    if (bpm === undefined && profile.video?.music?.bpm !== undefined) {
      bpm = profile.video.music.bpm;
      const line = lineMatching(profile, 'Music:');
      if (line) applied.push({ profileId: profile.id, line });
      contributed = true;
    }
    if (gradeTarget === undefined && GRADE_ROLES.includes(profile.role)) {
      const target = gradeFrom(profile);
      if (target) {
        gradeTarget = target;
        const line = lineMatching(profile, 'Look:');
        if (line) applied.push({ profileId: profile.id, line });
        contributed = true;
      }
    }
    if (contributed) continue;
    // Three different silences, told apart. "Nothing here can use it" is a product gap,
    // "one continuous take" is a property of the file, and "an earlier reference already
    // said it" is a contradiction the editor may want to resolve. Collapsing them into one
    // line would hide the only one of the three that is anybody's bug.
    const claimed =
      (PACING_ROLES.includes(profile.role) && medianShotSeconds !== undefined) ||
      (GRADE_ROLES.includes(profile.role) && gradeTarget !== undefined);
    ignored.push({
      profileId: profile.id,
      role: profile.role,
      reason:
        NO_ROUTE_REASON[profile.role] ??
        (profile.video !== undefined && profile.video.shotCount <= 1
          ? 'one continuous take — there is no shot-length target in it'
          : claimed
            ? 'another reference already sets every target this one could'
            : 'the analysis measured nothing this role can drive'),
    });
  }

  return {
    ...(medianShotSeconds === undefined ? {} : { medianShotSeconds }),
    ...(shotLengthRangeSeconds === undefined ? {} : { shotLengthRangeSeconds }),
    ...(bpm === undefined ? {} : { bpm }),
    ...(gradeTarget === undefined ? {} : { gradeTarget }),
    applied,
    ignored,
  };
}

/** True when the references gave the run something it can act on without a model call. */
export function hasReferenceDirectives(directives: ReferenceDirectives): boolean {
  return (
    directives.medianShotSeconds !== undefined ||
    directives.bpm !== undefined ||
    directives.gradeTarget !== undefined
  );
}

/**
 * How far a cut may sit from a reference's median shot length before it is a different
 * edit. A tenth of a second either side of "1.2s" is a frame count no editor cuts to, so
 * the band is proportional with a floor.
 */
export const SHOT_LENGTH_TOLERANCE_FRACTION = 0.4;
export const SHOT_LENGTH_TOLERANCE_FLOOR_S = 0.5;

/** The band the Critic grades a shot-length target inside. */
export function shotLengthTolerance(directives: ReferenceDirectives): number | undefined {
  const target = directives.medianShotSeconds;
  if (target === undefined) return undefined;
  const range = directives.shotLengthRangeSeconds;
  // The reference's OWN spread when it was measured: a reel whose shots run 0.6–3.0s is
  // stating its tolerance, and a tighter synthetic band would fail a cut it allows.
  const fromRange = range ? Math.max(target - range[0], range[1] - target) : 0;
  return Math.max(
    SHOT_LENGTH_TOLERANCE_FLOOR_S,
    target * SHOT_LENGTH_TOLERANCE_FRACTION,
    fromRange,
  );
}

/**
 * The line the plan block shows for the numeric targets — stated once, as numbers, so the
 * model cites them rather than re-deriving them out of the constraint prose.
 */
export function renderDirectives(directives: ReferenceDirectives): string {
  const lines: string[] = [];
  if (directives.medianShotSeconds !== undefined) {
    const range = directives.shotLengthRangeSeconds;
    lines.push(
      `- Shot length: aim for a median of ${directives.medianShotSeconds.toFixed(1)}s per picture clip` +
        (range ? ` (the reference runs ${range[0].toFixed(1)}–${range[1].toFixed(1)}s)` : '') +
        '. This is checked.',
    );
  }
  if (directives.bpm !== undefined) {
    lines.push(`- Tempo: the reference sits at about ${String(Math.round(directives.bpm))} BPM.`);
  }
  const grade = directives.gradeTarget;
  if (grade) {
    const parts = [
      grade.temperature === undefined ? '' : `temperature ${grade.temperature.toFixed(2)}`,
      grade.contrast === undefined ? '' : `contrast ${grade.contrast.toFixed(2)}`,
      grade.saturation === undefined ? '' : `saturation ${grade.saturation.toFixed(2)}`,
      grade.brightness === undefined ? '' : `brightness ${grade.brightness.toFixed(2)}`,
    ].filter(Boolean);
    if (parts.length > 0) lines.push(`- Grade target (0..1 measured): ${parts.join(', ')}.`);
  }
  return lines.join('\n');
}

/**
 * The references that were measured and are driving nothing, each with its reason.
 *
 * Rendered separately from {@link renderDirectives} so neither heading can lie: a block
 * titled "targets taken from those measurements" listing only things nobody took is how a
 * run learns its own context is decoration.
 */
export function renderIgnoredReferences(directives: ReferenceDirectives): string {
  return directives.ignored
    .map((entry) => `- NOT applied — ${entry.profileId} (${entry.role}): ${entry.reason}.`)
    .join('\n');
}

/** A committed decision a reference earns once the run has planned against it. */
export interface ReferenceDecision {
  /** The `ReferenceProfile.id` the decision is bound to. */
  readonly subject: string;
  readonly decision: string;
  readonly reconsiderIf: string;
}

/**
 * The decisions a set of attached references commits the run to (P3.5).
 *
 * One per constraint line the run is actually applying, with the measured line carried
 * VERBATIM inside the decision text. That is what makes "same as the reference" work on a
 * later turn: the decision crosses the run boundary through
 * `carryForwardWorkingState` and lands in the briefing's DECIDED section holding its own
 * numbers, so the next run applies the profile without re-reading it, re-measuring it, or
 * asking the editor what they meant. `subject` is what lets the carry-forward retire it the
 * moment the editor removes the tile.
 */
export function referenceDecisions(
  profiles: readonly ReferenceProfile[],
): readonly ReferenceDecision[] {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  return referenceDirectives(profiles).applied.map((citation) => {
    const role = byId.get(citation.profileId)?.role ?? 'style';
    return {
      subject: citation.profileId,
      decision: `Match reference ${citation.profileId} (${role}) — ${citation.line}`,
      reconsiderIf: `the editor removes reference ${citation.profileId} or asks for something different`,
    };
  });
}
