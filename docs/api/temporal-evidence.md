# Temporal and perceptual evidence

The temporal evidence protocol is FramePilot's typed boundary between an edit command, a host that
can inspect rendered frames/audio, and the deterministic Critic. It prevents a reviewer from
claiming that it “watched” an edit when no evidence was returned.

## Loudness evidence

`loudness` requests meter programme loudness over a window with ffmpeg's `ebur128` (EBU R128).
Peak evidence answers whether a mix is safe; loudness answers whether it is as loud as it should
be, which is what delivery specs enforce.

- `channels` selects `mix` or an authored track role (`dialogue`/`music`/`sfx`, schema v17), so a
  stem can be checked against its own target while the bed sits under it.
- `targetLufs` defaults to -14 LUFS (the common short-form/streaming spec) and `toleranceLu` to 1 LU.
- The reviewer fails a reading in **either** direction: too quiet gets turned up on delivery, too
  loud gets turned down, and either way the mix the editor approved is not the mix the audience
  hears.

Asking for a role no track carries fails closed with the missing-label reason rather than returning
the silence floor, which would read as a passing measurement.

## Request families

Every request is schema-versioned, project-revision-bound, and carries a stable request id and
reason. `TemporalEvidenceRequestSchema` supports:

| Kind         | Purpose                                                                     |
| ------------ | --------------------------------------------------------------------------- |
| `frame`      | Inspect one representative frame for luma, black ratio, or perceptual hash. |
| `range`      | Sample every requested frame/cadence for black or isolated flash frames.    |
| `comparison` | Compare an explicit pair for transition continuity or shot matching.        |
| `scope`      | Measure requested luma/RGB/saturation channels against legal bounds.        |
| `motion`     | Inspect transform, tracker, or mask trajectories and normalized bounds.     |
| `audio`      | Measure mix/dialogue/music/SFX peaks and boundary discontinuities.          |

Results use the matching `TemporalEvidenceResultSchema`. The reviewer rejects stale revisions,
unrequested results, duplicate request/result ids, wrong result kinds, mismatched frame pairs,
samples outside the requested window, incomplete range cadence, duplicate motion frames, and audio
segments that do not cover the whole window. Missing evidence is `skipped`, never `pass`.

## Command-driven evidence planning

`planTemporalEvidence` always selects bounded beginning/middle/end representative frames. It then
derives critical windows from deterministic compiler facts such as `newCutSeconds`,
`sequenceStartSeconds`, `pictureCutSeconds`, and `soundCutSeconds`. J/L cuts additionally request an
audio window around the moved sound boundary.

The planner deliberately does not require adjacent shots to look similar. A hard cut may have a
large visual difference and still be correct. Flash detection therefore looks for an isolated
one-frame luma spike whose neighbours agree, rather than treating every high-contrast cut as a
failure. Comparison evidence is requested only by a controller with an explicit continuity or
shot-match objective.

## Deterministic verdicts

`reviewTemporalEvidence` currently checks:

- unexpected black and isolated flash frames;
- explicit comparison-difference thresholds;
- scope values outside requested legal ranges;
- transform acceleration, normalized frame bounds, and tracker/mask jitter;
- audio peaks and discontinuities.

The resulting `TemporalReviewReport` records the project revision and exact evidence request ids.
When supplied to `critique`, any failed or missing temporal evidence fails the additive
`temporal_evidence` Critic check. When no temporal review was requested, the existing Critic report
remains byte-compatible and makes no temporal claim.

## Engine acquisition

`POST /review/temporal-evidence` accepts the same request union plus exactly one project source:
either `project_path` for a saved project or `project` for the live unsaved working copy. The engine
requires every request to match the timeline's current revision, compiles that working timeline
once through the export compiler, and caches overlapping frame samples across the batch.

The engine derives frame luma/black ratio/perceptual hashes; RGB/luma/saturation extrema, means,
10th/50th/90th percentiles, and near-black/near-white pixel ratios; explicit frame-pair differences;
mix peak/RMS/boundary energy; and stored transform/tracker/mask trajectories. The richer scope
statistics are additive fields in evidence v1: older recorded batches still parse, while consumers
that need shot matching must explicitly require the complete statistics instead of treating extrema
as sufficient. It returns measurements only; pass/fail policy remains in `reviewTemporalEvidence`.
This separation keeps the render engine deterministic and prevents acquisition code from silently
changing editorial thresholds.

Acquisition measures at `REVIEW_MAX_DIMENSION` (960 on the longest edge), not the project's
resolution, and no source is decoded larger than the frame it is composited into (ADR 0124). Every
measurement review takes is a statistic over the whole picture — a mean, a ratio, percentiles, an
8x9 hash — and none of them distinguishes UHD from a quarter of it, while decoding UHD to compute
them cost 273ms and 781 MB per batch against 38ms and 176 MB. The one real trade is that `min`/`max`
no longer see a single stray pixel; `renderSettings` records the exact size measured, so a recorded
review still says what it was taken at.

