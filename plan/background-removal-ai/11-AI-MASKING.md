# 11 — AI masking

The agent must be able to do everything an editor does in [`10`](./10-PROFESSIONAL-MASKING.md), driven
by plain requests: "blur the faces", "put the title behind her", "grade only the sky", "mask the red
car and track it", "remove the background". It must be exactly as precise as the manual path, because
it uses **the same operations, the same pack jobs and the same review list**.

## Rules (extend the existing AI contract; none is new in spirit)

1. **The model never invents geometry.** Every mask's vertices, boxes and tracks come from a
   measurement (a detection, a segmentation, a track) or from a number the user typed. The model
   picks **which** candidate and **what purpose**; deterministic code produces the shape. This is the
   rule `automatic-tracking.ts` already follows ("the model never authors a track"). The validator
   rejects AI-authored mask geometry that has no candidate or user source.
2. **Resolve the target or ask, never guess.** If two candidates plausibly match the request (score
   margin below threshold, or more than one of the named class), the tool returns
   `ambiguous_target` with thumbnails, and the sidebar asks the user to pick. A wrong object masked
   with confidence is the worst failure here.
3. **Same pipeline, same review.** AI masks go through the pack's consensus → verify stages. Flagged
   ranges land on the Inspector review list. The agent reports "{n} moments need a look" and never
   says Verified on the editor's behalf.
4. **Packs are consent.** A missing pack returns `pack_missing` with the signed proposal; the existing
   `PackInstallInlineCard` shows it. The agent cannot install anything.
5. **Engine before AI** (PRD §23): AM phases start only after MK (manual masking) and BR (matte
   pipeline) are complete and tested.

## Target resolution

```
request text + clip + time range
  → candidates:
      subject.detect (faces, persons, COCO objects; Subject Intelligence)
    + open-vocabulary grounding (text → boxes, for "the red car", "license plate", "the sign")
    + shot ledger facts (subject kind, identity clusters; VU tier 1/2) when indexed
    + region classes that are not objects ("sky", "ground", "background") via segmentation prompts
  → rank: grounding score × identity/ledger agreement × temporal persistence across sampled frames
  → unambiguous? → segment (subject.matte) / fit shape → track if the subject moves → apply ops → verify
  → ambiguous? → ambiguous_target with candidate thumbnails → user picks → continue
```

- **Open-vocabulary grounding model:** candidates are Grounding DINO or OWLv2 (Apache-2.0 upstream,
  **to verify in BR0 with training-data terms**; decided under **MD-6**). It is added to the Smart Mask
  pack, which already carries onnxruntime, with SigLIP from `visual-embed` as an optional re-ranker
  when installed.
- **Faces** use YuNet (Subject Intelligence) for boxes and identity clusters (SFace, `visual-embed`),
  so "blur everyone except the host" resolves by identity, not by position.
- Candidate ids are stable per clip and time, and are recalled by the run's memory (the
  `agent-log-payload-window` lesson: ids must be recallable, not only in the freshest payload).

## Tools (`packages/ai-sdk/src/domain-tools/masking.ts`, domain `masking`)

A new domain replaces the mask half of `tracking` in `DOMAIN_SUMMARY`: "masks and cut-outs: remove
backgrounds, isolate or hide people and objects, blur faces or plates, grade or effect only part of
the picture, put text behind a subject, track masks". The summary is the discovery surface (memory:
`skill-description-is-the-discovery-surface`), so it names the requests, not the mechanics.

