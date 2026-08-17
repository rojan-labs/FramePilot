/**
 * Agent-outcome layer for the professional eval system (FramePilot 9.5 Phase 0).
 *
 * The capability evals answer whether one advertised editor capability resolves,
 * compiles, validates, applies, inverts, persists and renders correctly. These scenarios
 * sit above that same release machinery and ask whether a natural-language agent run
 * chooses and combines those capabilities into the intended editorial outcome.
 *
 * This file is deliberately a manifest, not another runtime. Representative rows point
 * at the existing professional-eval or shipping agent-runtime paths. Later phases can
 * increase executable coverage without inventing a second evaluation framework.
 */
import { z } from 'zod/v4';
import { PROFESSIONAL_EVAL_MANIFEST } from './professional-evals.js';

export const AGENT_OUTCOME_EVAL_TIERS = ['A', 'B', 'C', 'D', 'E'] as const;
export type AgentOutcomeEvalTier = (typeof AGENT_OUTCOME_EVAL_TIERS)[number];

export const AGENT_OUTCOME_GRADING_ORDER = [
  'hard_constraints',
  'timeline_invariants',
  'semantic_outcome',
  'deterministic_validation',
  'render_media_validation',
  'human_editorial_residue',
] as const;
export type AgentOutcomeGradingStage = (typeof AGENT_OUTCOME_GRADING_ORDER)[number];

export const AgentOutcomeEvalScenarioSchema = z
  .object({
    id: z.string().min(1),
    tier: z.enum(AGENT_OUTCOME_EVAL_TIERS),
    task: z.string().min(1),
    projectState: z.string().min(1),
    expectedFinalStatePredicates: z.array(z.string().min(1)).min(1),
    expectedHardConstraints: z.array(z.string().min(1)).min(1),
    inspectionExpected: z.boolean(),
    reviewExpected: z.boolean(),
    maxToleratedRevisionCount: z.number().int().nonnegative(),
    executionCoverage: z.enum(['contract', 'professional_eval', 'agent_runtime']),
    linkedFixtureId: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((row, context) => {
    if (row.executionCoverage !== 'contract' && row.linkedFixtureId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['linkedFixtureId'],
        message: 'Executable benchmark rows must name the existing fixture/path they exercise.',
      });
    }
  });

export type AgentOutcomeEvalScenario = z.infer<typeof AgentOutcomeEvalScenarioSchema>;

function scenario(input: AgentOutcomeEvalScenario): AgentOutcomeEvalScenario {
  return AgentOutcomeEvalScenarioSchema.parse(input);
}

const common = {
  inspectionExpected: true,
  reviewExpected: true,
} as const;

/**
 * Canonical Phase-0 benchmark set. Fifty rows are intentional: large enough to stop one
 * happy-path demo from driving architecture decisions, small enough to remain reviewable.
 */
