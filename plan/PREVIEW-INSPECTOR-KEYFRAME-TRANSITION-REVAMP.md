# FramePilot — Preview / Inspector / Keyframe / Transition Revamp

> **Sub-plan of `plan/PLAN.md`.** Sibling of `plan/TIMELINE-REVAMP.md` (which owns
> clips, lanes, tracks, ripple/insert modes) and `plan/TRANSITIONS-PREVIEW-AND-KINDS.md`
> (which owns transition *render* kinds). This doc owns the four surfaces the
> timeline revamp deliberately left alone: **the program monitor, the inspector,
> keyframes end-to-end, and the transition authoring workflow.**
>
> Read `AGENTS.md`, `CLAUDE.md`, and `DESIGN_SYSTEM.md` before working here.
>
> **Legend:** `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked
>
> **Scope decision (2026-07-31, confirmed with maintainer):** full scope
> **including schema changes**. Speed ramps and custom keyframe curves are in, with
> their own ADRs and migrations. Delivery is plan-doc-first, then one commit per
> slice.

---

## 0. North star

> A creator selects a clip and the inspector shows exactly the controls that clip
> can accept — no more. Every animatable property has a diamond next to it. Clicking
> it puts a diamond on the timeline at the playhead, in a lane they can see, drag,
> and ease. Transitions sit *on the cut* as objects you can grab. The picture is the
> biggest thing on screen.

Three properties the finished work must have, in priority order:

1. **Legible.** A user can tell, at a glance and at any zoom, that a clip is
   animated, which properties are animated, and where the keyframes are.
2. **Direct.** Every value is manipulable where the user is already looking —
   on the canvas, on the timeline, or in the inspector — not only in one of them.
3. **Reversible.** Every gesture is one validated patch with an exact inverse.
   Nothing in this revamp bypasses the patch engine.

---

## 1. Grounding — what already exists (do not rebuild)

### Engine (mature, tested — reuse, don't touch)

| Capability                | Where                                                       |
| ------------------------- | ----------------------------------------------------------- |
| Keyframe evaluation       | `editor-core/src/keyframes.ts` — 6 easings, `evaluateKeyframes`, `punchInKeyframes`; Python mirror `effects/keyframes.py`, parity-tested |
| Edit boundaries           | `editor-core/src/edit-boundaries.ts` — `listEditBoundaries`, `transitionEligibility`, `readTransitionAt` |
| Constant speed            | `Clip.speed` (schema v6, ADR 0046); `render/compiler.py::_apply_speed` via `vfx.MultiplySpeed`; validator `speedConsistencyChecks` |
| Transitions               | `add_transition` op, `setTransitionDurationPatch`, `swapTransitionKindPatch`, `removeTransitionPatch`; `render/transitions.py`; live preview `preview/transition-envelope.ts` (ADR 0061) |
| Effect layers             | Schema v13, ADR 0088 — time-ranged layers with their own `keyframes[]` |
| Design tokens             | `packages/ui/src/tokens.css` — dark + light under one set of names |

### UI (the four surfaces this doc rebuilds)

| File                                | Lines | State                                                                 |
| ----------------------------------- | ----- | --------------------------------------------------------------------- |
| `PreviewPlayer.tsx`                 | 1,133 | Monitor, element pool, prepare-on-play gate, 5-button transport        |
| `PreviewViewControls.tsx`           | 156   | Orientation, grade-compare, loop, grid, safe-area, zoom, fullscreen    |
| `PreviewTransform.tsx`              | 226   | Corner-handle move/resize on canvas                                    |
| `Inspector.tsx`                     | 1,049 | 10 flat `<details open>` sections, `ScrubNumber` fields                |
| `TimelineView.tsx`                  | 2,620 | Clips, waveforms, filmstrips, transition pills, keyframe dots          |
| `TransitionPill.tsx` / `Picker.tsx` | 128 / 73 | On-cut pill with drag-resize; kind picker                          |
| `styles.css`                        | 12,336 | Token-driven, hand-authored                                           |

**Key structural fact that shrinks the schema risk:** `EffectSchema.params` is
`z.record(z.string(), z.unknown())` — free-form. Transitions already store their
kind as `effect.params.kind`. **Every new transition property (alignment,
direction, intensity, softness, easing, color) is additive into `params` and needs
no migration.** Only speed ramps and bezier handles need schema bumps.

---

## 2. Diagnosis — findings, ordered by user impact

Grounded in the current code. Each becomes a phase below.

**F1 — The picture is not the hero.** Vertical chrome above and below the canvas
before it gets a single pixel: `.monitor-header` `min-height: 2.75rem` +
`.preview` `padding: 1rem` (top and bottom) + `.transport` `margin-top: 0.7rem` +
`min-height: 2.1rem`. That is ~121px of fixed chrome. On a 900px window with the
timeline dock open, the canvas gets less than half the column.
`styles.css:3187`, `:3134`, `:3582`.

**F2 — There is no scrub bar in the monitor.** The transport is
`transport-nav` (5 buttons) + `transport-time` + `transport-right`. Scrubbing is
only possible on the timeline ruler. Fine-scrubbing a 2-second range means zooming
the timeline. `PreviewPlayer.tsx:1036–1110`.

**F3 — Transport is missing half the professional control set.** No previous/next
edit point (even though `listEditBoundaries` exists and is tested), no playback
speed, no volume/mute, no loop in the transport itself (loop lives in the view
controls, which is a different mental category).

**F4 — Keyframes on the timeline are decoration, not objects.** `clipKeyframeMarkers`
collapses clip *and* effect keyframes into one dot per rounded time, renders them
`aria-hidden`, and attaches no handlers. You cannot select, drag, delete, or
inspect a keyframe from the timeline. `TimelineView.tsx:424–456, 924–931`.

**F5 — Keyframing is a form, not a property affordance.** To animate scale, the
user picks "scale" from a dropdown, types a number, picks an easing, and presses
"Add keyframe" — while the actual scale field sits in the same panel above.
`Inspector.tsx:790, 865, 952–978`.

**F6 — The inspector is a fixed stack, not context-aware.** Sections render by clip
kind checks inline. No multi-select, no mixed-value state, no per-property or
per-section reset, no copy/paste properties, no presets. `<details open>` is
hardcoded, so the collapse state is not remembered across selections.
`Inspector.tsx:107–124`.

**F7 — Transitions have no inspector worth the name.** Selecting a pill selects the
incoming *clip*; the "Transition" section offers kind swap, duration, remove. No
alignment, direction, intensity, easing, or preview. `Inspector.tsx:568`.

**F8 — Speed cannot ramp, reverse, or freeze.** `Clip.speed` is
`z.number().positive()` — so `0` (freeze) and negatives (reverse) are invalid, and
a constant rate cannot ramp. ADR 0046 explicitly deferred the curve and named the
extension path.

**F9 — No custom easing curves.** `Keyframe.easing` is a closed enum; `bezier` is a
hardcoded smoothstep with no control points. `keyframes.ts:36`.

**F10 — Canvas manipulation is move + resize only.** No rotation, no anchor point,
no aspect lock, no snapping, no alignment guides, no reset. `PreviewTransform.tsx`.

---

## 3. Design direction

Extends `DESIGN_SYSTEM.md`. **No new palette, no parallel system.** Additions:

**New tokens** (into `packages/ui/src/tokens.css`, both themes):

```
--kf-diamond          keyframe at rest (text-secondary weight)
--kf-diamond-active   keyframe under the playhead (accent)
--kf-lane-bg          property-lane striping (a step off --track-lane)
--kf-curve            graph-editor curve stroke
--transition-fill     on-cut transition body (muted, distinct from every clip type)
--transition-border
--speed-ramp          speed-curve overlay on a clip
```

**Density contract for this revamp:**

- Monitor header and transport collapse to **28px** rows (from 44px / 34px).
- Icon buttons are **24px** hit-boxes with 16px glyphs, borderless, hover-well only.
- Inspector rows are **28px**; label column fixed at **72px** so every control in
  the panel left-aligns on one axis.
- Radius: 4px on controls, 6px on section cards. Nothing gets 12px except modals.
- Motion 120–180ms, opacity + ≤4px translate. No scale bounce on any handle.

**Chrome recedes.** Keyframe lanes, transition handles, and row reset buttons are
invisible until hover or keyboard focus — but always in the accessibility tree.

**Progressive disclosure.** The graph editor, speed curve, and per-keyframe bezier
handles are all behind a disclosure. A beginner never sees them; a colorist finds
them in one click.

**Explicitly rejected** (from the banned list, stated so reviewers can hold me to
it): no gradient on any clip, transition, or button; no glass/backdrop-blur panels;
no emoji icons; no second accent color; no shadow heavier than the existing
`--shadow-md` on floating layers only.

---

## 4. Schema decisions

Two bumps, both additive, each with an ADR and a migration. Current
`SCHEMA_VERSION = 13`.

### 4.1 v14 — Speed as a curve (`ADR 0089`)

Takes the extension path ADR 0046 pre-blessed, plus the two cases it could not
express.

```ts
// ClipSchema
speed: z.number().optional();          // WIDENED: was .positive()
                                       // 0 ⇒ freeze frame, <0 ⇒ reverse
speedRamp: z.array(SpeedPointSchema).optional();  // NEW — overrides `speed` when present