Acquisition is bounded to 64 requests, 300 frames per window, and 600 distinct rendered frames per
batch. Out-of-range frames, duplicate ids, mixed/stale revisions, missing targets, and absent audio
fail explicitly. The response preserves the camel-case versioned contract used by the TypeScript
reviewer. It also includes strict `renderSettings` metadata: a self-validating identity plus the
compiler preset id, output width/height, fps, and caption-burn state. The client rejects an identity
that contradicts those fields, so a recorded review can be reproduced against the same configuration.

For `dialogue`, `music`, and `sfx` requests, acquisition renders only the tracks carrying that
authored schema-v17 role. A missing role fails closed rather than relabeling programme-mix evidence
or returning the silence floor as a reassuring result.

Hosts call the route through `createTemporalEvidenceAcquirer`. The client strips bulky derived
asset media from the inline working project, forwards cancellation, imposes a hard timeout, validates
the complete batch against `TemporalEvidenceBatchSchema`, and fails closed on HTTP or schema errors.
A failed acquisition can therefore never become an empty successful review.

## Unified run gate

The shared `streamEditorRun` boundary reconstructs the validated working project from emitted diffs,
derives visual and audio boundary windows from the before/after timelines, and runs acquisition before
allowing either the diffs or a `completed` status through. Validated diffs remain staged while the
engine reviews the final in-memory timeline, so desktop auto-commit cannot persist a perceptually
rejected edit. Frame plans include beginning/middle/end plus changed visual clip/effect boundaries;
audio-track changes request programme-mix windows. Plans interleave picture and sound requests under
one deterministic 48-request cap so a large picture edit cannot starve audio QA.

The temporal report is passed through the Critic's `temporal_evidence` check. A pass emits a typed
notification and lets settlement continue. A deterministic failed/missing verdict discards staged
diffs and replaces successful settlement with `failed`. An unreachable acquisition service is
different: it has no verdict, so the validated proposal is released as explicitly `unverified` for
human inspection and can never enter auto-commit. Stop during acquisition discards it and settles as
`cancelled`. The durable EditorRun lifecycle
records the project revision, exact render-
settings identity, every evidence request id, and the pass/fail decision on its review stage. This
same boundary serves explicit edit, recipe, planned-edit, agent, and model-routed auto execution.

When every failed check contains concrete measured evidence, the boundary permits exactly one repair
turn. That turn receives only the failed evidence, runs through the normal mutating-tool descriptors,
and must produce a validated, non-no-op patch. FramePilot then renders and reviews the complete
original-plus-repair working timeline again. Only a second-pass success releases both staged patches;
a missing/no-op repair, repeated perceptual failure, cancellation, or acquisition error releases none.
Missing/skipped evidence is not repairable because there is no trustworthy observation to fix.

The same production boundary now invokes the vision-review contract below whenever a compiled typed
operation declares a semantic framing, crop, mask, tracking, or transition objective. Desktop local
activation depends on the separately installed Subject Intelligence Capability Pack; the base app
does not bundle a model or pretend one is present.

## Vision review — the judgement no measurement makes

Deterministic evidence proves a great deal: that a cut lands on frame 30, that a trajectory is
smooth, that scopes stay legal, that a mix is peak-safe, that nothing decoded to black. It cannot
answer whether the **edit worked** — whether the subject is still framed, whether the incoming camera
is on the same moment, whether a graded shot looks like the same room. Those are semantic questions,
and a number does not settle them.

`reviewVisionObjectives` (`packages/ai-sdk/src/vision-review.ts`) exists for exactly those questions.
Five rules keep it from quietly becoming the reviewer:

1. **Never the default.** It runs only when the typed-operation objective planner declares a semantic
   question it cannot check any other way.
2. **It cannot rescue a deterministic failure.** The Critic ANDs its checks, so a vision pass adds a
   check and never removes one. "Looks fine" over a black frame changes nothing.
3. **`cannot_tell` is not a pass.** An honest "I cannot see that here" settles as _unverified_, which
   fails the gate that asked. Otherwise an unreadable frame would be indistinguishable from a good
   one — and the one question measurement could not answer would be the one waved through.
4. **No reviewer configured is a refusal, not an assumption.** A host with no vision-capable model
   reports the objective unverified.
5. **Bounded.** At most four distinct frames, one call, no retry loop. Recovery is the existing
   bounded repair path, not more looking.

Every failure mode — no reviewer, an unacquirable frame, a malformed verdict, a thrown error, an
honest `cannot_tell` — lands on `unverified`. The only route to `pass` is a well-formed pass verdict
over frames that were actually looked at.

The frame client calls `POST /render/frame` with the complete unsaved working project and rejects a
response clamped to another moment. One objective may inspect at most four distinct frames. The
one-shot judge receives those frames as real multimodal message parts and must return the strict
`pass | fail | cannot_tell` verdict; there is no retry or model-authored repair loop.

Every review records transport, provider, model, prompt version, exact local pack version when
applicable, request ids, frame numbers, and decision. A cloud transport is refused **before frame
acquisition** unless the run carries an explicit, timestamped media-egress consent receipt. Local
pack review does not require egress consent, but it must name the exact immutable pack version.

The Critic surfaces the outcome as a `vision_review` check with the same fail-closed semantics as
`temporal_evidence`: declared and unconfirmed is a failure, not a warning.