| Tool                      | Input (model-facing)                                                                                                                                                                                                                                                                                   | What it does                                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `find_mask_targets`       | `clipId`, `description`, optional `range`                                                                                                                                                                                                                                                              | Returns ranked candidates `{ candidateId, label, score, box@pts, thumbnailRef, persistence }` or `ambiguous_target`                                                                                                                       |
| `create_mask`             | `clipId`, `candidateId` (or `userShape` when the user gave explicit numbers), `precision: 'cutout' \| 'shape'`, `shape?: 'ellipse' \| 'rectangle' \| 'path'`, `purpose: 'cutout' \| 'hide' \| 'effect'`, `effect?` (catalog kind + intent), `edge: 'exact' \| 'soft' \| 'very_soft'`, `track: boolean` | `cutout` → matte mask via the pack. `shape` → deterministic fit (ellipse/rectangle from the matte or box, path by contour fit with a vertex budget). Optional tracking. Emits `add_mask` (+ effect, + `apply_mask_tracking`) as one patch |
| `remove_background`       | `clipId`, optional `candidateId`                                                                                                                                                                                                                                                                       | `create_mask` preset: main subject, cut-out, clip alpha                                                                                                                                                                                   |
| `put_text_behind_subject` | `clipId`, `text`, optional style                                                                                                                                                                                                                                                                       | `add_text_behind_subject` with the subject matte                                                                                                                                                                                          |
| `track_mask`              | `clipId`, `maskId`, `method?`                                                                                                                                                                                                                                                                          | Tracking Lite job → `apply_mask_tracking`; returns flagged ranges                                                                                                                                                                         |
| `refine_mask`             | `clipId`, `maskId`, `edge?`, `grow?: 'tighter' \| 'looser'`, `add?/remove?: candidateId`, `mode?`, `invert?`                                                                                                                                                                                           | Bounded, intent-level adjustments mapped to numbers by deterministic tables; explicit px only when the user said a number                                                                                                                 |
| `get_masks`               | `clipId`                                                                                                                                                                                                                                                                                               | Compact read: kind, target, mode, tracked, review state, flagged count                                                                                                                                                                    |
| `delete_mask`             | `clipId`, `maskId`                                                                                                                                                                                                                                                                                     | `remove_mask`                                                                                                                                                                                                                             |

`generate_mask` (registered unavailable today) is deleted and replaced by `create_mask`; the old
`add_mask` model tool (shape with fixed bounds) is removed from the model surface. The
`detect_subjects` and `track_subject_automatically` tools either fold into this domain or stay as
thin aliases, decided by reading their current callers at AM1 start (no parallel paths).

**Effect intents** for `purpose: 'effect'` map to catalog effects with deterministic parameters, e.g.
`blur_to_hide` → a blur strong enough to be unreadable at the export resolution (validated by a
measured detail metric, not a guess), `brighten`, `darken`, `desaturate`, `grade_match_to` (reuses the
VU colour solver). The model states intent; the solver picks numbers (VU rule 3).

## Model surfaces and tokens

- Clip rows gain a compact mask fact only when masks exist, e.g. `masks:2 (cutout✓, face-blur⚑3)`.
  Zero delta on projects without masks, pinned by the token goldens.
- Skill `packages/ai-sdk/skills/masking-and-compositing.md` (editing-skills-expert): recipes for
  face/plate blur (identity-aware, tracked), text behind subject, spotlight/vignette, sky and
  secondary grades, split screen, "hide an object" (mask + fill from another clip; inpainting is
  deferred), and the review etiquette ("report flagged moments; don't claim verified").
- Golden token manifests are regenerated with the three commands and the delta is reviewed (memory:
  `golden-manifests-track-prompt-text`).

## Verification after apply

- Deterministic first: the pack's `needsReview`, track confidence, and validator results are returned
  in the tool result.
- Visual spot check only where the numbers cannot decide: `frame_grab` at up to 4 flagged or sampled
  frames through the existing vision-review route, asking a single structured question ("is the
  masked region the {label}? yes/no/unsure"). A `no` removes the mask and re-resolves or asks;
  `unsure` adds the range to the review list.
- A self-check note never judges an AI mask against unattributed data (memory: `unattributed-transcripts-lie`).

## Evals (gates in [`06`](./06-PRECISION-AND-EVAL.md#ai-masking))

A golden set of requests on labelled fixtures covering faces, people, plates, signs, vehicles, sky,
products, pets, "everyone except X", crowded scenes and deliberately ambiguous phrasing. Measured
through the recorded-run harness (`--replay` where possible; no live golden runs by default, memory:
`no-full-suites-no-golden-runs`).
