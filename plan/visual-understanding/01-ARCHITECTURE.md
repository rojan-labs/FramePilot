# 01 — Architecture: the shot ledger and how the agent reads it

## 1. Principle

A human editor logs footage once and cuts from the log. The agent does the same. Perception
is compiled at import into a **shot ledger** stored in the project brain; the run reads the
ledger through the timeline. The three costs are kept apart on purpose:

| Cost     | Scales with           | Paid                                         | By                                        |
| -------- | --------------------- | -------------------------------------------- | ----------------------------------------- |
| Perceive | footage minutes       | once per asset content hash and tier version | sidecar background job                    |
| Project  | clips on the timeline | once per project revision                    | pure TS, memoized per snapshot            |
| Decide   | decisions             | per turn                                     | model reads text; solvers compute numbers |

Frames are decoded for perception and for verification. Never for planning.

## 2. The unit: a shot

A shot is a contiguous source-time span of one asset with no scene cut inside it. Tier 0
derives shots from the existing sampler (`analysis/visual_sampler.py`: scene cuts → 1 fps
candidates → dHash fold). A still image is one shot. Shots are keyed
`(asset_id, content_hash, shot_index)`; `t0/t1/keyframe_t` are **asset seconds**. Timeline
seconds are always a projection through the clip that references the asset, never stored.

## 3. The ledger record

One JSON document per shot, one summary per asset. Fields are grouped by provenance so the
briefing can render them differently and a tier can be re-run without touching the others.

```jsonc
{
  "assetId": "a_7f3",
  "contentHash": "sha256:…",
  "shotIndex": 12,
  "t0": 61.0,
  "t1": 66.4,
  "keyframeT": 62.5,
  "durationS": 5.4,

  "measured": {
    // tier 0 — ffmpeg, exact, keyless
    "tier0Version": 1,
    "luma": { "mean": 0.47, "std": 0.18, "p5": 0.08, "p95": 0.86 }, // 0..1 from Y
    "chroma": { "uMean": 124.1, "vMean": 133.8, "satMean": 0.31 }, // signalstats
    "warmth": 0.14, // (V−U) normalised, calibrated on ref/colorchart.png
    "contrastIdx": 0.62, // (p95−p5), a printable stand-in for "flat"/"punchy"
    "motion": { "ti": 7.9, "si": 41.2, "class": "static|slow|handheld|fast" },
    "cutScore": 0.31, // scdet score at t0 (how hard the shot starts)
    "black": false,
    "freeze": false,
    "sharpness": 0.71, // blurdetect normalised; low = soft/out of focus
    "phash": "9f2c…", // 64-bit dHash of the keyframe (already stored today)
    "loudnessLufs": -18.2, // ebur128 over the shot, when the asset has audio
  },

  "labelled": {
    // tier 1 — local SigLIP + SFace pack
    "tier1Version": 1,
    "model": "siglip2-base-patch16-224",
    "shotSize": { "value": "MS", "p": 0.81 }, // ECU/CU/MCU/MS/MWS/WS/EWS
    "subjectKind": { "value": "person", "p": 0.93 }, // person/people/object/place/screen/text/animal/food/vehicle/none
    "setting": { "value": "indoor-office", "p": 0.66 },
    "screenContent": { "value": "talking-head", "p": 0.74 }, // talking-head/b-roll/screen-recording/slides/title-card/graphic
    "faces": 1,
    "entities": [{ "id": "person_03", "kind": "person", "p": 0.88 }],
    "duplicateOf": null, // shot key when phash Hamming ≤ 6 with another shot
  },

  "described": {
    // tier 2 — local VLM pack or hosted captioner
    "tier2Version": 1,
    "model": "smolvlm2-2.2b-q4",
    "summary": "A man in a grey jacket speaks to camera at a desk with a laptop.",
    "subject": "man in grey jacket",
    "action": "speaking to camera",
    "setting": "office desk, laptop, window behind",
    "camera": { "shotSize": "MS", "angle": "eye-level", "movement": "static" },
    "mood": "neutral, bright",
    "onScreenText": [],
    "quality": ["well-lit"],
    "p": 0.7,
  },
}
```

Asset summary (`asset_digest`), one row per asset, rebuilt when any tier finishes:
`durationS, shotCount, medianShotS, settingMix, shotSizeMix, people[], exposureRange,
motionMix, hasSpeech, lowQualityShots[]`. This is what the project digest and the media-bin
badge read; nothing per shot is loaded for it.

## 4. Brain schema v4

Append `_migrate_v4` to `brain/migrations.py` (append-only, one transaction). No change to
`project.fp.json`.

