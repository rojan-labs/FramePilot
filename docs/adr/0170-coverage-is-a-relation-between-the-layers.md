# ADR 0170 — Coverage is a relation between the layers, not a property of one

- **Status:** Accepted
- **Date:** 2026-09-03
- **Schema:** unchanged. `Asset.media.width`/`height` already exist and are already nullish
  (schema v21, "honestly absent rather than guessed at"). No operation shape changed, no
  tool description changed, so the frozen `streamAgent` golden sessions do not move.
- **Relates to:** ADR 0169 (a full-frame cutaway goes in front — this **supersedes** its
  "Letterboxing is the other known gap" consequence), ADR 0048 (multi-layer compositing at
  export), ADR 0140 (stock media is placed as a cutaway), goal.md Workstream A ("preview and
  final output must agree"), `plan/SCENE-UNDERSTANDING-AND-COMPOSITING.md` §0.2 (`SUC-P1`)

## Context

ADR 0169 shipped `isFullFrameOpaque` and stated its own remaining gap plainly:

> A source whose aspect does not match the project frame is fitted, not filled, so the bars
> are transparent at export and the layer underneath shows through them, while the preview
> paints black.

The obvious fix — hand the predicate the measured source and the frame so it can tell a
cover crop from a letterboxing one — was implemented on 2026-09-03 and **reverted**. It
typechecked in four packages and turned 16 tests red. Reverting it is what found the real
answer, recorded in `TRACKING.md` under "The letterboxing predicate is a relation, not a
property", and it is this:

**A letterboxed overlay is only a divergence if the base shows through its bars.** The
export fits the clip BEHIND with the same arithmetic it fits the clip in front
(`render/compiler.py#_place_video_clip` scales by `min(target_w / w, target_h / h)` after
the crop is cut out, and centres the result). When the two are the same shape — the same
camera, the ordinary case — the overlay's transparent bars sit exactly over the base's
transparent bars. The export blends transparent over transparent and paints black; the
monitor paints black. **They agree, and refusing that placement buys nothing.**

They disagree only when the front clip's fitted rect fails to **contain** the one behind it:
a 1:1 overlay over a 16:9 base in a 16:9 frame leaks the base's left and right edges into
the export while the monitor shows only the overlay.

So the question is not "does this clip fill the frame?" It is a relation between the front
clip, everything it covers, and the frame all three are fitted into. The relation landed in
`3f939da` as `hidesWhatIsBehind`, with two defects that this ADR is mostly about fixing.

## Decision

**`coverageVerdict(front, behind, frame)` in `packages/editor-core/src/picture-occupancy.ts`
is the single answer to "can the monitor show this stack honestly?", and the agent's
placement guard, the canvas preview's eligibility test and the eval rubric all ask it.**

### 1. Exact containment, with one output pixel of slack

"Fills the frame, or shares an aspect with everything it covers" was the first reduction of
containment for centred fits, and it is **stricter than the geometry**. In a 16:9 frame a
4:3 front over a 1:1 base is fitted wider and exactly as tall, so it hides the base
completely — and the aspect test refused it.

Each clip's fitted size is computed the way the export computes it: the crop is a fraction
of the source, so the visible rect is `source × crop`; the fitted size is that rect scaled
by `min(frame.w / rect.w, frame.h / rect.h)`. Both fits are centred, so containment reduces
to `front.w >= covered.w - 1 && front.h >= covered.h - 1`.

The one pixel is **the export's own arithmetic, not a comfort tolerance**. A cover crop is a
rounded fraction (six places), so the rect it cuts is a hair off the exact target aspect and
the fit that follows leaves a sub-pixel sliver that the renderer quantises away. Requiring
exact equality would refuse the very crop written to make a clip cover.

### 2. The crop arm moves out of `isFullFrameOpaque`

`isFullFrameOpaque` began `if (clip.crop !== undefined) return false;`, and
`hidesWhatIsBehind` called it first — so **any** cropped front clip was refused, including
the cover crop `add_clip`'s auto-reframe writes, which is the exact placement the relation
exists to allow. A crop is geometry: it changes how much of the frame the layer paints and
never makes the paint translucent. It is folded into the fitted rect now.

`isFullFrameOpaque` keeps its other four arms — blend mode, keyframes, mask, transition —
and remains the opacity half of the verdict. It also stays in the preview as a **separate**
check on the COVERED clips, which guards something else entirely: a covered clip is sliced
into two runs and the engine derives its clip-relative compositing time from each run's
start, so anything animated underneath reads wrongly. That is a property of the clip
beneath, not a coverage question, and the relation does not replace it.

### 3. `add_clip` computes its crop BEFORE it asks

The order was backwards, and it mattered. `picture.place()` was asked about a bare clip and
the auto-reframe crop was applied afterwards — so a measured landscape source over occupied
picture in a portrait project was refused for leaking bars the crop was about to remove.
The crop is computed first and passed as the candidate's compositing.

Fixed on the way: `autoReframeCrop` resolved the track by the **resolved** lane id, and a
lane the placer had just opened (`video_cutaway_N`) is not in the pre-turn timeline, so the
lookup found nothing, `track?.type !== 'video'` was true, and **a lifted placement never
reframed** — the one case where the source is most likely to be the wrong shape for the
frame. It reads the **named** lane now, which is the lane the portrait-only policy is
actually about.

### 4. The unmeasured policy

**Only a mixed-shape stack of DIFFERENT unmeasured assets is refused.** Two clips of the
same asset with the same crop are identical by construction and qualify whether or not
anyone probed them, which is what keeps a montage cut from one source legal on a project
nobody has measured. A measured clip stacked with an unmeasured one is refused for the same
reason as two unmeasured ones: half a comparison is not one.

Fail-closed is cheap here, and checking is what established that. On the desktop path —
the product's first-class path — **both sides of a real b-roll stack are measured**: the
engine probes a user's own footage when it derives proxies, and
`apps/desktop/electron/media/stock-service.ts` records `width`/`height` on every stock
download (the engine's measurement when it has one, the provider's variant dimensions
otherwise). The refusal's way out is a cutaway hole — split, then place on the same track —
which previews and exports identically **whatever** the shape is, so an unmeasured project
is never stuck.

One boundary leaked, and is fixed here: `packages/ai-sdk/src/stock-placement.ts` parses the
host's `add_stock` payload rather than trusting it, which means it REBUILDS the asset field
by field. It did not name `media.width`/`height`, so an agent-downloaded stock clip reached
the project unmeasured while the Stock panel's identical download did not
(`StockPanel.tsx` keeps them; `shared-types/ipc.ts#StockDownloadedAssetWire` sends them).
Stock media is overwhelmingly 16:9, so a portrait project's b-roll was exactly the case both
the guard and the auto-reframe exist for — and both were disarmed by the absence.

### 5. The refusal is built from the verdict

`nonOpaqueReason` was a second copy of "which test failed first", and a second copy drifts
by starting to name a property the placement does not have. `CoverageVerdict` returns the
reason as data — `blend` / `keyframes` / `effect` / `unmeasured` / `leaks` — with the bar
size in output pixels and, for a leak with a measured front, the exact crop that would close
it. `coverCropFor` puts that crop's maths in `editor-core`, in **both** directions (a wider
source is cut horizontally, a taller one vertically), and `ai-sdk`'s `coverCropForFrame`
delegates to it while keeping its portrait-only **policy**: `add_clip` still declines to
crop a source that is not wider than the frame, because padding a 4:5 still in a 9:16
sequence is a real editorial choice rather than an obvious defect.