export const AGENT_OUTCOME_EVAL_SCENARIOS = [
  // Tier A. Deterministic editing mechanics.
  scenario({ id: 'A01-trim', tier: 'A', task: 'Trim the selected clip to remove the first two seconds.', projectState: 'One selected unlocked video clip with valid source handles.', expectedFinalStatePredicates: ['Selected clip starts two seconds later without changing unrelated clips.'], expectedHardConstraints: ['Preserve source media.', 'Keep clip duration positive.', 'Produce a reversible typed edit.'], ...common, reviewExpected: false, maxToleratedRevisionCount: 1, executionCoverage: 'agent_runtime', linkedFixtureId: 'foundation-agent-trim' }),
  scenario({ id: 'A02-ripple-trim', tier: 'A', task: 'Ripple trim the selected clip tail by one second.', projectState: 'Selected unlocked clip followed by downstream clips on the same sequence.', expectedFinalStatePredicates: ['Clip tail is one second shorter.', 'Downstream material closes the created gap.'], expectedHardConstraints: ['Preserve linked sync.', 'Do not create overlap.', 'Remain undoable.'], ...common, reviewExpected: false, maxToleratedRevisionCount: 1, executionCoverage: 'professional_eval', linkedFixtureId: 'timeline.ripple-trim.outcome' }),
  scenario({ id: 'A03-roll', tier: 'A', task: 'Move the edit point between the two selected adjacent clips later by eight frames.', projectState: 'Two adjacent unlocked clips with sufficient source handles.', expectedFinalStatePredicates: ['Shared edit point moves eight frames while sequence duration stays constant.'], expectedHardConstraints: ['No gap or overlap.', 'Respect source handles.', 'Remain reversible.'], ...common, reviewExpected: false, maxToleratedRevisionCount: 1, executionCoverage: 'professional_eval', linkedFixtureId: 'timeline.roll.outcome' }),
  scenario({ id: 'A04-slip', tier: 'A', task: 'Slip the selected clip content forward by ten frames.', projectState: 'Selected clip with sufficient head and tail source handles.', expectedFinalStatePredicates: ['Timeline in/out stay fixed while source in/out move ten frames.'], expectedHardConstraints: ['Sequence duration unchanged.', 'Respect media bounds.', 'Remain reversible.'], ...common, reviewExpected: false, maxToleratedRevisionCount: 1, executionCoverage: 'professional_eval', linkedFixtureId: 'timeline.slip.outcome' }),
  scenario({ id: 'A05-slide', tier: 'A', task: 'Slide the selected clip later by six frames.', projectState: 'Three adjacent unlocked clips with handles around the selected middle clip.', expectedFinalStatePredicates: ['Selected clip moves six frames and neighboring edit points compensate.'], expectedHardConstraints: ['Sequence duration unchanged.', 'No gaps or overlaps.', 'Respect handles.'], ...common, reviewExpected: false, maxToleratedRevisionCount: 1, executionCoverage: 'professional_eval', linkedFixtureId: 'timeline.slide.outcome' }),
  scenario({ id: 'A06-split', tier: 'A', task: 'Split the selected clip at the playhead.', projectState: 'Playhead lies strictly inside one unlocked selected clip.', expectedFinalStatePredicates: ['Two contiguous clips replace the original at the playhead boundary.'], expectedHardConstraints: ['Preserve source continuity.', 'Do not duplicate or lose frames.', 'Remain undoable.'], ...common, reviewExpected: false, maxToleratedRevisionCount: 1, executionCoverage: 'contract' }),
  scenario({ id: 'A07-insert', tier: 'A', task: 'Insert the chosen source range at the playhead.', projectState: 'Chosen source range and unlocked target track at the playhead.', expectedFinalStatePredicates: ['Inserted material begins at the playhead.', 'Existing downstream material shifts by the inserted duration.'], expectedHardConstraints: ['No destructive overwrite.', 'Preserve linked sync.', 'Respect track locks.'], ...common, reviewExpected: false, maxToleratedRevisionCount: 1, executionCoverage: 'professional_eval', linkedFixtureId: 'timeline.insert.outcome' }),
  scenario({ id: 'A08-overwrite', tier: 'A', task: 'Overwrite the target range with the chosen source range.', projectState: 'Chosen source range and unlocked target track with existing material.', expectedFinalStatePredicates: ['Chosen source occupies the target interval without changing total sequence duration.'], expectedHardConstraints: ['Only target interval is replaced.', 'Respect media bounds.', 'Remain reversible.'], ...common, reviewExpected: false, maxToleratedRevisionCount: 1, executionCoverage: 'professional_eval', linkedFixtureId: 'timeline.overwrite.outcome' }),
  scenario({ id: 'A09-lift', tier: 'A', task: 'Lift the selected range and leave its timing gap.', projectState: 'Unlocked selected timeline range containing editable media.', expectedFinalStatePredicates: ['Selected material is removed while downstream timing remains unchanged.'], expectedHardConstraints: ['Leave an intentional gap.', 'Do not shift unrelated tracks.', 'Remain undoable.'], ...common, reviewExpected: false, maxToleratedRevisionCount: 1, executionCoverage: 'professional_eval', linkedFixtureId: 'timeline.lift.outcome' }),
  scenario({ id: 'A10-replace', tier: 'A', task: 'Replace the selected clip with the chosen source while preserving its timeline duration.', projectState: 'Selected timeline clip and replacement source with sufficient duration.', expectedFinalStatePredicates: ['Replacement source occupies the original clip interval.'], expectedHardConstraints: ['Preserve timeline duration.', 'Respect source bounds.', 'Remain reversible.'], ...common, reviewExpected: false, maxToleratedRevisionCount: 1, executionCoverage: 'professional_eval', linkedFixtureId: 'timeline.replace.outcome' }),

  // Tier B. Simple AI edits.
  scenario({ id: 'B01-remove-silence', tier: 'B', task: 'Remove awkward silences from this talking-head section without making speech feel rushed.', projectState: 'Talking-head clip with transcript/audio evidence and several pauses of mixed length.', expectedFinalStatePredicates: ['Long awkward pauses are shortened or removed.', 'Natural conversational pauses remain.'], expectedHardConstraints: ['Never cut spoken words.', 'Keep A/V sync.', 'No sub-frame timing.'], ...common, maxToleratedRevisionCount: 2, executionCoverage: 'contract' }),
  scenario({ id: 'B02-accurate-captions', tier: 'B', task: 'Add accurate captions for the spoken section.', projectState: 'Speech audio with transcript evidence and no existing generated caption layer.', expectedFinalStatePredicates: ['Caption text and timing follow the transcript through the requested range.'], expectedHardConstraints: ['No duplicate caption IDs.', 'No captions outside the requested range.', 'Preserve existing manual overlays.'], ...common, maxToleratedRevisionCount: 2, executionCoverage: 'contract' }),
  scenario({ id: 'B03-caption-emphasis', tier: 'B', task: 'Emphasize the important words in the captions, but keep it restrained.', projectState: 'Existing timed captions with transcript/token evidence.', expectedFinalStatePredicates: ['Semantically important words receive emphasis.', 'Most words retain the base style.'], expectedHardConstraints: ['Do not alter caption wording.', 'Do not create unreadable timing.', 'Respect existing caption ownership.'], ...common, maxToleratedRevisionCount: 2, executionCoverage: 'contract' }),
  scenario({ id: 'B04-tighten-intro', tier: 'B', task: 'Tighten the first twenty seconds and get to the point faster.', projectState: 'Screen-recorded SaaS demo with speech, transcript and several pauses/repetitions in the opening.', expectedFinalStatePredicates: ['Opening reaches the first substantive product point sooner.', 'Required setup remains understandable.'], expectedHardConstraints: ['Preserve semantic continuity.', 'Never remove required UI action context.', 'Keep dialogue intelligible.'], ...common, maxToleratedRevisionCount: 3, executionCoverage: 'contract' }),
  scenario({ id: 'B05-restrained-punch-ins', tier: 'B', task: 'Add restrained punch-ins on the most important talking points.', projectState: 'Talking-head footage with transcript and face-safe framing.', expectedFinalStatePredicates: ['Punch-ins align with a small number of meaningful beats.', 'Base framing returns between emphasis moments.'], expectedHardConstraints: ['Keep subject inside frame.', 'Avoid rapid scale oscillation.', 'Preserve existing creative motion.'], ...common, maxToleratedRevisionCount: 2, executionCoverage: 'contract' }),
  scenario({ id: 'B06-dialogue-ducking', tier: 'B', task: 'Normalize the dialogue and duck the music under speech.', projectState: 'Dialogue and music clips on separate audible tracks with measured audio evidence.', expectedFinalStatePredicates: ['Dialogue reaches a consistent level.', 'Music attenuates under speech and recovers outside speech.'], expectedHardConstraints: ['No clipping.', 'Do not mute music completely unless required.', 'Preserve intentional fades.'], ...common, maxToleratedRevisionCount: 2, executionCoverage: 'contract' }),
  scenario({ id: 'B07-vertical-version', tier: 'B', task: 'Create a 9:16 version of this selected section for Reels.', projectState: '16:9 source sequence with subject-aware framing evidence.', expectedFinalStatePredicates: ['Output framing is 9:16.', 'Primary subject/action remains visible across the section.'], expectedHardConstraints: ['Do not stretch pixels.', 'Do not crop required UI labels when avoidable.', 'Keep timeline edits non-destructive.'], ...common, maxToleratedRevisionCount: 3, executionCoverage: 'contract' }),
  scenario({ id: 'B08-filler-cleanup', tier: 'B', task: 'Remove filler words where the cut will sound natural.', projectState: 'Talking-head transcript with filler-word timestamps and continuous room tone.', expectedFinalStatePredicates: ['Removable filler instances are cut or tightened.', 'Speech cadence remains natural.'], expectedHardConstraints: ['Never cut lexical content adjacent to filler.', 'Avoid click-producing audio boundaries.', 'Keep A/V sync.'], ...common, maxToleratedRevisionCount: 3, executionCoverage: 'contract' }),
  scenario({ id: 'B09-lower-third', tier: 'B', task: 'Add a clean lower third when the speaker is first introduced.', projectState: 'Talking-head segment with transcript identifying the speaker and safe-title area.', expectedFinalStatePredicates: ['One lower third appears at the first introduction and clears after a readable duration.'], expectedHardConstraints: ['Use confirmed speaker text only.', 'Stay inside safe area.', 'Do not cover existing captions.'], ...common, maxToleratedRevisionCount: 2, executionCoverage: 'contract' }),
  scenario({ id: 'B10-simple-transition', tier: 'B', task: 'Add a subtle transition between these two scene changes.', projectState: 'Two adjacent clips with available handles and no existing transition at the edit.', expectedFinalStatePredicates: ['One restrained transition bridges the intended cut.'], expectedHardConstraints: ['Respect available handles.', 'Do not change unrelated edits.', 'No duplicate transition.'], ...common, maxToleratedRevisionCount: 2, executionCoverage: 'contract' }),

  // Tier C. Semantic editing.
  scenario({ id: 'C01-strongest-hook', tier: 'C', task: 'Find the strongest hook and move it to the beginning.', projectState: 'Several spoken claims distributed across a five-minute product demo with transcript evidence.', expectedFinalStatePredicates: ['Opening starts with a high-information hook grounded in source speech.', 'The remaining story still makes sense.'], expectedHardConstraints: ['Do not fabricate dialogue.', 'Preserve required causal context.', 'No duplicate hook segment.'], ...common, maxToleratedRevisionCount: 4, executionCoverage: 'contract' }),
  scenario({ id: 'C02-shorten-pricing', tier: 'C', task: 'Shorten the pricing explanation without losing the important information.', projectState: 'Pricing section containing repeated setup plus plan names, price and billing qualifiers.', expectedFinalStatePredicates: ['Plan/price/qualifier information remains.', 'Repeated explanation is reduced.'], expectedHardConstraints: ['Do not change quoted prices.', 'Do not remove material qualification.', 'Keep sentence continuity.'], ...common, maxToleratedRevisionCount: 3, executionCoverage: 'contract' }),
  scenario({ id: 'C03-analytics-broll', tier: 'C', task: 'Add relevant B-roll when analytics are discussed.', projectState: 'Talking-head track plus indexed screen-recording assets showing analytics UI.', expectedFinalStatePredicates: ['Relevant analytics visual covers the matching spoken moment.', 'B-roll timing supports rather than obscures the explanation.'], expectedHardConstraints: ['Use existing indexed media only.', 'Do not hide required on-screen captions.', 'Keep narration audio continuous.'], ...common, maxToleratedRevisionCount: 3, executionCoverage: 'contract' }),
  scenario({ id: 'C04-remove-repetition', tier: 'C', task: 'Remove the repetitive explanation in this section.', projectState: 'Transcript contains two semantically equivalent explanations separated by a short example.', expectedFinalStatePredicates: ['One complete explanation remains.', 'The example connects coherently to surrounding speech.'], expectedHardConstraints: ['Do not remove unique facts.', 'Preserve sentence boundaries where possible.', 'Keep A/V sync.'], ...common, maxToleratedRevisionCount: 3, executionCoverage: 'contract' }),
  scenario({ id: 'C05-faster-demo', tier: 'C', task: 'Make this software demo faster while preserving every required step.', projectState: 'Screen recording with transcript and ordered UI actions required to reproduce the workflow.', expectedFinalStatePredicates: ['Dead time is reduced.', 'Every required UI action remains visible in order.'], expectedHardConstraints: ['Do not remove required steps.', 'Do not reorder dependent actions.', 'Keep voice explanation aligned with shown action.'], ...common, maxToleratedRevisionCount: 4, executionCoverage: 'contract' }),
  scenario({ id: 'C06-scenic-montage', tier: 'C', task: 'Find the best scenic moments and build a concise montage.', projectState: 'Many indexed scenic clips with shot-quality and temporal evidence.', expectedFinalStatePredicates: ['Montage selects varied high-quality moments.', 'Repeated near-identical shots are limited.'], expectedHardConstraints: ['Use only source media.', 'Avoid zero-duration/invalid cuts.', 'Preserve chosen music timing if present.'], ...common, maxToleratedRevisionCount: 4, executionCoverage: 'contract' }),
  scenario({ id: 'C07-topic-chapters', tier: 'C', task: 'Tighten each topic so the tutorial moves cleanly from setup to result.', projectState: 'Tutorial with transcript chapters and repeated inter-topic pauses.', expectedFinalStatePredicates: ['Topic order is retained.', 'Transitions between topics are concise and comprehensible.'], expectedHardConstraints: ['Preserve required instructions.', 'Do not merge unrelated steps.', 'Keep chapter boundaries traceable.'], ...common, maxToleratedRevisionCount: 4, executionCoverage: 'contract' }),
  scenario({ id: 'C08-demo-callouts', tier: 'C', task: 'Call attention to the controls I mention when I mention them.', projectState: 'Software demo with transcript and frame evidence of UI controls.', expectedFinalStatePredicates: ['Visual emphasis appears on the referenced control at the matching spoken moment.'], expectedHardConstraints: ['Ground control location in frame evidence.', 'Do not obscure the control.', 'Remove emphasis after the relevant moment.'], ...common, maxToleratedRevisionCount: 3, executionCoverage: 'contract' }),
  scenario({ id: 'C09-story-reorder', tier: 'C', task: 'Reorder these selected answers into problem, solution, result.', projectState: 'Three selected interview answers with transcript evidence and adequate edit handles.', expectedFinalStatePredicates: ['Final order communicates problem, solution, then result.', 'Each answer remains semantically intact.'], expectedHardConstraints: ['Use selected material only.', 'Do not fabricate bridges.', 'Preserve sync.'], ...common, maxToleratedRevisionCount: 4, executionCoverage: 'contract' }),
  scenario({ id: 'C10-caption-style-by-meaning', tier: 'C', task: 'Style the captions so claims and numbers are emphasized consistently.', projectState: 'Timed captions containing ordinary prose, key claims and numeric results.', expectedFinalStatePredicates: ['Claims/numbers use a consistent emphasis treatment.', 'Ordinary words remain visually secondary.'], expectedHardConstraints: ['Do not alter text or timing.', 'Keep contrast readable.', 'Avoid per-word visual noise.'], ...common, maxToleratedRevisionCount: 3, executionCoverage: 'contract' }),

  // Tier D. Compound agent jobs.
  scenario({ id: 'D01-saas-demo-60s', tier: 'D', task: 'Turn this eight-minute SaaS demo into a polished sixty-second product video.', projectState: 'Eight-minute product demo with transcript, indexed screen footage, dialogue and music options.', expectedFinalStatePredicates: ['Finished cut has hook, problem/value, core workflow and clear ending within target duration.'], expectedHardConstraints: ['Preserve factual product claims.', 'Keep required UI actions understandable.', 'Meet duration tolerance.'], ...common, maxToleratedRevisionCount: 8, executionCoverage: 'contract' }),
  scenario({ id: 'D02-beat-synced-reel', tier: 'D', task: 'Make a twenty-five-second beat-synced reel from these scenic clips.', projectState: 'Dozens of scenic clips plus analysed music beat grid.', expectedFinalStatePredicates: ['Cuts form a coherent visual progression and important boundaries align with musical beats.'], expectedHardConstraints: ['Do not force every cut to a beat.', 'No repeated source interval.', 'Stay within duration target.'], ...common, maxToleratedRevisionCount: 7, executionCoverage: 'contract' }),
  scenario({ id: 'D03-podcast-short', tier: 'D', task: 'Turn this podcast segment into a short with captions, meaningful punch-ins and relevant B-roll.', projectState: 'Podcast A-roll, transcript, speaker framing and indexed B-roll assets.', expectedFinalStatePredicates: ['Short has a clear hook and coherent excerpt.', 'Captions, punch-ins and B-roll support the spoken content.'], expectedHardConstraints: ['Do not misquote speaker.', 'Keep dialogue continuous.', 'Avoid overlapping visual treatments that reduce readability.'], ...common, maxToleratedRevisionCount: 8, executionCoverage: 'contract' }),
  scenario({ id: 'D04-concise-tutorial', tier: 'D', task: 'Produce a concise tutorial while preserving every required action.', projectState: 'Long screen tutorial with ordered action evidence and explanatory narration.', expectedFinalStatePredicates: ['Result is materially shorter.', 'Every required action remains visible in correct order.'], expectedHardConstraints: ['Do not remove prerequisite actions.', 'Do not reorder dependent steps.', 'Keep narration/action alignment.'], ...common, maxToleratedRevisionCount: 8, executionCoverage: 'contract' }),
  scenario({ id: 'D05-launch-teaser', tier: 'D', task: 'Create a thirty-second launch teaser that shows the product payoff quickly.', projectState: 'Product demo, talking-head intro, logo asset, music and several proof/result moments.', expectedFinalStatePredicates: ['Teaser opens on payoff, demonstrates value and ends with restrained brand close.'], expectedHardConstraints: ['No invented claims.', 'Respect brand assets.', 'Meet duration tolerance.'], ...common, maxToleratedRevisionCount: 7, executionCoverage: 'contract' }),
  scenario({ id: 'D06-interview-highlight', tier: 'D', task: 'Cut the strongest ninety-second interview highlight with clean pacing and supporting B-roll.', projectState: 'Twenty-minute interview with transcript, two cameras and indexed contextual B-roll.', expectedFinalStatePredicates: ['Highlight has a self-contained arc and uses B-roll only where it adds context.'], expectedHardConstraints: ['Keep speaker meaning intact.', 'Preserve multicam sync.', 'Meet duration tolerance.'], ...common, maxToleratedRevisionCount: 8, executionCoverage: 'contract' }),
  scenario({ id: 'D07-product-walkthrough', tier: 'D', task: 'Polish this product walkthrough with dead-time cleanup, callouts, captions and balanced audio.', projectState: 'Screen recording with narration, transcript, UI frame evidence and background music.', expectedFinalStatePredicates: ['Workflow stays complete while pacing, readability and audio consistency improve.'], expectedHardConstraints: ['Preserve every required workflow step.', 'No clipped dialogue.', 'Callouts must be visually grounded.'], ...common, maxToleratedRevisionCount: 8, executionCoverage: 'contract' }),
  scenario({ id: 'D08-testimonial-cut', tier: 'D', task: 'Build a forty-five-second customer testimonial around the strongest evidence and result.', projectState: 'Long testimonial interview with transcript, customer B-roll and approved product shots.', expectedFinalStatePredicates: ['Cut contains context, evidence and result with a coherent emotional arc.'], expectedHardConstraints: ['Do not alter testimonial meaning.', 'Use approved media only.', 'Meet duration tolerance.'], ...common, maxToleratedRevisionCount: 7, executionCoverage: 'contract' }),
  scenario({ id: 'D09-multicam-explainer', tier: 'D', task: 'Polish this two-camera explainer and switch angles only when it helps pacing or clarity.', projectState: 'Synced multicam talking-head sequence with transcript and audio on one canonical source.', expectedFinalStatePredicates: ['Angle changes are purposeful and sparse.', 'Dialogue edit remains continuous.'], expectedHardConstraints: ['Preserve sync offsets.', 'Do not switch to unavailable angle intervals.', 'Do not duplicate audio.'], ...common, maxToleratedRevisionCount: 7, executionCoverage: 'contract' }),
  scenario({ id: 'D10-platform-package', tier: 'D', task: 'Create a polished master plus a short vertical cut while preserving the same core message.', projectState: 'Completed source story with landscape media and subject-aware framing evidence.', expectedFinalStatePredicates: ['Master and vertical story preserve the same central claim.', 'Vertical cut is meaningfully adapted rather than stretched.'], expectedHardConstraints: ['No destructive source edits.', 'Keep factual claims consistent.', 'Respect platform framing.'], ...common, maxToleratedRevisionCount: 9, executionCoverage: 'contract' }),

  // Tier E. Adversarial and recovery.
  scenario({ id: 'E01-offline-media', tier: 'E', task: 'Tighten this section while one referenced clip is offline.', projectState: 'Timeline includes an offline source asset inside the requested range.', expectedFinalStatePredicates: ['Run fails or degrades honestly without inventing content for the offline asset.'], expectedHardConstraints: ['Do not mutate around unknown media as though it rendered.', 'Keep project valid.', 'Surface actionable failure.'], ...common, maxToleratedRevisionCount: 1, executionCoverage: 'contract' }),
  scenario({ id: 'E02-missing-transcript', tier: 'E', task: 'Remove repeated explanation from this talking-head section without a transcript.', projectState: 'Speech media exists but transcript evidence is unavailable.', expectedFinalStatePredicates: ['Agent requests/uses another grounded evidence path or explains the limitation.'], expectedHardConstraints: ['Do not fabricate transcript content.', 'Do not make semantic speech cuts from guessed words.', 'Keep project unchanged if evidence is insufficient.'], ...common, maxToleratedRevisionCount: 1, executionCoverage: 'contract' }),
  scenario({ id: 'E03-stale-context', tier: 'E', task: 'Trim the clip I selected.', projectState: 'Interaction snapshot references a clip that was replaced before execution.', expectedFinalStatePredicates: ['Stale target is rejected or deterministically re-resolved when safe.'], expectedHardConstraints: ['Never mutate the stale clip ID blindly.', 'Respect current project revision.', 'No unrelated edits.'], ...common, reviewExpected: false, maxToleratedRevisionCount: 1, executionCoverage: 'contract' }),
  scenario({ id: 'E04-revision-changes-mid-run', tier: 'E', task: 'Polish the intro while the editor makes a manual change during the run.', projectState: 'Agent starts at revision N; host project advances before a later agent commit.', expectedFinalStatePredicates: ['Stale mutation is rejected or safely rebased by host authority.', 'Manual edit is preserved.'], expectedHardConstraints: ['Exactly-once commit.', 'No lost update.', 'No silent overwrite.'], ...common, maxToleratedRevisionCount: 2, executionCoverage: 'contract' }),
  scenario({ id: 'E05-cancel-analysis', tier: 'E', task: 'Analyze and tighten the intro, then cancel while the model is still analyzing.', projectState: 'Cancelable agent run before any mutation has committed.', expectedFinalStatePredicates: ['Run terminates cancelled and stops producing new work.'], expectedHardConstraints: ['No mutation after cancellation.', 'Terminal status is cancelled.', 'Persist resumable state only when meaningful.'], ...common, reviewExpected: false, maxToleratedRevisionCount: 0, executionCoverage: 'agent_runtime', linkedFixtureId: 'foundation-cancel-analysis' }),
  scenario({ id: 'E06-cancel-mutation', tier: 'E', task: 'Apply several cleanup edits, then cancel during a host mutation boundary.', projectState: 'Multi-turn run with at least one committed edit and a later mutation in flight.', expectedFinalStatePredicates: ['Already committed work remains coherent and later work stops.', 'Run exposes valid undo/resume semantics.'], expectedHardConstraints: ['No half-applied patch.', 'No post-cancel commit.', 'Exactly-once persistence.'], ...common, maxToleratedRevisionCount: 2, executionCoverage: 'contract' }),
  scenario({ id: 'E07-invalid-tool-args', tier: 'E', task: 'Trim the selected clip, but the model emits malformed tool arguments.', projectState: 'Valid selection with provider response containing schema-invalid tool arguments.', expectedFinalStatePredicates: ['Invalid call is rejected and may be repaired within bounded policy.'], expectedHardConstraints: ['Never apply malformed operation.', 'Record invalid call.', 'Do not claim success without an edit.'], ...common, reviewExpected: false, maxToleratedRevisionCount: 1, executionCoverage: 'contract' }),
  scenario({ id: 'E08-transition-handles', tier: 'E', task: 'Add a one-second dissolve where neither clip has enough handles.', projectState: 'Adjacent clips consume their source boundaries around the requested edit.', expectedFinalStatePredicates: ['Requested transition is rejected or safely shortened with an explicit reason.'], expectedHardConstraints: ['Never read beyond source media.', 'No negative duration.', 'Do not shift unrelated clips to fake handles.'], ...common, reviewExpected: false, maxToleratedRevisionCount: 1, executionCoverage: 'contract' }),
  scenario({ id: 'E09-undo-multi-step', tier: 'E', task: 'Undo the last multi-step agent run.', projectState: 'Most recent history entry is a grouped agent run containing several committed turn diffs.', expectedFinalStatePredicates: ['Project returns to the exact pre-run timeline state.'], expectedHardConstraints: ['Undo only the advertised run scope.', 'Preserve newer unrelated history when operation is unavailable instead of guessing.', 'Remain redoable where history supports it.'], ...common, reviewExpected: false, maxToleratedRevisionCount: 1, executionCoverage: 'contract' }),
  scenario({ id: 'E10-large-session', tier: 'E', task: 'Find and tighten repeated explanations in a project with more than one thousand clips/assets.', projectState: 'Large indexed project with 1000+ clips/assets and bounded interaction context.', expectedFinalStatePredicates: ['Agent uses bounded retrieval and edits only grounded matches.'], expectedHardConstraints: ['Do not serialize the whole project into model context.', 'Avoid quadratic timeline scans in the interaction loop.', 'Keep mutations revision-safe.'], ...common, maxToleratedRevisionCount: 4, executionCoverage: 'contract' }),
] as const satisfies readonly AgentOutcomeEvalScenario[];

