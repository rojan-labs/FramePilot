# Phase 3 — Reference videos and images as first-class AI context: after

Before this phase, the only image that ever reached the model was a `get_frame` result, and
it was dropped from history the next turn on purpose. An editor could paste a reference into
the composer and watch the chip appear — the chip went nowhere. "Make it feel like this" had
nothing behind it.

## What ships

**A reference is measured once, in the engine, and what the model reads is a handful of
editor-vocabulary lines — not the file.**

- **Attach** (P3.1): the composer takes `video/*` and `image/*`, imports the file into the
  project's media directory through the same chunked path the bin uses (so the sandbox does
  not widen), and calls `framepilot:references:analyze` → the sidecar's
  `POST /references/analyze`.
- **Role** (P3.2): `references/role.ts` decides `style` / `pacing` / `caption-style` /
  `color` / `brand-logo` / `thumbnail` / `b-roll` / `character` / `design` from the user's
  own words and cheap deterministic signals (alpha + small dimensions → logo). There is
  deliberately **no model fallback**: an undecidable attachment comes back `ambiguous` with
  a `style` default and the editor changes it on the tile. Spending a model call per turn to
  guess a purpose is exactly the kind of request this mission exists to remove.
- **Measure once** (P3.3): scene detection, beat detection, silence share and colour
  sampling run in the sidecar and are cached beside the file, keyed by the file's content
  hash. Re-attaching, re-asking, or reopening the project reuses the answer; only the
  sidebar's explicit **Re-analyze** (`refresh: true`) recomputes.
- **Into context** (P3.4): `summarizeReferences` puts a fixed "References the editor
  attached" block in the P1.3 `memory` section — the ≤ 12 constraint lines, never the raw
  numbers and never the pixels. The desktop request path validates and caps them at 8.
- **Across turns** (P3.5): a reference the run plans against becomes a committed decision
  with `source: reference`, `until: superseded`, carrying its measured line verbatim, so a
  later turn applies the profile without re-reading or re-asking. Removing the tile
  supersedes it — a constraint the editor deleted stops binding.
- **Visible** (P3.6): the chip is a disclosure showing the constraint lines *verbatim* — the
  exact text the planner reads, not a summary of it — plus the analysis timestamp, a role
  selector and Re-analyze. A failed analysis states its reason there, with the retry beside
  it, instead of in a toast that is gone by the time anyone reads it.

## Evidence

| Claim | Proof |
| --- | --- |
| Role table decides the fixture set from words + signals alone | `references/role.ts` — 13 table tests |
| Profile builder turns measurements into constraint lines | profile builder unit tests |
| The context block is fixed-shape and capped | context-builder tests, desktop `parseReferences` |
| "Same as the reference" survives the run boundary; removing the tile stops it | 3 tests driving the real conductor (P3.5) |
| The route refuses paths outside the sandbox, caches by content hash, and `refresh` bypasses it | `engine/python/tests/test_service_references.py` (synthetic PNG) |
| **A real, multi-shot camera video is measured once and served from cache after** | `tests/e2e-desktop/specs/references-analyze.spec.ts` — new in this pass |
| UC-06 / UC-07 end to end | `tests/e2e-desktop/specs/ai-journey.spec.ts` — attaches `ref/fast-cut-vertical.mp4` + `ref/logo.png`, waits out the analysis, then asks for both in one turn |

The new sidecar spec is the piece the engine's own unit test could not give: that test
proves the *contract* with a synthetic PNG; only real footage through a real ffmpeg proves
that scene, beat, silence and colour analysis actually produce numbers an editor would
recognise — and that the second attach costs a file read, not a re-measurement. It asserts
the cache by **cost**, not just by the `cached` flag: the second answer must return in under
half the first call's time, because a flag can be right while the work is done twice.

## What this phase does NOT ship, and what that costs

**P3.4 is half-landed, and the half that is missing is the half that changes pixels.** The
profile reaches the model as constraints and reaches decision memory as a commitment. It
does **not** yet reach the controllers:

- the plan does not cite which reference constraint it is applying (proposer prompt);
- the audio, colour, timeline and motion controllers do not read the numeric profile
  directly — they read the model's paraphrase of it;
- `brand-logo` does not become an overlay op with the asset id, `color` does not become a
  grade target, `b-roll` does not enrol the image as a project asset.

So UC-07's logo journey is, today, "the model has been told there is a logo", not "the logo
is on the timeline". `docs/guides/reference-media.md` has an explicit Limits section naming
this, which is the right place for it: an editor should not have to discover it by looking
at an export.

Also still open: thumbnail tiles instead of chips, drag-and-drop onto the composer, chip
persistence across reload, the ADR for the profile contract, and the CHANGELOG entry.
P3.3's project-file persistence remains behind the `[!]` schema gate — profiles live in the
session store until that clears.

## Bottom line

The measurement half of Phase 3 is done and proven; the acting-on-it half is not. Phase 3
stays `[~]`, and UC-06/UC-07 stay unproven in `09-after.md`'s matrix — the specs exist and
are wired into the nightly lane, but a journey is proven when its test passes on the desktop
host against real media, and neither has run there yet.