A leak refusal names the crop first (it keeps the layered edit the run asked for) and the
cutaway hole second (it changes the edit). An unmeasured refusal **never** suggests a crop —
cropping to a shape nobody measured is a guess, and a wrong guess throws away picture in the
wrong axis — it names the hole and says that `list_assets` will show orientation and aspect
once the engine has measured the source.

## Why not the alternatives

**Keep asking "does the front clip fill the frame?"** It is the wrong question in both
directions: it refuses a same-shape stack that agrees exactly, and it would pass a
full-frame front over a base wider than the frame if such a thing existed. Correctness, not
convenience, is the reason to change it.

**Fail open on unmeasured media.** The failure modes are not symmetric. Wrongly refusing a
placement costs one repositioning and the refusal names the move; wrongly allowing one ships
an export that does not match the frame the user approved, which is the whole thing this
product is trying not to do.

**Do the containment test in the render engine instead.** The engine is not asked before an
edit is made; the guard and the monitor are. Duplicating the fit arithmetic in TypeScript is
the cost of answering at the moment the question is asked.

## Consequences

- The agent can place a reframed landscape source over picture in a portrait project — the
  clip, the front layer and the cover crop in one patch, one undo.
- The canvas compositor now serves letterboxed same-shape stacks it previously handed to the
  DOM player. Same exposure ADR 0169 opened, slightly wider.
- **A second implementation of contain-fit maths exists and was deliberately left alone.**
  `apps/web-editor/src/preview/frame-fit.ts#describeFrameFit` computes a fitted rect for a
  UI notice about bars. It is a different consumer with a different output (prose for a
  person, not a boolean for a guard) and folding them together would couple a cosmetic
  notice to a correctness predicate. If it ever disagrees with `picture-occupancy.ts` about
  a real project, that is the moment to unify them.
- Four ai-sdk fixtures gained measured dimensions matching their own frame. They stacked two
  different assets nobody had probed — the one case the relation refuses — so leaving them
  unmeasured would have graded the unmeasured arm instead of the rule under test.
- **Still divergent, knowingly:** a person can still drag a non-covering layer over picture,
  and a run that places two covering clips and then adds a transition or a punch-in to the
  front one recreates that, because nothing re-tests the verdict after placement. Same-lane
  overlap still has no defined order. These are ADR 0169's list, unchanged.

## Reversal condition

Revert to the property version if a real-media run shows the relation **allowing** a stack
the export renders differently from the monitor — a false negative, not a refusal someone
found inconvenient. A refusal that turns out to be unnecessary is a reason to widen the
relation (measure more, or trust more constructions), not to go back to asking a question
about one clip.