export interface AgentOutcomeEvalDriftIssue {
  readonly scenarioId: string;
  readonly message: string;
}

/**
 * Release drift for the agent layer. This intentionally checks only registration and
 * linkage. Outcome execution belongs to the normal professional/agent runtime tests.
 */
export function agentOutcomeEvalDriftIssues(
  scenarios: readonly AgentOutcomeEvalScenario[] = AGENT_OUTCOME_EVAL_SCENARIOS,
): readonly AgentOutcomeEvalDriftIssue[] {
  const issues: AgentOutcomeEvalDriftIssue[] = [];
  const ids = new Set<string>();
  for (const row of scenarios) {
    const parsed = AgentOutcomeEvalScenarioSchema.safeParse(row);
    if (!parsed.success) {
      issues.push({ scenarioId: row.id, message: parsed.error.message });
      continue;
    }
    if (ids.has(row.id)) issues.push({ scenarioId: row.id, message: 'Duplicate scenario id.' });
    ids.add(row.id);
    if (row.executionCoverage === 'professional_eval') {
      const linked = PROFESSIONAL_EVAL_MANIFEST.filter(
        (candidate) => candidate.fixtureId === row.linkedFixtureId && candidate.availability === 'registered',
      );
      if (linked.length !== 1) {
        issues.push({
          scenarioId: row.id,
          message: `Expected exactly one registered professional fixture "${row.linkedFixtureId ?? ''}"; found ${String(linked.length)}.`,
        });
      }
    }
  }
  if (scenarios.length !== 50) {
    issues.push({ scenarioId: 'manifest', message: `Phase 0 requires 50 canonical scenarios; found ${String(scenarios.length)}.` });
  }
  for (const tier of AGENT_OUTCOME_EVAL_TIERS) {
    const count = scenarios.filter((row) => row.tier === tier).length;
    if (count !== 10) {
      issues.push({ scenarioId: `tier-${tier}`, message: `Expected 10 Tier ${tier} scenarios; found ${String(count)}.` });
    }
  }
  return issues;
}