// NEW
SpeedPointSchema = z.object({
  id: z.string(),
  sourceTime: z.number().nonnegative(),  // clip-relative SOURCE seconds (not timeline)
  rate: z.number(),                      // playback rate at this point
  easing: EasingEnum.default('linear'),  // curve into the next point
});
```

**Why `sourceTime` and not timeline time:** the whole point of a ramp is that
timeline time is the *integral* of the rate over source time. Anchoring points in
timeline time would make them move whenever an earlier point changed.

**The invariant generalizes.** ADR 0046's rule

```
end - start === (sourceEnd - sourceStart) / speed
```

becomes its integral form

```
end - start === ∫ (1 / rate(s)) ds   over s ∈ [0, sourceEnd - sourceStart]
```

with the constant-speed case falling out exactly. This needs **new machinery in
both keyframe engines**: `integrateRate(points, fromSource, toSource)` in
`editor-core/src/speed-curve.ts` and its Python mirror, parity-tested the same way
`keyframes.ts` / `keyframes.py` are. `speedConsistencyChecks` in the validator
switches to the integral form.

**Render.** `_apply_speed` can no longer use `vfx.MultiplySpeed` for ramped clips —
it needs MoviePy's `time_transform` with the inverse-integral mapping (timeline
time → source time). Constant speed keeps the existing fast path. Freeze frame
(`rate == 0`) is a held source frame for the segment. Reverse is a negative-rate
segment. Audio pitch preservation is a **flagged known limitation** for the first
slice — MoviePy has no pitch-independent time-stretch; the honest options are an
FFmpeg `atempo` chain (no new dependency) or dropping audio on reversed segments,
decided in the ADR, never silently wrong.

**New op:** `set_clip_speed_ramp` — same-shape exact inverse carrying the prior
ramp, exactly like `set_clip_speed`. `set_clip_speed` stays and is unchanged.

**Migration v13 → v14:** pure passthrough. A v13 clip has no `speedRamp`, which is
exactly "constant speed", which is exactly its current behavior.

### 4.2 v15 — Keyframe bezier handles (`ADR 0090`)

```ts
// KeyframeSchema
handles: z.object({
  out: z.tuple([z.number(), z.number()]),  // outgoing control point, normalized
  in:  z.tuple([z.number(), z.number()]),  // incoming control point, normalized
}).optional();
```

Only meaningful when `easing === 'bezier'`. Absent ⇒ today's hardcoded smoothstep
(`3t² − 2t³`), so **v14 projects render byte-identically**. `applyEasing` gains a
handle-aware branch; the Python mirror gains the same. Migration is passthrough.

### 4.3 Transition properties — **no schema change**

Additive into the existing free-form `Effect.params`:

```
kind        (exists)
alignment   'center' | 'before' | 'after'   default 'center'
direction   'left' | 'right' | 'up' | 'down' | 'in' | 'out'   (kind-dependent)
intensity   0..1                             default 1
softness    0..1                             (blur/wipe only)
easing      Easing                           default 'ease-in-out'
color       hex                              (dip-to-color only)
```

`render/transitions.py` and `preview/transition-envelope.ts` both learn to read
them, defaulting to today's behavior when absent. **Both must move together** —
the render-vs-preview rule means the preview may approximate, but it may never
imply a capability the render lacks.

---

## 5. Phases

Each phase is one commit (or a short numbered series), ends green on
`pnpm verify`, and updates `plan/PLAN.md`, `CHANGELOG.md`, and docs.

### Phase 1 — Preview workspace density `[x]`

**DONE (2026-07-31).** `--monitor-row-h: 28px` / `--monitor-btn-size: 24px` are the
density contract, declared once at `:root` (alongside `--splitter-w`) because three
monitors — program, source, WebCodecs — share the band classes and must stay in
step. Chrome above the picture went 44px → 28px, the band below 34px + 11px margin
→ 28px + a hairline, and `.preview`'s 1rem top/bottom padding moved onto
`.preview-stage` so both bands are full-bleed. Net: **~121px of fixed chrome → 64px**.
The stage inset is `padding`, not `margin`, on purpose — the stage is the
`container-type: size` context, so cqw/cqh resolve against its content box and the
inset comes out of the frame's budget automatically. Glyphs are sized to 16px (18px
for play, the band's only emphasis) by a CSS rule on `.transport-btn svg` rather
than per-call-site `ICON_SIZE`, so the three monitors cannot drift. The WebCodecs
transport is a genuine two-row band, so it opts out of the height lock explicitly
(`height: auto` + both rows from the contract) instead of being crushed by it.
`.transport-right`'s floating offsets, the orientation/zoom `Select` triggers, and
`.source-scrubber`'s inset were all re-based off the same tokens — each had
hard-coded the 1rem padding that no longer exists.

Fixes **F1**. Presentation only, no logic.

- Collapse `.monitor-header` and `.transport` to the 28px density contract; drop
  `.preview` padding to `var(--space-1)` and remove `.transport` `margin-top`.
- Single chrome band above the canvas (tabs + view controls), single band below
  (transport). Nothing else competes for vertical space.
- Verify the canvas holds its size across clip changes and aspect switches —
  `.preview-frame` already uses `container-type: size` + `cqw/cqh`, so the fix is
  removing what fights it, not adding.
- Portrait/square parity: 9:16 in a wide stage must not letterbox into a sliver.

**Files:** `styles.css`, `PreviewPlayer.tsx` (markup only).
**Tests:** extend `PreviewPlayer.monitor.test.tsx` — no layout shift across an
aspect change; existing 724 web-editor tests stay green.

**Tested (and what could not be):** jsdom has no layout engine, so "the canvas got
bigger" is not assertable in the unit suite — that is a CSS outcome to be judged
against the real desktop app. The three new cases assert the *structure* that gives
the picture its budget, which is what actually regresses: the transport is a
sibling band of the stage (never nested inside the frame's sizing container), the
frame carries no inline pixel width/height/transform (nothing fights
`container-type: size`), and an aspect change re-uses the same frame node with an
unchanged control set (16:9 ⇄ 9:16 reflows, it does not restructure). Suite: 104
files / 1779 tests green (the doc's "724" predates later growth); `tsc` and
`eslint` clean.

### Phase 2 — Preview toolbar + playback transport `[x]`

**DONE (2026-07-31).**

> **⚠ Correction to §1's file inventory, found while starting this phase.** This
> doc lists `PreviewPlayer.tsx` (1,133 lines) as "Monitor, element pool,
> prepare-on-play gate, 5-button transport" and Phase 2's **Files** line names it.
> That is **stale**: `Editor.tsx:744` mounts `WebCodecsPreviewPlayer`, not
> `PreviewPlayer` — the single-engine change (commit `5cd2388`, CHANGELOG
> "WebCodecs is now the sole program-monitor engine") landed *before* this doc was
> written but the inventory was not updated. `PreviewPlayer` now survives only
> inside `AiReviewPlayer`, whose CSS sets `.ai-review-player .transport {
> display: none }` — so **`PreviewPlayer`'s transport renders nowhere at all.**
>
> Phase 2 therefore targets `WebCodecsPreviewPlayer` (the product path,
> desktop-first per CLAUDE.md) and leaves `PreviewPlayer` alone. Phases 3–14 should
> read "the program monitor" as `WebCodecsPreviewPlayer`. It also means part of
> **F2** was already half-true: that monitor *did* have a stepped
> `<input type=range>` seek — what it lacked was a pointer-accurate one that shows
> where the edits are.

**Shipped.** Two new shared components behind two new 100 %-covered pure modules:

- `preview/scrub.ts` — pointer↔time arithmetic (`timeAtPointer`, `fineScrubTime`,
  `snapToEditPoint`, `quantizeToFrame`), split out because the interesting
  behaviour of a scrub bar is the arithmetic, not "did the handle move".
- `editor/edit-points.ts` — `listEditPoints`/`prevEditPoint`/`nextEditPoint`.
- `PreviewScrubBar.tsx` — full monitor width, pointer-accurate, drag-to-scrub,
  Shift for a damped fine scrub that **re-anchors mid-gesture** (so flipping
  coarse↔fine never teleports the playhead), snaps to edit points with Alt to
  invert, cut ticks from the project's own edits, `role="slider"` with
  arrows/Shift-arrows/Home/End.
- `PreviewTransport.tsx` — jump-to-start · prev edit · prev frame · play/pause ·
  next frame · next edit · jump-to-end · loop · mute · volume · `current / total`.

**Deviation — prev/next edit point is NOT `listEditBoundaries`.** The brief says to
wire it "straight to `listEditBoundaries`". That function answers a *transition*
question, so by design it returns only **abutting** cuts on one track — a gap or an
overlap "is not a clean cut and is not offered as a transition point" (its own
module note). Navigation asks a broader question, so wiring it there would silently
skip the first clip's start, the last clip's end, and **both edges of every gap**:
on any timeline with a gap the button visibly refuses to stop at edits the user can
see. `listEditPoints` derives the navigation set from the timeline instead, and the
gap cases are asserted explicitly so a future "simplification" back onto the
boundary list fails loudly. `listEditBoundaries` remains right for Phase 8.

**Deferred, deliberately — playback speed.** A speed control needs the preview
engine to support a playback rate, and that engine is *audio-master clocked*: a
rate means resampling scheduled `AudioBufferSourceNode`s (which shifts pitch) plus
rate-aware frame selection and decode-ahead. The pitch question is exactly what
**ADR 0089** is being written to decide for speed ramps, and this doc's own rule is
that nothing in Phase 10 starts before that ADR is accepted. A dropdown that
silently did nothing would break the render-honesty rule, so speed lands with
**10c**, behind the decision. Tracked in §5 Phase 10.

**Deferred, with a reason — the toolbar's overflow menu, "background", "quality".**
The brief wants grid/safe-zone/quality/background folded into an overflow menu at
narrow widths via the `@container preview` query. A container query can only *hide*
controls, not relocate them, so using it would remove access rather than defer it;
a real overflow needs `ResizeObserver` measurement. After Phase 1's density work
the band holds all six controls plus two selects in ~270 px, so the machinery has
no problem to solve yet — revisit with evidence from the real app rather than
speculatively. "Background" and "quality" controls do not exist in the codebase at
all and were not invented, for the same render-honesty reason as speed. What *did*
move: **loop left the view controls for the transport** (it is playback, not a view
option); `PreviewViewControls`' `loop`/`onToggleLoop` are now optional so surfaces
without the shared transport keep it.

**Monitor volume is real, not decorative.** `AudioMasterClock` gained a master
`GainNode` (every scheduled source connects to it instead of `ctx.destination`, so
the control applies to audio *already playing*); the engine gained `setVolume`,
which retains the value because the audio bus is created lazily on first load; and
`PreviewAudioMixer` gained a `monitorVolume` scale so audio-only clips obey the
same control. Level and mute are **separate** persisted preferences, so un-muting
restores the user's level instead of jumping to unity. Monitoring only — never the
project, never a patch, never the render (invariant 5).

**Shortcuts.** `⇧↑`/`⇧↓` = prev/next edit point. Premiere and Resolve use bare
Up/Down, but those are already "select clip on track above/below" here. Loop and
mute got **no** chord: `L` is "play forward" (J/K/L shuttle) and `M` is "toggle
marker", and their tooltips deliberately claim no shortcut rather than a key that
does something else.

**Test-environment fix (discovered, and it mattered).** jsdom implements no
`PointerEvent`, so `fireEvent.pointerDown(el, { clientX, button, pointerId })`
falls back to a plain `Event` and **every init property arrives at the handler as
`undefined`**. Five test files had each grown a local workaround; two of them used
`PointerEvent = MouseEvent`, which rescued `clientX` but left `pointerId`
undefined — so their multi-pointer guards were satisfied only by
`undefined !== undefined`. `src/test-setup.ts` now installs a real `PointerEvent`
subclass of `MouseEvent` plus pointer-capture no-ops, and the lossy alias in
`PreviewTransform.test.tsx` is gone. **Without this, no scrub-bar or canvas-gesture
test could assert anything** — relevant to Phase 3, which is all gestures. The
three `FakePointerEvent` copies in the `TimelineView`/`ScrubNumber` specs are
already correct and were left alone; de-duplicating them is a follow-up.

Fixes **F2**, **F3**.

- **Toolbar (upper band):** Source/Program tabs · aspect · background · grid ·
  safe zone · fit/fill/zoom · fullscreen · quality · compare. Frequent controls
  visible; grid/safe-zone/quality/background fold into one overflow menu at
  narrow widths (the existing `@container preview` query is the mechanism).
- **Transport (lower band):** jump-to-start · prev edit point · prev frame ·
  play/pause · next frame · next edit point · jump-to-end · loop · speed ·
  volume/mute · `current / total`.
- **Scrub bar** spanning the monitor width: pointer-accurate, drag-to-scrub,
  shift-drag for fine scrub, keyboard accessible. Reuses `listEditBoundaries` to
  render cut ticks so the user can see where the edits are while scrubbing.
- Prev/next edit point wire straight to `listEditBoundaries` — no new engine work.

**Files (as built):** new `PreviewTransport.tsx`, `PreviewScrubBar.tsx`,
`preview/scrub.ts`, `editor/edit-points.ts`; `WebCodecsPreviewPlayer.tsx` (its own
transport removed), `PreviewViewControls.tsx`, `PreviewAudioMixer.tsx`,
`preview/clock/audio-clock.ts`, `preview/engine/webcodecs-preview-engine.ts`,
`editor/useSettings.tsx`, `editor/shortcuts.ts`, `icons.tsx`, `styles.css`,
`test-setup.ts`; e2e `preview-webcodecs-p1/p2/p3.spec.ts` retargeted.
**Tests:** new `PreviewTransport.test.tsx` (16), `PreviewScrubBar.test.tsx` (19),
`scrub.test.ts` (20), `edit-points.test.ts` (13), plus settings-merge and
`useShortcuts` cases. Suite **108 files / 1851 green**; both new pure modules at
**100 %** stmts/branch/func/line; `PreviewTransport.tsx` 100 %,
`PreviewScrubBar.tsx` 100 % bar the two pointer-capture `catch` bodies (v8-ignored
with the reason: only a stale pointer id throws). Root `pnpm typecheck`, `pnpm
lint`, and the e2e specs' `tsc` all clean.

### Phase 3 — Canvas direct manipulation `[x]` (3-3 anchor split out)

> **⚠ Two more corrections to the diagnosis, found on starting this phase.**
>
> **1. F10 understates it.** F10 says canvas manipulation is "move + resize only".
> On the *product path* it is **nothing at all**: `WebCodecsPreviewPlayer` renders
> no `PreviewTransform`, no `.preview-select-hit` and no `PreviewTextEditor`. Those
> live in `PreviewPlayer`, which is not the program monitor (see Phase 2's
> correction). So Phase 3 is not "extend `PreviewTransform.tsx`" — it is porting
> on-canvas manipulation onto the real monitor *and then* extending it.
>
> **2. A pre-existing preview/render divergence blocks an honest rotation handle.**
> The export has rendered `rotation` and `opacity` keyframes since Phase 5
> (`_place_video_clip`'s `rotated()`, `_attach_mask`'s opacity), but the canvas
> compositor only ever evaluated `scale`/`x`/`y`. A clip with rotation keyframes
> **exported rotated and previewed flat.** That is the render-vs-preview rule
> inverted, and in the worse direction: the preview may *approximate* the render,
> but here it was hiding a capability the render has, so what you saw was not what
> you got. Adding a rotation handle on top of that would have shipped a control
> whose result you cannot see.

**3-1 — preview/render transform parity `[x]` (2026-07-31).** New
`preview/picture-transform.ts` (`pictureTransformAt`, `rotationToCanvasRadians`),
100 % covered, and the compositor now routes through it. Rotation and opacity
composite in the preview, in the export's order (`translate → rotate → scale`
declared, which takes a source point through scale → rotate → position, mirroring
`resize → rotated(expand=False) → with_position`), with the clip's opacity times the
transition's as one alpha (mirroring `_attach_mask`'s single mask).

**The rotation sign is negated on purpose.** MoviePy's `rotated()` turns
**anticlockwise** for a positive angle (its own docstring); canvas `rotate()` turns
**clockwise** in a y-down space. Unnegated, the preview would have rotated the
opposite way from the export.

**Confidence, stated honestly.** The sign comes from reading MoviePy's `Rotate.py`
docstring and the order from reading `_place_video_clip` — both are *code reading*,
not pixel verification. `pictureTransformAt` is unit-tested, but the composited
canvas result is only checkable in a browser (jsdom has no
`CanvasRenderingContext2D`). **Follow-up: add a Playwright pixel spec that rotates a
clip 90° and asserts preview and export agree on the direction** — the existing
`preview-webcodecs-p3.spec.ts` pixel harness is the place for it. Not written here
because an unrun pixel spec is a guess with a green tick on it.

Fixes **F10**. Extends `PreviewTransform.tsx`.

Rotation handle · anchor-point handle · aspect lock toggle · snapping to
centre/edges/thirds/other elements · live alignment guides · double-click to focus
edit · reset to default. Modifier keys: `Shift` constrains, `Alt` scrubs from
anchor, holding a snap-defeat key suspends snapping mid-drag.

Every gesture commits **one** patch on pointer-up (not per-frame), through
`setClipTransformPatch`.

**Files:** `PreviewTransform.tsx`, new `preview/snapping.ts` (pure, 100% cov).
**Tests:** `PreviewTransform.test.tsx` extended; `snapping.test.ts` new.

**3-2 — the manipulation itself `[x]` (2026-07-31).** Ported onto the real monitor
and extended. The coordinate worry in the note below turned out not to bite: the
canvas buffer carries the project aspect and fills `.preview-frame`, so the frame
rect *is* the project canvas area and the retired player's percent-based math
transfers unchanged, needing no measuring.

- **Select-hit + transform box on `WebCodecsPreviewPlayer`.** Handles appear only
  when the selected clip is the one the monitor is *showing* — a box framing a clip
  the monitor is not displaying would point at nothing. Derived from
  `editor.state.playhead` (the reducer's committed position), **not** the live clock:
  the clock deliberately bypasses React so the canvas owner is not re-rendered every
  display frame, and subscribing would undo that. Stale only during playback, which
  is exactly when nobody is dragging handles.
- **Live drag preview through keyframes.** The compositor draws from keyframes, not
  a CSS transform like the retired DOM player, so `withBaseTransform` expresses the
  override *exactly* as `setClipTransformPatch` will commit it — the picture cannot
  jump on release. It rides the existing `compositingSignature` → `applyCompositing`
  refresh, so a drag never reloads a decoder.
- **Rotation handle** on a stalk above the box (round, where the corners are square:
  shape distinguishes them, not colour). `setClipTransformPatch` widened to
  `'scale' | 'x' | 'y' | 'rotation'`; no schema change (`Keyframe.property` is
  `z.string()`). Live degree readout while rotating — a rotation you cannot read is
  a rotation you cannot match on a second clip.
- **`preview/snapping.ts`** (100 % covered): per-axis snapping to frame centre,
  thirds and edges, so "centred horizontally, flush to the bottom" is expressible.
  Edge targets derive from the box size, so they track the zoom. Scale is never
  snapped — there is no "correct" zoom the way there is a correct centre. Guides
  drawn across the whole frame (a guide clipped to the box would say nothing) and
  only mid-gesture.
- **Modifiers.** `Shift` constrains — a move locks to the dominant axis (resolved
  from *pixels*, since the user means the direction their hand is moving, which on a
  non-square project disagrees with project units), a rotation steps 15°. `Alt`
  **inverts** snapping, matching `EditorSettings.snapping` and the Phase 2 scrub bar.
- **Reset** replaces the impossible aspect-lock toggle. Hover-revealed, but always in
  layout and the accessibility tree.

**The rotation gesture subtracts the sweep.** Screen space is y-down so `atan2`
increases clockwise, while project rotation is anticlockwise-positive; adding it
would spin the clip opposite to the hand moving it. Asserted directly.

**Tests:** `snapping.test.ts` (18, 100 %), `PreviewTransform.test.tsx` extended to 29,
`picture-transform.test.ts` to 21, new `WebCodecsPreviewPlayer.transform.test.tsx`
(8) — the last of these exists because *nothing* unit-tested this monitor before, so
the affordance could disappear again unnoticed. Suite **111 files / 1918 green**;
typecheck and lint clean.

**Original 3-2 plan, for the record** — two of the brief's named features were
re-scoped because the engine cannot render them today:

1. **Port on-canvas manipulation onto the real monitor.** `WebCodecsPreviewPlayer`
   needs the select-hit and the transform box. Non-trivial coordinate work: the
   handles live over `.preview-frame`, but the picture is a `<canvas>` inside
   `.webcodecs-preview` whose buffer is capped at `CANVAS_MAX_EDGE` — so pointer px
   → frame fraction → project px is a two-step conversion, not `PreviewPlayer`'s
   one-step (its `<video>` filled the frame, which is exactly why its percent-based
   math needed no measuring). `pictureTransformAt` already owns the reverse
   direction and should be the single source for both.
2. **Rotation handle.** Renderable (`rotation` is in `evaluate_clip_transform` and
   now previews correctly, 3-1). Needs `setClipTransformPatch` widened from
   `'scale' | 'x' | 'y'` to include `'rotation'` — a one-line type change plus
   tests, no schema change (`Keyframe.property` is `z.string()`).
3. **Snapping + live alignment guides + reset**, in a pure `preview/snapping.ts`.
   Snap targets: frame centre, edges, thirds. **Not** "other elements" in the first
   cut — one picture segment is active at a time in this compositor, so there are no
   sibling pictures on the canvas to snap to; overlays are a separate layer.
   `Alt` inverts, matching `EditorSettings.snapping` and Phase 2's scrub bar.

**⚠ Deferred — the anchor-point handle needs render support first.** The render's
transform vocabulary is `scale`/`x`/`y`/`rotation`/`opacity`
(`effects/transform.py::evaluate_clip_transform`); there is **no anchor/origin**.
Rotation is about the clip's own centre (`rotated(..., expand=False)`) and scale is
about centre too. An anchor handle would therefore be a control with no effect on
the export — the render-honesty rule again. Doing it properly means adding
`anchorX`/`anchorY` to the Python transform, the compiler's position/rotation math,
and `pictureTransformAt`, with parity tests — a real engine slice, not a UI one. It
needs its own ADR (there is a genuine design choice: anchor in frame fractions vs
project pixels, and whether it is animatable). **Recommend splitting it out as
`3-3`** rather than smuggling it into a UI phase. No schema bump either way.

**⚠ Re-scoped — "aspect lock" has nothing to lock.** The engine's transform is a
**uniform** `scale`; there is no separate scaleX/scaleY, and `PreviewTransform`'s
own header already records why ("non-uniform stretch is intentionally not offered
because the render cannot produce it"). Aspect is therefore *always* locked and a
toggle would be a no-op switch. The useful control in its place is **"reset
transform"**, which is in the list already. If non-uniform scale is genuinely
wanted it is a render feature request with its own ADR, not a canvas affordance.

### Phase 4 — Inspector architecture `[x]` (2026-07-31)

**DONE.** The 1,049-line god-component is now a **shell over data**: 385 lines of
shell plus 13 focused modules (~2,300 lines total, all of it addressable).

- **`inspector/selection.ts`** answers "what is selected?" once, purely — replacing
  `if`s scattered through the render (`track.type === 'audio' || 'video'` here,
  `textEffectOf(clip)` there, an early `return` for effect layers near the top).
  Clips come back **primary-first**, because `selectedIds` order is not primary order
  and single-value controls must keep editing the primary. `hasText`/`hasAudio` use
  **every**, not **some**: a section only part of the selection can accept would
  silently no-op on the rest.
- **`inspector/registry.ts`** lists the sections as data (`id`, `title`, `label`,
  `order`, `defaultOpen`, `appliesTo`) and the shell renders
  `visibleSections(selection).map(...)`. Adding a section is a data edit plus a body
  component; reordering is changing a number. `order` is sparse (10, 20, 30…) so a
  section slots in without renumbering, and `visibleSections` **sorts** rather than
  trusting array order, so `order` genuinely is the contract. Ids are persisted, and
  that is documented at the type: renaming one resets everybody's collapse state.
- **`inspector/useSectionState.ts`** persists open/collapsed per section id in
  `EditorSettings.inspectorSections`. This was a real bug: `<details open>` hardcoded
  the attribute, so a section you collapsed re-opened on the next selection change.
  An absent key falls back to the registry default, so a newly added section arrives
  expanded for existing users rather than silently closed, and the stored blob holds
  only what was actually chosen. The map is the one *open* record in the settings
  shape, so it gets a hand-written narrow coercion — `{ transform: "yes" }` must not
  reach a `<details open>`.
- **`inspector/mixed.ts`** — shared-or-mixed reads with an em-dash indicator.
  Compares with `Object.is`, so two `NaN`s read as the same fact rather than sending
  the user hunting for a difference. An empty selection is *mixed*, not a fabricated
  default.
- **`inspector/clipProperties.ts`** — one model behind copy / paste /
  apply-to-selected / reset-all, so the four cannot disagree about what a clip's
  "look" is. **Timing, transitions, text content and animation past time 0 are
  deliberately excluded**, each with the reason at the definition. Every write merges
  the individual builders' operations into **one** patch: pasting six properties onto
  four clips is one undo step, because it was one user action.
- **`inspector/InspectorRow.tsx` / `InspectorSection.tsx`** — the 28px row with the
  72px label column (so every control aligns on one axis), hover-revealed per-property
  and per-section reset that stays in layout and in the accessibility tree, and the
  mixed indicator with a screen-reader equivalent (an em-dash conveys nothing aloud).
- **`inspector/sections/*`** — one file per section, controls only. Title, label,
  order and open state come from the registry, so the section files no longer each
  restate them.

**Bug found and fixed while testing.** `applyClipPropertiesPatch` claimed to return
`null` for a no-op, but **none** of the underlying builders compares against the
clip's current value — each returns a patch whenever the clip merely exists, because
each one's normal caller is a control the user has just moved. "Reset all" on an
already-default clip therefore produced a patch that changed nothing and still
consumed an undo step. The comparison now lives in the one function that has both
sides. Related: `ClipProperties.speed` is the **effective** rate (1 = native, what
`clipSpeed` reports), not `number | null` — holding null made an untouched clip differ
from its own identity.

**Test-environment note.** jsdom's `<details>` only reliably reports the
open→closed direction from a summary click, so the persistence case drives the
`toggle` event directly; what is under test is the handler and the write, not jsdom's
disclosure widget.

**Deferred — save-as-preset.** The brief lists it among the row affordances, but a
preset needs somewhere to live and a way to be previewed, which is Phase 11's
subject. Building a preset store here would mean two of them.

**Tests:** new `inspector/inspector-architecture.test.ts` (26 — the registry rules
that used to be untestable inline `if`s) and `Inspector.selection.test.tsx` (16 — the
context-awareness matrix, persisted collapse across a selection change, and each
whole-selection action producing exactly one undo step). Suite **113 files / 1960
green**; typecheck and lint clean. The pre-existing inspector tests pass untouched,
because the registry preserves every section's `aria-label`.

Fixes **F6**. The largest pure-UI slice — decomposes a 1,049-line file.

- **Section registry.** Each section declares `{ id, title, appliesTo(selection),
  order, defaultOpen }`. The inspector renders `sections.filter(s =>
  s.appliesTo(selection))`. Adding a section stops meaning editing a god-component.
- **Selection model.** `none | clip | multi-clip | transition | effect-layer |
  caption | text | audio`. Drives which sections appear and the empty state.
- **Mixed values.** Multi-select shows shared properties with a `—` mixed
  indicator; editing one commits to all selected clips as a single patch.
- **Open/closed persistence** per section id, in the existing settings store.
- **Row-level affordances:** hover-revealed reset per property, reset per section,
  reset-all, copy properties, paste properties, apply-to-selected, save-as-preset.
- Split into `inspector/` — `sections/BasicSection.tsx`, `TransformSection.tsx`,
  `SpeedSection.tsx`, `AudioSection.tsx`, `ColorSection.tsx`, `TextSection.tsx`,
  `CropSection.tsx`, `BlendSection.tsx`, `MaskSection.tsx`, `EffectsSection.tsx`,
  `TransitionSection.tsx`, plus `InspectorRow.tsx` and `useSectionState.ts`.

**Tests:** one test file per section + `Inspector.selection.test.tsx` for the
context-awareness matrix and mixed-value behavior.

### Phase 5a — `remove_keyframes`, the missing engine op `[x]` (2026-07-31)

**DONE — and it unblocks Phases 5, 6, 7 and 12.** Maintainer sign-off for widening
the operation vocabulary was given on 2026-07-31 ("complete all the phases end to
end"), which is what the blocker note below was waiting on.

`RemoveKeyframesOp` in `editor-core/src/operations.ts` and its Python mirror
`RemoveKeyframes` in `timeline/operations.py`, registered in both validators'
`SUPPORTED_OPERATIONS`. **No schema change** — `Keyframe` and `Clip.keyframes` are
untouched, so no migration and no version bump.

**Keyframes are matched by property + time, not by `id`.** Ids are generated by
whichever producer built the keyframe (`kf_<clip>_<prop>_<ms>`, `preview_base_*`, the
punch-in generator, a Python-side write) and are not a stable handle a UI can rely
on. Property-and-time is what a user is actually pointing at when they click a
diamond, and it is stable across every producer. A target with **no** `time` clears
that property entirely — "clear this property's animation" without the caller
enumerating times it may not know.

**The time epsilon is shared with `add_keyframes`' `replace`** (`±1ms`), deliberately:
if the two disagreed, a set-then-clear on one inspector diamond would leave a stray
keyframe a millisecond away from where the user clicked.

**A no-op removal returns the same timeline object** (reference-identical), so it
cannot masquerade as a change to memoised selectors or signature guards.

**Reversibility is free.** A removal is lossy, so like almost every op here it inverts
to a `restore_clips` snapshot of the clip's track — `invertOperation` reads the
pre-state, so the op does not need to carry the removed keyframes.

**Not exposed as an AI tool.** The op is available to the patch engine and the UI;
adding it to the tool registry would widen the *agent's* permission surface, which is
a separate decision under `CLAUDE.md` §5 and was not part of this sign-off.
`describe.ts`'s `ACTION_LABELS` (keyed by operation type, used in undo history) gained
an entry; `TOOL_VERBS` and `toolMeta` (keyed by *tool* name) deliberately did not.

**Bug found while wiring the mirror.** The Python model used `ConfigDict(...)`, which
is not imported in that module — the whole test suite failed to *collect*. House style
there is the plain `{"populate_by_name": True}` dict; matched it.

**Tests:** 6 TS cases in `operations.test.ts` and 7 mirrored Python cases in
`test_operations.py`, each round-tripping `apply` → `invert` → original. The
move-a-keyframe composition (remove + add) is asserted on both sides, because that is
the case Phase 6's drag depends on. editor-core **520 green**, engine **114 green**.

### Phase 5 — Property-level keyframes in the inspector `[x]` (2026-07-31)

**DONE.**

> **⚠ A third correction to the diagnosis, found on building this phase.** F5 says
> keyframing is "a form, not a property affordance", and that the user picks a
> property from a dropdown "while the actual scale field sits in the same panel
> above". **There was no scale field.** The Transform section contained a read-only
> `<li>` dump of every keyframe, a punch-in form, and the add-keyframe form — and
> nothing else. There was nowhere in the entire inspector to see or set a clip's
> scale, position, rotation or opacity; the only route to them was dragging on the
> canvas. So Phase 5 is not "put a diamond next to the existing field" — **the fields
> had to be built first.**

**The rule the whole phase turns on.** A property that is not animated has a **base
value**; a property that is animated has a **curve**.

- Editing a **non-animated** property moves the base (time 0) and starts no
  animation — the playhead is irrelevant. Otherwise scrubbing somewhere and nudging
  scale would silently animate the clip.
- Editing an **animated** property writes a keyframe **at the playhead**, and the row
  says so (`+kf`, plus a screen-reader sentence) **before** the user commits.

That is the contract After Effects states with its stopwatch, and it is decided in
exactly one place — `keyframe-state.ts`'s `willCreateKeyframe`.

**Shipped.**

- **`inspector/keyframe-state.ts`** (pure, 19 tests). `keyframeStateAt` answers all
  four derivable diamond states, the neighbouring keyframe times for the chevrons, and
  the curve value at the playhead. `ANIMATABLE_PROPERTIES` is exactly
  `evaluate_clip_transform`'s set (`scale`/`x`/`y`/`rotation`/`opacity`), asserted by a
  test: **a diamond on a property the render ignores would animate the preview and not
  the export.** Clip **volume** is deliberately absent — audio gain is an effect param,
  not a keyframed property, so there is no curve for a diamond to write.
- **`KEYFRAME_REPLACE_EPSILON` is now exported from `editor-core`.** The UI has to
  agree with the engine about what "at this time" means; with two tolerances the
  diamond would read empty while `replace: true` swapped an existing keyframe. One
  constant, one answer.
- **`inspector/useKeyframeState.ts`** — the fifth state, the 150ms pulse, which is the
  only genuinely stateful one. Driven off a **signature of the keyframes' times,
  values and easings**, not off the click handler, so it also fires for writes that did
  not originate in the row (a canvas drag, an undo, an AI patch) — precisely when the
  user most needs telling where the change landed. Never on first render: arriving at
  an already-animated clip is not a change, and a panel that flashes every row on
  selection is noise.
- **`inspector/KeyframeButton.tsx`** — diamond plus prev/next chevrons as one
  `role="group"`. States are conveyed by **fill and ring, not hue** (solid = keyframe
  here, ringed = animated elsewhere) and every one is also in the accessible name,
  because a screen-reader user gets no fill at all. **The chevrons only seek** — they
  move the playhead and write nothing, so navigating an animation is never an edit.
  Disabled rather than hidden at the ends, so the row's controls do not jump sideways
  as you navigate.
- **`inspector/sections/TransformSection.tsx`** — the five rows that did not exist,
  each with a value field and a diamond. Punch-in stays (a preset is a different thing
  from a keyframe form); the add-keyframe form is gone.
- **Four new patch builders** — `setKeyframeAtPlayheadPatch`, `removeKeyframePatch`,
  `moveKeyframePatch`, `setKeyframeEasingPatch`. `moveKeyframePatch` is **one patch of
  two operations** (remove + add), which is what makes Phase 6's keyframe drag one undo
  step; two patches would leave a press of undo showing the keyframe deleted but not
  restored, which reads as data loss. A move keeps the keyframe's own easing —
  resetting it to linear on a drag would quietly flatten the user's animation.
- **`InspectorRow` gained a `keyframe` slot**, a `ReactNode` rather than a
  `KeyframeState` prop: rows exist for plenty of properties the engine cannot animate
  (blend mode, duck target), and teaching the row about keyframes would make every one
  of them carry a concept it has no use for.
- **`ClipTransformProperty` widened to include `opacity`**, so the opacity row's base
  write goes through the same builder. The canvas handles still never write it (there
  is no opacity handle), and the render has composited animated opacity since Phase 6.

**Reset means reset.** Clearing every keyframe for a property *is* the reset, in one
patch: the base is itself a time-0 keyframe, and a property with no keyframes evaluates
to its identity. Writing an identity keyframe afterwards would be a redundant second
undo step storing a value that means "none".

**Bug found while testing.** `ScrubNumber`'s `defaultValue` reset and `InspectorRow`'s
reset render with the **same accessible name** and do different things — the field's
would restore the value and leave the animation in place, so the property would spring
back the moment the playhead moved. The Transform rows now pass no `defaultValue`: one
reset per row, and it is the one that knows about keyframes.

**Three pre-existing tests asserted the retired form** (`panels.test.tsx` ×2,
`coverage.test.tsx` ×1) and were rewritten against the new affordance rather than
deleted — each still proves the same *user-facing* fact (a punch-in animates scale, a
property can be animated, the inspector surfaces a clip's animation), just through the
control that now exists.

**Tests:** `keyframe-state.test.ts` (19, pure), `KeyframeButton.test.tsx` (22 — the
five states, the toggle both ways, chevrons-do-not-edit, and the base-vs-playhead
branch asserted directly), and 19 new patch-builder cases. Suite **115 files / 2017
green**; typecheck and lint clean.

> **⚠ BLOCKER (RESOLVED by 5a above, 2026-07-31): the engine could not DELETE a
> keyframe.** Kept for the record — the reasoning is why 5a exists.
>
> Phase 5's **Files** line names `removeKeyframePatch` and `moveKeyframePatch` as if
> they were patch-builder work. They are not — there is **no operation in the engine
> that removes a keyframe.** The full operation vocabulary
> (`editor-core/src/operations.ts`) is:
>
> ```
> add_caption_layer add_clip add_effect_layer add_keyframes add_layer add_mask
> add_text_overlay add_transition adjust_audio apply_color_grade delete_range
> move_clip move_effect_layer move_layer object_track remove_effect_layer
> remove_layer restore_clips restore_effect_layer ripple_delete set_caption_cue
> set_caption_style set_clip_blend_mode set_clip_crop set_clip_speed
> set_effect_layer_enabled set_effect_layer_params set_effect_params
> set_track_caption_style set_track_flags split_clip track_object trim_clip
> trim_effect_layer
> ```
>
> `add_keyframes` has a `replace` flag, but it only swaps a keyframe with the **same
> property at the same time (±1ms)** — it cannot delete one, and it cannot move one
> (a move is a delete at the old time plus an add at the new).
>
> **This blocks four phases, not one:** Phase 5 (`removeKeyframePatch`,
> `moveKeyframePatch`), Phase 6 (delete and drag a keyframe on the timeline — the
> highest-visibility slice), Phase 7 (re-writing a keyframe's easing/handles in place),
> and Phase 12 (`clear property keyframes`, `clear all`).
>
> **What it needs — a real engine slice, `5a`:**
>
> 1. `RemoveKeyframesOp` in `editor-core/src/operations.ts`, with `apply` **and an
>    exact `invert`**. Non-trivial: the inverse of a removal is re-adding the exact
>    keyframes that were removed, so either the op carries them (the `restore_clips`
>    pattern this repo already uses for `delete_range`/`ripple_delete`) or `invert`
>    reads them from the pre-state. Follow `restore_clips` — it is the established
>    answer to this exact shape.
> 2. Registration in `validator.ts`'s operation list.
> 3. `moveKeyframePatch` then composes remove + add in ONE patch, so a keyframe drag
>    stays one undo step.
> 4. Tests in `editor-core` — this is a core deterministic module, so **100 %
>    coverage**, plus a round-trip (`apply` → `invert` → original) like
>    `operations.test.ts` already does for `add_keyframes`.
> 5. **No schema change.** `Keyframe` and `Clip.keyframes` are unchanged; this is the
>    op vocabulary, not the project shape — so no migration and no version bump.
>
> **This needs maintainer sign-off before it is built.** `CLAUDE.md` §5 requires asking
> before broadening the operation/IPC surface, and this doc's §4 states the schema plan
> as "two bumps, both additive" without mentioning an operation-vocabulary change. The
> op is additive and migration-free, but it is a permanent widening of what a patch can
> express and it belongs in the plan explicitly rather than arriving as a side effect of
> a UI phase.
>
> **Everything else in Phase 5 is unblocked** and can ship the moment 5a lands:
> `setKeyframeAtPlayheadPatch` is `add_keyframes` with `replace: true` (no engine
> work), and `KeyframeButton` / `useKeyframeState` are pure UI over Phase 4's
> `InspectorRow`, which is done and in place.

Fixes **F5**. Depends on Phase 4's `InspectorRow` (done) **and on 5a above**.

Every animatable row gains a keyframe diamond with five distinguishable states:
no keyframe · keyframe at playhead · animated elsewhere · value differs from
nearest keyframe · just changed (a 150ms pulse). Prev/next keyframe chevrons flank
it. Editing an animated property at a playhead between keyframes creates a new
keyframe — and the row says so *before* the commit, not after.

Retires the standalone add-keyframe form.

**Files:** new `inspector/KeyframeButton.tsx`, `inspector/useKeyframeState.ts`,
`patch-builders.ts` (`setKeyframeAtPlayheadPatch`, `removeKeyframePatch`,
`moveKeyframePatch`).
**Tests:** `KeyframeButton.test.tsx` covering all five states; patch-builder tests.

### Phase 6 — Timeline keyframe visualization + lanes `[x]` (2026-07-31)

**DONE.** Keyframes are objects on the timeline now, not decoration.

**What was actually there.** `clipKeyframeMarkers` collapsed a clip's keyframes *and*
every effect's keyframes into **one dot per rounded millisecond**. So `scale` and `x`
animating at the same instant showed as a single anonymous dot; the dot did not say
which property it belonged to; it was `aria-hidden` with no handlers, so a
screen-reader user had no idea a clip was animated at all. That strip survives — it is
a genuinely useful at-a-glance summary — but it stays `aria-hidden`, because the real
objects now live in the lanes and duplicating them would make a screen reader read
every keyframe twice, once as noise and once as a control.

**Shipped.**

- **`timeline/keyframe-lanes.ts`** (pure, 28 tests) — lanes per property, the track
  height they need, selection identity, and all the drag arithmetic.
- **`timeline/useKeyframeSelection.ts`** — selection and expansion as **view** state,
  never the project: expanding a clip is not an edit, and undo after it must undo the
  user's last edit. Selection is a set of **keys**, not object references, because the
  timeline is rebuilt on every patch and a reference-based selection would be dropped
  by every edit — including the edits made to the selection itself.
- **`timeline/KeyframeLane.tsx`** — the lane and its markers, owning their own pointer
  capture and `stopPropagation`.
- **`timeline/ClipKeyframeLanes.tsx`** — one clip's lane stack, and the playhead
  subscription (see below).
- **`moveKeyframesPatch` / `removeKeyframesPatch`** — group move and group delete, one
  patch each.

**The track grows, and that had one sharp edge.** Expanded lanes add
`trackKeyframeLanesHeight` to the row, which had to be added in **both** the
virtualizer's `rowSize` *and* the rendered lane height — they are separate call sites,
and if they disagree the virtualizer's absolute offsets drift and every track below an
expanded one is drawn in the wrong place. Clips shrink by the same amount through a
`--kf-lanes-h` custom property, so the lanes sit *below* the clip bodies rather than
over their waveforms. The height is the **max** across a track's expanded clips, not
the sum: two clips' lane stacks sit side by side in x.

**The playhead needed its own subscription.** `TimelineView` deliberately does not read
`state.playhead` — its heavy lane subtree is memoised against exactly that. So the
at-playhead marker state and playhead snapping would both have silently never worked.
`ClipKeyframeLanes` subscribes itself via `useFramePlayhead`, so it re-renders on the
playhead while the memoised tree above it does not — the same split the ruler and
playhead marker already use, and only paid for clips the user expanded. Asserted
directly, because a missing subscription fails invisibly.

**Two real bugs, found by the tests.**

1. **A group drag moved only one keyframe.** Pointer-down on an already-selected
   marker collapsed the selection to it — correct for a click, fatal for a drag. The
   collapse is now **deferred to pointer-up** and only happens if the gesture turned
   out to be a click. This is the standard NLE rule and it is not obvious until a group
   drag silently moves one item.
2. **Snapping could destroy a keyframe.** Snap targets exclude the dragged lane's own
   keyframes (landing on a sibling replaces it), but a keyframe in *another* lane at
   the same time pulled the dragged one straight onto its sibling anyway — and `x` and
   `scale` animating together is exactly what lanes exist to show, so this was the
   common case, not a corner. Targets colliding with the lane's own keyframes are now
   dropped. A **free** drag onto a sibling still replaces it: that is the user
   choosing, not the tool helping them into it.

**Batched remove-then-add matters.** `moveKeyframesPatch` emits every removal before
any addition. Applied pairwise, moving `[1s, 2s]` forward by 1s would write 1s→2s
first, which `replace` lands on top of the keyframe at 2s that is *also* moving — the
group would arrive one keyframe short. Asserted.

**Deferred, with reasons.**

- **Box-select** of keyframes. The timeline already has a marquee, but it resolves to a
  *clip* selection; making one gesture mean either depends on selection
  disambiguation, which is Phase 13's whole subject. Doing it here would mean building
  the disambiguation twice.
- **Copy / paste / duplicate keyframes.** Needs a keyframe clipboard and a place to
  invoke it from; Phase 12 owns the Animation submenu, so the clipboard lands with it
  rather than as a hidden shortcut here.
- **Scale timing between the selection.** A different gesture (drag an edge of the
  selection's span, not a keyframe), and it needs the box-select above to be worth
  reaching for.
- **Beats.** There is no beat data in the project — snapping to markers is implemented
  and is the honest version of that target.

**Tests:** `keyframe-lanes.test.ts` (28, pure) and `TimelineView.keyframes.test.tsx`
(21 — including *"NEVER drags the clip"*, the failure that would make lanes worse than
the decoration they replaced). Suite **117 files / 2066 green**; typecheck and lint
clean.

**Not verified here:** the perf guard the brief asks for (a 200-keyframe clip must not
regress the drag frame budget) is a desktop-scale measurement, not a jsdom one — the
existing `Editor.perf.test.tsx` passes unchanged, but a real budget check belongs with
the desktop-scale pass this doc's §7 already schedules for Phase 6 and 10d.

Fixes **F4**. The highest-visibility slice.

- Real diamond markers with distinct at-rest / hover / selected / at-playhead /
  in-multiselection states — distinguished by **shape and emphasis, not hue alone**.
- A clip-level "animated" indicator, and an expand affordance opening **per-property
  lanes** (position, scale, rotation, opacity, volume, effect intensity).
- Editing: add at playhead, delete, drag horizontally, box-select, multi-select,
  copy/paste/duplicate, move-together, scale timing between selection, snap to
  playhead / clip edges / markers / beats, prev/next navigation.
- Dragging a keyframe must never drag the clip — the lane owns its own pointer
  capture, mirroring how `.clip-transition-pill` already opts out of the
  clip-drag selector at `TimelineView.tsx:1477`.
- Hover readout: property · time · value · interpolation · easing.

**Files:** new `timeline/KeyframeLane.tsx`, `timeline/KeyframeMarker.tsx`,
`timeline/useKeyframeSelection.ts`; `TimelineView.tsx` integration.
**Tests:** new `TimelineView.keyframes.test.tsx`; perf guard in
`Editor.perf.test.tsx` (a 200-keyframe clip must not regress drag frame budget).

### Phase 7 — Easing, interpolation, graph editor `[x]` (2026-07-31)

**DONE. Schema v14, ADR 0089.**

> **⚠ Numbering correction to §4.** This doc planned handles as **v15 / ADR 0090**,
> behind speed ramps at v14 / ADR 0089. Phase 7 landed before Phase 10, and both a
> schema version and an ADR number are assigned by landing order — so the two swapped.
> **Handles are v14 / ADR 0089; speed ramps are v15 / ADR 0090.** Neither decision
> changed, only the sequence. §4.1 and §4.2 below are otherwise still accurate.

**`bezier` was never a bezier.** It was a hardcoded smoothstep (`3t² − 2t³`) with no
control points anywhere in the schema. It now has them.

**The compatibility rule is the most important part.** `easing === 'bezier'` with
**absent** handles still means smoothstep. Falling back to `linear` would flatten every
existing animation; falling back to "a sensible default bezier" would change them by a
smaller, harder-to-notice amount, which is worse. Only the existing meaning makes the
v13→v14 migration a no-op *in fact* rather than just in the data. A segment with a
handle on only one side falls back too — half a curve is not a curve, and guessing the
missing control point would be inventing motion. Both engines assert this directly.

**Handles are two-sided, and that decides where they live.** A segment `a → b` is
shaped by **`a.handles.out` and `b.handles.in`**, the CSS `cubic-bezier()` convention.
That is *why* a handle sits on the keyframe rather than on the segment: a keyframe sits
between two segments and the user drags one pair of handles at it. It also means
`evaluateKeyframes` could no longer route through `interpolate` — that function only
ever sees the *earlier* keyframe's easing name, so it structurally cannot express the
curve. New `segmentProgress` / `segment_progress` sees both keyframes.

**`x` is clamped to `[0,1]`, `y` is deliberately not.** An x outside the unit interval
makes the curve non-monotonic in time — the property would travel backwards
mid-segment. But `y > 1` (overshoot) and `y < 0` (anticipation) are the entire reason to
draw a custom curve; clamping them would quietly flatten exactly the effect the user
asked for. Both engines already clamp where a value must be bounded, so it is absorbed
at the point of use.

**The solver is fixed-iteration in both languages, on purpose.** A cubic bezier is
parametric — `y` is not a function of `x` — so evaluating it means inverting `x(s)`
first. 8 Newton-Raphson steps, falling back to 20 bisection steps when Newton leaves
the domain (which it does on a near-vertical curve, where the slope vanishes and the
step explodes). **Fixed counts, not convergence tests:** a loop that runs "until the
residual is below ε" runs a different number of times in the two languages the moment
their intermediate rounding differs by one ulp, and then the preview and the export
disagree about motion feel — the render-vs-preview rule broken in the way that would
ship, because it looks like nothing is wrong.

**Numeric parity is a committed fixture, because field-name parity cannot catch this.**
`packages/editor-core/fixtures/bezier-parity.json` — 88 cases across eight curves,
including overshoot, anticipation and two degenerate near-vertical shapes. Both suites
assert it to **1e-12**. `test_schema_parity.py` proves the two schemas have the same
*shape*; it cannot prove the two solvers produce the same *numbers*, and the numbers
are what the user sees.

**UI.** `KeyframeGraphEditor` — the interpolation menu always, the graph behind one
click and **only for `bezier`** (offering it for `ease-in` would store handles the
engine ignores). The plot samples `segmentProgress` itself, so what you drag is what
renders rather than a CSS approximation that could drift. The y-range expands to show
overshoot instead of pinning it to the top of the box. Fully keyboard-shapeable
(arrows, Shift for a coarse step) with each handle announced as `x …, y …`. It appears
in the inspector under the row whose keyframe is **under the playhead** — the only
moment "this keyframe's curve" is an unambiguous phrase.

**Reset removes the handles rather than writing straight ones**, so the project does not
accumulate handles that say nothing and a reset keyframe means exactly what a v13
keyframe meant.

**Files:** `packages/timeline-schema/src/index.ts` (+`BezierHandleSchema`,
`SCHEMA_VERSION` 14), `migrations.ts` (13→14 passthrough), regenerated
`schema/project.schema.json`, `editor-core/src/keyframes.ts`
(`solveCubicBezier`/`segmentProgress`), `engine/.../effects/keyframes.py` +
`timeline/models.py` (`BezierHandles`, `SCHEMA_VERSION` 14), new
`timeline/KeyframeGraphEditor.tsx`, `patch-builders.ts`
(`setKeyframeHandlesPatch`), `docs/adr/0089-*.md`, new
`packages/editor-core/fixtures/bezier-parity.json`.

**Tests:** 13 new TS cases in `keyframes.test.ts` (incl. the parity fixture), 10 new
Python cases in `test_keyframes.py` (incl. the same fixture), 14 in
`KeyframeGraphEditor.test.tsx`. **Whole monorepo green:** editor-core 533,
timeline-schema 152, engine 1906, web-editor 2080, ai-sdk 2237, desktop 242,
mcp-server 109.

### Phase 8 — Transitions on the timeline `[x]` (2026-07-31)

**DONE.** `TransitionPill` is retired; a transition is now an object that says what
it is.

**The pill's three real gaps, and what replaced each.**

1. **It could not say what it was.** The pill rendered one arrow glyph, so a
   timeline of six transitions was six identical arrows. `TransitionBlock` now
   carries kind + duration as a label when it has room, an icon when it does not,
   and — critically — the duration is in the **accessible name at every density**,
   because a block too narrow to print its label is exactly the one a screen-reader
   user has no other way to identify.
2. **It could not survive zoom.** Width was `max(8px, duration × zoom)` computed per
   pill with no awareness of its neighbour. At low zoom two adjacent blocks
   overlapped and a click landed on whichever happened to be later in the DOM.
3. **It reported the duration only after the fact.** The accessible name updated
   mid-drag but nothing on screen did, so you dragged blind.

**Layout is arithmetic, and it resolves the whole track at once.** That is the part
a stylesheet cannot do, and it is why `timeline/transition-blocks.ts` is a separate
pure module (8 cases, 100 %). A 0.5s dissolve at 4 px/s is two pixels, so a block
has a **minimum drawn width** — which means the drawn box is no longer
`duration × zoom` and can collide with a neighbour *even though the two transitions
do not overlap in time*. The engine caps a duration at `min(incoming, outgoing)`
clip length, so on `A[0,1] B[1,2] C[2,3]` with 1s transitions the blocks meet
exactly at 1.5s; add a minimum to that and they overlap. Colliding blocks are
pulled back to **meet at the midpoint between their cuts** — symmetric, so the two
sides of a boundary agree on where it is without coordinating, and a click always
lands on exactly one transition. A degenerate span still gets a 1px hairline: a
zero-width block is an object the user cannot reach at all.

**The dragged block leaves the layout, deliberately.** Mid-resize the block follows
the pointer directly rather than through `layoutTransitionBlocks`, because the
layout resolves collisions against *committed* durations — re-running it per pointer
move would make the block being dragged fight neighbours that have not moved. It
re-joins on release, when its duration is real.

**Eligibility surfaces the reason, it does not just disable.** The brief's exact
ask. `transitionEligibility` already computes a human sentence for each rejection,
so the junction affordance now carries it in `title` and `aria-label` and sets
`aria-disabled` rather than vanishing — a control that silently is not there teaches
the user nothing. The eligibility question is asked with
`DEFAULT_TRANSITION_SECONDS`, now exported for exactly that reason: asking about a
different duration than the button would apply is how an affordance ends up offering
an edit the validator rejects.

**Apply-to-all lives in the picker, per kind.** `addTransitionToAllCutsPatch` walks
every track's abutting cuts, asks `transitionEligibility` (not a second opinion
invented here), and emits **one patch** so the sweep is one undo press. Cuts that
already carry a transition are **skipped, not overwritten** — "add transitions
everywhere" must not replace the dissolve someone hand-tuned. The trigger is a
hover-revealed "All" on each kind's own row rather than one global button at the
bottom of the list, so it cannot be clicked without having chosen *what* to apply.

**The context menu is three actions and stops there.** Replace · preset durations ·
remove. Duration-by-drag is the block's own gesture and the parameters (alignment,
direction, intensity, easing) are Phase 9's inspector section; a menu of sliders
would be the wrong surface for either. Presets are here rather than in the inspector
because "make that one quicker" is a timeline thought. Presets longer than the cut
can hold are **omitted, not disabled** — the validator would reject them, and an
entry that exists only to refuse is noise at the moment the user is acting. Replace
reopens the *same* picker the `+` affordance uses, so one place knows what kinds
exist. Dismissal mirrors `EffectLayerMenu` exactly, including the capture-phase
pointerdown: two context menus in one view that dismiss differently is a bug the
user experiences as flakiness.

**Deferred, with reasons.**

- **Alignment (centre/before/after) and reverse.** Both are §4.3 `Effect.params`
  properties, and §4.3's rule is that render and preview move together. Shipping the
  timeline control before `render/transitions.py` reads the param would be a control
  with no effect on the export. They land in **Phase 9** with their render support.
- **Default-transition keyboard shortcut.** `⌘D` is duplicate and `⌘T` is add text;
  the free chords left are not ones any NLE uses for this, and inventing one is worse
  than the picker being one click away. Revisit with the Phase 13 shortcut pass.

**Files:** new `timeline/transition-blocks.ts`, `timeline/TransitionBlock.tsx`,
`timeline/TransitionMenu.tsx`; deleted `TransitionPill.tsx`; `TimelineView.tsx`,
`TransitionPicker.tsx`, `patch-builders.ts`, `styles.css`, `packages/ui/src/tokens.css`
(`--transition-fill` / `--transition-border`, both themes — a transition is a junction
between two clips, so it must not read as a third clip, and the accent stays reserved
for selection).

**Tests:** new `transition-blocks.test.ts` (11, pure) and 14 new cases in
`TimelineView.transitions.test.tsx`. Suite **119 files / 2101 green**; typecheck and
lint clean.

Fixes part of **F7**.

Transition block straddling the cut, showing type, duration, and affected clips.
Zoom-responsive: full label + handles when wide, a compact recognizable marker when
narrow, never overlapping neighbours. Application routes: drag from browser · click
the join · boundary `+` button · context menu · default transition shortcut ·
apply-to-all-compatible-cuts. Hover shows an insertion target at valid cuts;
`transitionEligibility` already computes validity and rejection reasons — surface
the reason, don't just disable.

Adjustment: drag edges with live duration feedback, exact duration in the
inspector, preset durations, centre/before/after alignment, replace, remove,
reverse. Invalid ranges are prevented **with the reason shown**.

**Files:** `TransitionPill.tsx` → `timeline/TransitionBlock.tsx`,
`TransitionPicker.tsx`, `TimelineView.tsx`.
**Tests:** extend `TimelineView.transitions.test.tsx`.

### Phase 9 — Transition inspector + params + preview `[x]` (2026-07-31)

**DONE. No schema change, no migration** — every parameter rides the free-form
`Effect.params` exactly as §4.3 promised.

**The rule the whole phase turns on: every default reproduces the pre-Phase-9
render exactly.** Asserted, not asserted-about — each default is pinned against the
*old constant* rather than against itself, in both suites. An existing project
previews and exports as it always did.

**Deviation from §4.3: `easing` defaults to `linear`, not `ease-in-out`.** The
table in §4.3 says `ease-in-out`. Progress has always been linear here, so adopting
that default would silently re-time **every transition in every existing project** —
a change nobody asked for, visible only as "my dissolves feel different", and
therefore worse than a visible break. The default is what the render already did;
`ease-in-out` is one click away.

**`direction` means the direction the transition MOVES**, consistently across
kinds: the way the incoming picture travels for push/slide, the way the reveal edge
sweeps for wipe, `in`/`out` for zoom. Naming it after the source edge ("comes from
the right") reads better for push but has no meaning at all for wipe, and one rule
that holds everywhere beats two that each hold once. Push and slide's math unified
onto one travel vector; they stay distinct kinds because their *defaults* differ,
and the default is what a user picks them by.

**A direction the new kind cannot use is inert, not wrong.** A kind swap
deliberately preserves params (see the bug below), so a zoom's `in` can end up
sitting on a push. Both engines resolve an inapplicable direction to the kind's
default, so swapping away and back **restores** the tuning instead of losing it —
and the inspector displays the *resolved* value, so the panel never shows a number
the export does not use.

**Bug found, and it was the crux of the whole slice.** `applyAddTransition` builds
`params` from scratch (`{kind, durationSeconds, fromClipId}`) and replaces the
effect by id. That is right for the op — it is the *definition* of a transition —
but it meant **every builder routing through it silently discarded the new params**.
A duration resize or a kind swap would have reset direction, intensity, softness and
easing the moment they shipped. Fixed without widening the op vocabulary:

- **Kind swap is now `set_effect_params`, not `add_transition`.** The duration does
  not change, so the eligibility `add_transition` re-checks cannot have become
  false, and the merge preserves everything else.
- **Duration resize keeps `add_transition`** (it must re-validate) and carries the
  extras across **in the same patch**. Two patches would make one undo show the
  transition resized but reset, which reads as data loss.

**Reset clears the params rather than writing their defaults.** A stored
`intensity: 1` and an absent one render identically *today*; only the absent one
keeps rendering identically if a default ever changes. `set_effect_params` already
deletes on `undefined`, which is exactly those semantics.

**Which controls render is a table, not a condition.** `inspector/transition-params.ts`
answers "does this kind read this param?" once, and the test asserts the direction
column against the envelope's own `DIRECTIONS_BY_KIND` rather than restating it —
two hand-kept copies is precisely how a control the export ignores gets shipped.
Notable rows: a **wipe has no intensity** (it either reveals or it does not; "80 % of
a reveal" is not renderable), a **blur has no softness** (its softness *is* its
radius, which `intensity` already sets), and **`hold` is excluded from the easings**
(it maps progress to 0 until the very end, so a held transition hides the incoming
clip and then pops — a cut with extra steps).

**Registry rule changed, deliberately.** The Transition section was gated on
`kind === 'clip'`, which made **apply-to-selected-cuts unreachable**: the section
vanished the instant you selected the cuts you wanted to apply to. It now appears
whenever the **primary** clip has a transition — Phase 4's primary-first rule already
resolves the ambiguity the old gate was guarding against, since the panel edits the
primary like every other single-value control. A side benefit: a clip *without* a
transition no longer grows an empty disclosure.

**Two genuine correctness fixes found by the tests.**

1. **`wipeAlpha` was a float-epsilon short of opaque at `p = 1`** for some softness
   values (`0.15` gives `0.9999999999999994`), so the last frame of a wipe left the
   trailing edge faintly transparent. Invisible, but it makes "the transition is
   over" not quite true and anything comparing against `1.0` disagrees. Both engines
   now short-circuit `p >= 1`.
2. **`offsetAt` emitted `-0`** on the axis a transition does not travel. Harmless in
   CSS, but `-0` survives `Object.is`, so a caller skipping a transform when the
   offset is 0 would take the slow path forever.

**The canvas wipe became one code path for four directions.** The mask now spans the
**whole** sweep axis with its stops placed at the band, instead of a band-sized
gradient plus a fill rectangle — canvas extends the first and last stop colours
outwards, so one fill expresses keep-before / ramp / erase-after. A vertical wipe is
the same formula on a column; a reversed one mirrors the *fraction*, not the formula.
`wipeCssMask` owns the direction → CSS-side mapping for the DOM player so the two
preview surfaces cannot wipe opposite ways from each other.

**Preview plays the real cut, not a swatch.** "Preview transition" seeks
`PREVIEW_LEAD_SECONDS` before the incoming clip and plays through
`PREVIEW_TAIL_SECONDS` past the transition — a transition previewed from its own
first frame is one you cannot judge, because the whole point is how it joins two
shots. The stop is driven off the **playhead subscription**, not a timer: a timer
assumes playback started instantly and never paused, and would stop somewhere else
entirely if either turned out false.

**Deferred, with reasons.**

- **Alignment (centre / before / after).** *Not implementable as a parameter.* The
  transition eases the incoming clip in over its own first `durationSeconds`, so the
  only thing a param could shift is the ramp *window* — and `centre` would then mean
  the clip appears abruptly at 50 % opacity and finishes ramping, i.e. a visible pop,
  while `before` means no transition at all. Real alignment is about **how much the
  two clips overlap**, which is `move_clip`/`trim_clip` — a timing operation that
  changes sequence duration, with its own ripple question. It belongs in a timing
  slice with an ADR, not smuggled into a params phase.
- **`color` / dip-to-color.** There is no `dip-to-color` kind, and this doc's own
  header says `plan/TRANSITIONS-PREVIEW-AND-KINDS.md` **owns transition render
  kinds**. `color` is a param of a kind that plan owns; adding the kind here would be
  building in someone else's slice.
- **Reverse.** A "reversed" transition is the outgoing clip's *out*-ramp, and the
  engine's transition primitive only ever eases the **incoming** clip in. Expressing
  it needs an out-envelope in the compiler, which is a render feature, not a param.
- **Hover-preview thumbnails in the browser.** A synthetic two-swatch animation can
  only teach a look the project may not have, and the Preview button already shows
  the real thing on the real footage. Building both means maintaining two truths.
- **Compare, and favourite.** Compare needs an A/B monitor mode (the grade-compare
  surface's job); a favourite needs somewhere to live, which is Phase 11's preset
  store.

**Files:** `engine/.../render/transitions.py` (parsed params, `eased_progress`,
`zoom_from`, `wipe_softness`, `wipe_axis`), `render/compiler.py` (direction-aware
vectorized wipe), `preview/transition-envelope.ts` (the mirror, + `wipeCssMask`),
`preview/engine/webcodecs-preview-engine.ts`, `PreviewPlayer.tsx`,
`patch-builders.ts` (`setTransitionParamsPatch`, `resetTransitionParamsPatch`,
`applyTransitionToClipsPatch`, and the two fixes above), new
`inspector/transition-params.ts`, `inspector/sections/TransitionSection.tsx`,
`inspector/registry.ts`.

**Tests:** 21 new Python cases in `test_transitions.py`, 17 new TS cases in
`transition-envelope.test.ts`, new `transition-params.test.ts` (13) and
`Inspector.transition.test.tsx` (12), plus 3 new patch-builder cases and 2 registry
tests rewritten against the new rule. **Whole monorepo green:** web-editor
**121 files / 2149**, engine **1934**; typecheck, eslint, ruff and mypy all clean.

Completes **F7**. **No schema change** (§4.3) — but render and preview move together.

Inspector: name, thumbnail, duration, alignment, direction, intensity, softness,
easing, color, replace, reset, remove, favorite, apply-to-selected-cuts. Only
kind-relevant controls render.

Preview: hover-preview in the browser, preview against the *actual* clips where
possible, scrub, loop, compare. After applying, playback starts slightly before
the transition and runs slightly past it.

**Files:** `inspector/TransitionSection.tsx`, `transition-catalog.ts`,
`preview/transition-envelope.ts`, `engine/python/.../render/transitions.py`.
**Tests:** TS + Python, including a parity test that preview and render agree on
each new param's direction of effect.

### Phase 10 — Speed system + ramps `[~]` (10a + 10b done 2026-07-31)

Fixes **F8**. **Schema v15 (ADR 0090)** — see the numbering correction in 10a.
Largest slice; split into 10a–10d. **10a and 10b are done; 10c and 10d are open.**

- **10a — Schema + engine `[x]` (2026-07-31). Schema v15, ADR 0090.**

  > **Numbering correction, again.** §4.1 planned ramps as v14/ADR 0089. Phase 7's
  > handles landed first, so ramps took **v15/ADR 0090**. Neither decision changed.

  `speed` widened from `.positive()` to any finite number (`0` = freeze, `< 0` =
  reverse); new `SpeedPointSchema` and `Clip.speedRamp`; new
  `editor-core/src/speed-curve.ts` + `effects/speed_curve.py` mirror; new
  `set_clip_speed_ramp` op; validator on the integral form; v14→v15 passthrough
  migration.

  **The invariant generalised exactly as §4.1 predicted**, and that is asserted
  rather than assumed: a flat curve at five different rates integrates to ADR 0046's
  division to 1e-9.

  **Scope line, stated as a decision rather than left as a gap: ramp rates are
  strictly positive.** Freeze and reverse are the **constant** cases only. A rate
  reaching or crossing zero makes the timeline↔source mapping non-invertible — the
  integral stops being strictly increasing, so "which source frame belongs at this
  output time?" has no single answer, and `sourceTime`-anchoring (chosen precisely
  to keep that mapping stable) buys nothing. Ramping *through* a freeze needs a
  different model — explicit segments with durations, not a rate curve — so it is a
  further step, not a relaxed bound.

  **`speedConsistencyChecks` and every edge op now share `clipTimelineDuration`.**
  One function, so a trim can no longer be rejected by a rule slightly different
  from the one that produced the clip — which is exactly how ADR 0046's known
  limitation arose.

  **A freeze is not judged.** `clipTimelineDuration` returns `null` at `speed === 0`
  and the validator **skips** the check: a held frame's length is set, not derived,
  and inventing an expectation would make every freeze frame invalid.

  **The two speed ops share one inverse**, because they are one axis — each clears
  the other, so undoing either must restore whichever the clip actually had. Two
  separate inverses would each restore only their own half, and a ramp undone through
  `set_clip_speed` would come back as a **constant rate**: a silent loss of the whole
  curve. **A prior freeze inverts through `restore_clips`**, because at speed 0 there
  is no duration for a same-shape inverse to recompute.

  **ADR 0046's known limitation is closed.** `truncateClip` (already shared by
  `delete_range`/`ripple_delete`) now maps edges through the clip's speed, and
  `trim_clip`/`split_clip` route through it too. Three cases, each with a way to be
  quietly wrong: a **freeze**'s source range is left untouched (consuming it
  proportionally would shrink it to nothing and make a freeze impossible to trim); a
  **reverse** consumes footage from the source *end* when the timeline *head* is
  trimmed (invisible in the duration check, obvious in the picture); and a **ramp** is
  **re-based**, without which both halves of a split carry the whole original curve
  and each renders the wrong speeds. Points falling before a new origin become **one
  synthetic point carrying the rate at the cut**, not dropped — dropping them would
  run the head of the clip at the first *surviving* point's rate, silently changing
  the speed of footage the trim did not remove.

  **`split_clip` was wrong for curves in a way that mattered.** It took the *linear*
  fraction of the source span, which is right for a constant rate: on a clip that
  starts slow and ends fast, halfway in **time** is nowhere near halfway in
  **footage**, so a split placed on a gesture cut somewhere else.

  **Two bugs found while wiring it.** A `speedRamp: undefined` key spread onto every
  truncated clip (deep-unequal to a clip that never had one, so every trim failed an
  equality check), and `sourceSpanForDuration` floors at zero — correct for "how much
  footage fills this duration", wrong for a trim that **extends** an edge, where the
  delta is negative. The signed, unclamped `sourceOffsetForTimeline` is the fix.

  **Numerical method: fixed-step Simpson (128 intervals/segment) + 60 bisection
  steps, in both languages** — ADR 0089's lesson, and it bites harder here: an
  adaptive rule runs a different number of steps in the two languages the moment
  their rounding differs by one ulp, and then preview and export disagree about **how
  long a clip is**, which desynchronises everything after it. Integration is
  **piecewise**, split at every control point, because the curve has a kink at each
  and Simpson is exact on a smooth piece and badly wrong across a corner. 128 rather
  than 64 because no fixed quadrature is exactly additive across a split; at 64 the
  error is ~6e-8, uncomfortably close to the 1e-6 the validator enforces.
  `fixtures/speed-curve-parity.json` — 252 cases, seven curves — is asserted to 1e-9
  in **both** suites.

- **10b — Render `[x]` (2026-07-31).** `_apply_speed` keeps `vfx.MultiplySpeed` for
  the constant forward case (the existing fast path, byte-identical). Each new case
  needed a *different* primitive, because `MultiplySpeed` structurally cannot express
  any of them: a **ramp** is `time_transform` fed `source_time_at` — the same
  function the validator and editor use, so the render cannot disagree with the
  timeline about where a frame is; a **freeze** is `time_transform` mapping every
  output time to one source instant (there is no factor that makes `MultiplySpeed`
  stop); a **reverse** is `TimeMirror` **plus** `MultiplySpeed(|speed|)`, because
  reversal and rate are separate primitives and `TimeMirror` alone plays backwards at
  1x, which is not what a −2x clip means.

  **Audio, reported not silently wrong** (the ADR states it in full). Constant speed
  keeps ADR 0046's pitch-shift limitation unchanged. **Freeze drops audio** — a held
  sample is a DC offset, i.e. silence with a click at each edge, so silence is the
  honest render and what every NLE does. **Ramped audio pitch-shifts continuously**
  and is the open one: MoviePy has no pitch-independent time-stretch and this
  codebase has no DSP for one. The two honest routes (an FFmpeg `atempo` chain over a
  discretised ramp, or dropping audio on ramped segments) are **not implemented
  here**; the choice belongs with **10c/10d**, where there is a control to expose the
  trade-off on. Shipping the picture correct and the audio pitched matches the
  constant-speed precedent exactly.

  **Files:** `timeline-schema/src/index.ts` + `migrations.ts` + regenerated
  `schema/project.schema.json`, new `editor-core/src/speed-curve.ts`, new
  `engine/.../effects/speed_curve.py`, `editor-core/src/operations.ts`,
  `validator.ts`, `engine/.../timeline/models.py`, `engine/.../render/compiler.py`,
  `docs/adr/0090-*.md`, new `packages/editor-core/fixtures/speed-curve-parity.json`.

  **Tests:** new `speed-curve.test.ts` (21 incl. the parity fixture) and
  `test_speed_curve.py` (20 incl. the same fixture), 13 new operation cases, plus
  schema/validator cases rewritten against the widened range. **Whole monorepo
  green:** editor-core 556, timeline-schema 153, engine 1951, web-editor 2149;
  typecheck, eslint, ruff and mypy clean.
- **10c — Speed section UI `[x]` (2026-07-31).**

  **The rule the panel turns on: the resulting duration is shown BEFORE the commit.**
  A speed control whose effect on the timeline you only learn by pressing it is one
  you have to undo to understand. The readout is `aria-live`, because the number
  changing *is* the feedback — a screen-reader user scrubbing the rate would
  otherwise get nothing until they committed.

  **Direction and magnitude are separate controls, not one signed number.** `-2` is a
  fine way to *store* reverse and a poor way to ask for it: a user thinking "play this
  backwards" is not thinking about a sign, and a stray minus in a scrub field would
  silently flip the clip. Reverse is a toggle beside the rate, and the stored value is
  their product.

  **Duration-driven speed** — edit the duration and the rate follows. The useful
  direction for "this shot needs to fill four seconds", and the one a rate field
  cannot answer without arithmetic in the user's head. It **preserves reverse**:
  asking for a length is not asking to play forwards again.

  **The preview duration is computed by the engine's own `clipTimelineDuration`**, on
  a hypothetical clip, rather than re-deriving `span / speed` in the panel. A panel
  promising a duration the validator then disagrees with is exactly what let ADR
  0046's known limitation stay invisible for so long.

  **A ramped clip gets a readout, not the rate controls.** A curve is not describable
  by a rate field, so the panel reports what the clip *is* and offers "Remove ramp".
  Showing the constant controls would let a stray click flatten a curve the user
  built.

  **Behaviour change, deliberate:** a preset now **commits on click**, matching the
  reverse/freeze toggles beside it. "Apply speed" remains for the scrub field, which
  is a drag and would otherwise emit a patch per tick. The pre-existing panel test was
  rewritten against this rather than deleted.

  **Deferred, with reasons.** The **ripple toggle** is out of scope by ADR 0046's own
  "ripple-vs-isolated" decision, which `set_clip_speed` still follows: it rewrites only
  the target clip's `end`, exactly like `trim_clip`, and a ripple variant is a separate
  op with its own semantics rather than a checkbox on this panel. The
  **pitch-preservation toggle** has nothing to toggle — ADR 0090 records that neither
  pitch-independent route is implemented, so the control would claim a capability the
  render lacks.

  **Tests:** new `Inspector.speed.test.tsx` (12). web-editor **2162 green**;
  typecheck and lint clean.
- **10d — Speed ramp editor.** Visual curve with add/move/adjust points, smooth vs
  sharp, presets (montage, hero, bullet, flash-in, flash-out, custom), immediate
  preview, reset, save-as-preset. Ramp indicator drawn on the timeline clip.

**Known dependency, RESOLVED in 10a (2026-07-31):** ADR 0046 flagged that
`trim_clip`, `split_clip`, `delete_range`, and `ripple_delete` were speed-unaware —
the single biggest risk in the program (§7). All four now route through one
speed-aware `truncateClip`, and the freeze / reverse / ramp cases are each asserted.
Ramps are therefore **not** behind a flag: the trap the risk table described does not
exist.

### Phase 11 — Animation presets `[ ]`

In / out / loop / custom animations, each with a visual preview before apply, and
a "convert preset to keyframes" action so a preset is a starting point rather than
a black box. Built on `punchInKeyframes`-style pure generators.

### Phase 12 — Clip options + context menu `[ ]`

Adds the keyframe actions to `ClipContextMenu.tsx` under one **Animation**
submenu: add keyframe at playhead · open keyframe editor · show animated
properties · expand/collapse lanes · prev/next keyframe · copy/paste keyframes ·
clear property keyframes · clear all · convert to preset · apply preset. Beginner
wording; advanced actions nested, not flattened.

### Phase 13 — Timeline interaction polish `[ ]`

Selection disambiguation (clip vs transition vs keyframe vs lane vs edge vs
marker), hover affordances, snapping across all target types with visible feedback
and a mid-drag defeat key, and zoom that keeps the pointer/playhead anchored
without losing selection or collapsing expanded lanes.

### Phase 14 — Workflow validation `[ ]`

Playwright e2e for Workflows A–D from the brief, verbatim: animate a clip · create
a speed ramp · apply a transition · work at different zoom levels. Each asserts
undo/redo restores every intermediate state.

---

## 6. Dependency order

```
1 → 2 → 3          (preview, independent)
      4 → 5 → 6 → 7        (inspector → keyframes → lanes → curves)
              6 → 8 → 9    (transitions need lane/selection groundwork)
      4 → 10a → 10b → 10c → 10d
                    6, 10d → 11, 12
              all → 13 → 14
```

Phases 1–3 and 4 can proceed in parallel with 10a's schema work. **Nothing in
7 or 10 starts before its ADR is written and accepted.**

---

## 7. Risks

| Risk                                                                                                  | Mitigation                                                                                                            |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Speed-unaware edge ops.** Trimming a ramped clip breaks the duration invariant and the patch is rejected. | 10a makes `trim_clip`/`split_clip`/`delete_range`/`ripple_delete` curve-aware **before** any ramp UI ships. If that proves larger than 10a's budget, ramps stay behind a flag rather than shipping a trap. |
| **Audio pitch on ramps.** MoviePy has no pitch-independent stretch.                                    | Decided explicitly in ADR 0089; implemented or reported, never silently wrong (AGENTS.md render-honesty rule).          |
| **Preview/render divergence** on new transition params.                                                | Parity tests per param; the preview may approximate but may not imply a capability the render lacks.                   |
| **`TimelineView.tsx` at 2,620 lines** grows further with lanes.                                        | Phase 6 extracts to `timeline/` rather than appending. Same decomposition discipline as Phase 4.                       |
| **Test suite scale.** 724 web-editor tests; coverage gates are strict and CI is stricter than local `verify`. | Run touched packages' `test:coverage` before each push. `ai-sdk`'s 100% gate is already red from pre-existing gaps — check `git diff --name-only` before attributing a failure to this work. |
| **Desktop-first rule.** Perf must be judged on real camera files, not fixtures.                        | Phase 6 and Phase 10d get desktop-scale perf checks, not just jsdom tests.                                             |

---

## 8. Definition of done (per phase)

- [ ] `pnpm verify` green; touched packages' coverage green
- [ ] Engine changes mirrored in Python and parity-tested
- [ ] Every gesture is one validated, invertible patch
- [ ] Empty / loading / error / single-item / overflow states exist for new surfaces
- [ ] Whole flow completable by keyboard; focus visible, trapped, restored
- [ ] Tooltips with shortcuts on every icon-only control
- [ ] Motion 120–180ms; `prefers-reduced-motion` honored
- [ ] No new hardcoded hex; every style references a token
- [ ] `plan/PLAN.md`, `CHANGELOG.md`, and `docs/` updated; ADR written where a
      decision was made