```sql
CREATE TABLE shots (
  asset_id      TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  content_hash  TEXT NOT NULL,
  shot_index    INTEGER NOT NULL,
  t0 REAL NOT NULL, t1 REAL NOT NULL, keyframe_t REAL NOT NULL,
  tier0_version INTEGER, measured  TEXT,          -- JSON or NULL until the tier lands
  tier1_version INTEGER, labelled  TEXT,
  tier2_version INTEGER, described TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (asset_id, content_hash, shot_index)
);
CREATE INDEX shots_by_time ON shots(asset_id, t0);

CREATE TABLE entities (                            -- tier 1 identity clusters
  id TEXT PRIMARY KEY,                             -- person_03
  kind TEXT NOT NULL,                              -- person | setting
  label TEXT,                                      -- user-assigned name, nullable
  centroid BLOB NOT NULL, dim INTEGER NOT NULL, model TEXT NOT NULL,
  shot_count INTEGER NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE asset_digest (
  asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL, digest TEXT NOT NULL, updated_at TEXT NOT NULL
);
```

`visual_spans`, `visual_vectors`, `visual_captions` stay. `visual_captions.text` receives the
`described.summary`; the structured document lives in `shots.described`. Vectors for the
local model use `visual_vectors.model = 'siglip2-base…'`; the existing "never mix models"
rule holds. `captions_fts` indexes `summary + subject + action + setting + onScreenText`.

Invalidation: a changed `content_hash` deletes the asset's shots (as `_index_one_asset`
already does for spans). A bumped `tierN_version` nulls only column N and re-queues that
tier. This is what makes a model swap cheap at scale.

## 5. The tier contract (engine)

One route, one job kind, tiers in the payload. Extend `VisualIndexRequest` rather than adding
a second journaled job:

```python
class VisualIndexRequest(BaseModel):
    ...
    tiers: list[Literal["measured", "labelled", "described"]] = ["measured", "labelled", "described"]
    priority: Literal["timeline", "bin", "all"] = "all"   # which assets first (see 07)
```

Per-tier availability is decided per call, never as a gate on the job:

| Tier      | Available when                                                                                             | Otherwise                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| measured  | ffmpeg resolves                                                                                            | job fails with a typed reason (this is the only hard failure) |
| labelled  | `framepilot.visual-embed` pack installed, or NVIDIA keys (hosted arm, legacy)                              | tier skipped; `asset_digest.coverage.labelled = false`        |
| described | `framepilot.visual-describe` pack installed, or a vision-capable hosted provider with a key, or TwelveLabs | tier skipped; coverage recorded                               |

The per-asset `visual:outcome` row (`brain/visual_outcomes.py`) grows a `tiers` field so the
Settings panel can say "measured 61/61 · labelled 61/61 · described 12/61 (running)".

## 6. The projection join (ai-sdk)

`kernel/semantic-index` gains a `picture` slice built from `ProjectIndex.clipsOfAsset` plus a
**ledger snapshot** the host fetches once per run start and after each apply that adds an
asset (`GET /brain/shots?projectId&assetIds` returns the shots for the assets referenced by
the timeline; bounded; cached by content hash on the host):

```ts
interface PictureSlice {
  /** Every picture clip → the shots it shows, in timeline time. */
  readonly clips: readonly {
    clipId: string;
    trackId: string;
    start: number;
    end: number;
    shots: readonly { shotKey: string; tStart: number; tEnd: number; facts: ShotFacts }[];
    dominant: ShotFacts; // the shot covering most of the clip
  }[];
  /** Adjacent picture clips on the same layer, with the deltas a policy reads. */
  readonly cuts: readonly {
    fromClipId: string;
    toClipId: string;
    at: number;
    delta: {
      luma: number;
      warmth: number;
      sat: number;
      contrast: number; // signed, in fact units
      shotSizeSteps: number; // −6..6 on the ECU..EWS ladder
      sameSetting: boolean | null;
      sameEntities: string[];
      motionChange: 'none' | 'up' | 'down';
      duplicate: boolean; // phash Hamming ≤ 6 → jump cut
      transition: string | null; // existing transition effect kind, if any
    };
    flags: readonly (
      'exposure_jump' | 'wb_jump' | 'jump_cut' | 'size_jump' | 'black_in' | 'soft_in'
    )[];
  }[];
  readonly coverage: { measured: number; labelled: number; described: number; total: number };
}
```

The slice is `f(Project, LedgerSnapshot)` and memoized per snapshot like every other slice.
Speed ramps and trims are honoured through source-time mapping (`clipsOfAsset` already maps
asset time to timeline time for `shots`/`silences`).

## 7. Model surfaces and their budgets

| Surface                           | Content                                                                                                    | Budget                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Clip row (`renderTrackClips`)     | `c12[61–66.4s] · MS man at desk · static · bright warm`                                                    | ≤ 90 chars per shown clip; shown clips already bounded by `maxClipsPerLayer` / focus |
| Project digest (new tiered block) | people, settings, shot-size mix, exposure range, motion mix, low-quality shots, coverage                   | ≤ 600 tokens                                                                         |
| Briefing PICTURE line             | what the last apply changed on screen: "cut at 12.0s now MS→WS, +1.1 stops brighter (flag: exposure_jump)" | ≤ 3 lines                                                                            |
| `get_clips`                       | full `ShotFacts` per clip, provenance marked                                                               | tool result, paged                                                                   |
| `list_edit_boundaries`            | the `cuts` array with deltas and flags                                                                     | tool result                                                                          |
| `describe_footage`                | shots in time order with `described.summary`                                                               | unchanged shape, richer content                                                      |
| `search_visual`                   | ranked shots; local text embedding when the pack is installed                                              | unchanged shape                                                                      |

Rendering rules: `measured` facts print as plain words derived from thresholds
(`bright/dim`, `warm/cool/neutral`, `flat/punchy`, `static/slow/handheld/fast`); `labelled`
facts print with the label only when `p ≥ 0.6`, else omitted; `described` prints `summary`
truncated. Numbers are never printed in a clip row. The model reads words; the solver reads
numbers.

Prefix stability: the digest and rows are deterministic functions of (revision, ledger
snapshot), so they cache like the rest of the timeline slice.

## 8. Solvers

Solvers are pure functions in `packages/editor-core` (numbers in, an existing operation out)
with a measurement step in the engine. See `04-SOLVERS-COLOR-TRANSITIONS.md`.

| Solver                                       | Input                                                  | Output                                                              |
| -------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| `solveColorMatch(target, reference)`         | two `measured` records (or fresh `scope` measurements) | `apply_color_grade` params within `COLOR_GRADE_PARAMETER_CONTRACTS` |
| `solveExposureNormalize(shots[], anchor)`    | a track's shots                                        | one `apply_color_grade` per outlier clip                            |
| `solveLook(intent, amount, baseline)`        | `warmer                                                | cooler                                                              | punchier        | flatter | brighter | darker | cinematic                             | clean`×`subtle             | medium                  | strong` | grade params relative to the measured baseline |
| `chooseTransition(reason, cutDelta, pacing)` | `continuity                                            | time_jump                                                           | location_change | energy  | montage  | soften | reveal` + deltas + median shot length | `{ kind, durationSeconds } | null` (null = hard cut) |
| `rankBroll(candidates, sentence, aRoll)`     | ledger facts + transcript sentence                     | ordered candidates with reasons                                     |

## 9. Verification

After an apply that touches picture, the conductor reads `PictureSlice.cuts` and, for cuts
with flags, requests `comparison: shot_match` / `transition_continuity` through the existing
`temporal-evidence` route (bounded to 4 pairs). Only pairs the numbers cannot decide (for
example `sameSetting: null` with a large `described` disagreement) go to `vision-review` with
≤ 2 frames each. Findings become working-state facts and briefing advisories; an inherited
defect stays an advisory (memory: verification judges the delta). Nothing here renders during
planning.

## 10. Data flow

```
import ──► main.ts import hook ──► POST /brain/visual/index {tiers, priority}
                                       │ paced slices, per-project lock, journaled job
                                       ├─ tier 0: one ffmpeg pass → shots.measured, asset_digest
                                       ├─ tier 1: pack worker → shots.labelled, entities, visual_vectors
                                       └─ tier 2: pack worker / hosted → shots.described, visual_captions, captions_fts
run start ──► GET /brain/shots (timeline assets) ──► LedgerSnapshot ──► semantic-index.picture
turn ──► context-builder rows + digest ◄── picture slice
tool ──► solver (editor-core) ──► existing operation ──► patch ──► apply
apply ──► picture.cuts flags ──► temporal-evidence shot_match ──► (rare) vision-review ──► facts
```

## 11. Security and privacy

- Tier 0 and the local packs never send a byte off the machine. The privacy boundary in
  `docs/guides/media-intelligence.md` §"frames leave the machine" becomes: frames leave only
  on the hosted arms, only with a key, as today.
- Packs install under the existing verified store (`capability-packs/installer.ts`); worker
  media handles are host-resolved and sandbox-checked (`worker-protocol.ts`); no worker resolves
  a project path.
- The ledger is derived data: deleting the brain loses time, never truth (ADR 0058 invariant 1).
- No new IPC surface beyond one `GET /brain/shots` read route and the existing index route's
  new fields.
