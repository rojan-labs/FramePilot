# Editor UI (Renderer)

The editor UI is the **React renderer** that runs inside the desktop shell
([desktop-shell.md](desktop-shell.md)): the manual non-linear editor — import/create a
project, scrub a preview, edit a multi-track timeline, inspect clips, and build captions
from a transcript. It is the human-facing half of the reliability loop in
[overview.md](overview.md); the AI layer (Phase 4) will drive the **same** edit pipeline.

Code lives in `apps/web-editor/src`. See
[ADR 0010](../adr/0010-renderer-editor-pure-core-thin-shell.md) for why it is structured
the way it is, and [timeline-and-patch-engine.md](timeline-and-patch-engine.md) for the
`@framepilot/editor-core` engine it sits on.

> **Phase 3.2/3.3 status — complete.** Full manual editor: import/create, preview,
> multi-track timeline (trim / split / delete / ripple / move / snap / zoom / markers),
> inspector, and a transcript + caption editor. 92 tests, 100% coverage on the pure core.

---

## 1. The shape: a pure core + a thin React shell

The renderer is split into a **pure, framework-agnostic core** (`src/editor/`) and **thin
React components** (`src/components/`). Why: the edit logic is the security- and
correctness-critical part (it must enforce the validated-edit invariant), and we want it
**unit-tested independently of the DOM**. React holds no edit logic of its own — it renders
state and dispatches intents. This is the same posture the desktop main process took with
small DI modules + thin `main.ts` glue ([ADR 0009](../adr/0009-desktop-main-process-architecture.md)),
applied to the renderer.

```
┌──────────────────────────────────────────────────────────────────────┐
│ src/components/  (thin React — renders state, dispatches intents)      │
│  Toolbar · TimelineView · PreviewPlayer · Inspector · TranscriptView   │
│  CaptionEditor · Editor (composition) · App (project lifecycle)        │
└───────────────┬───────────────────────────────────┬──────────────────┘
                │ useEditor (useReducer adapter)      │ bridge helpers
                ▼                                     ▼
┌───────────────────────────────────┐   ┌────────────────────────────────┐
│ src/editor/  (pure, no React)     │   │ src/editor/bridge.ts            │
│  store · selectors · patch-builders│   │ window.framepilot access        │
│  captions · project               │   │ (graceful non-Electron fallback)│
└───────────────┬───────────────────┘   └────────────────────────────────┘
                │ validate → apply → record
                ▼
        ┌──────────────────────────────┐
        │ @framepilot/editor-core       │
        │ (typed ops, apply/invert,     │
        │  validatePatch, undo/redo)    │
        └──────────────────────────────┘
```

### The pure core (`src/editor/`)

- `store.ts` — the **working state** (timeline + undo/redo history + selection / playhead /
  zoom / markers) and the only writer of the timeline. See §2.
- `selectors.ts` — pure projections over the timeline: duration, `findClip`,
  `clipsActiveAt` (what plays at a given time), snapping (`snap`/`snapTargets`), and
  pixel↔seconds conversion for the zoomable ruler.
- `patch-builders.ts` — turn a UI intent (trim / split / delete / ripple / move /
  adjustAudio) into a **typed `Patch`** with **deterministic ids** (derived from the
  operation + clip position, never from a clock/RNG, so the same intent is replayable and
  testable). Builders return `null` for no-op edits so they never enter the undo history.
- `captions.ts` — transcript word grouping into caption lines, active-word lookup, styling
  templates, keyword highlighting, and the transcript→`add_caption_layer` patch.
- `project.ts` — `newProject` / `newProjectFromVideo`, schema-validated via `parseProject`.
- `bridge.ts` — renderer-side access to the desktop bridge. See §4.

### The thin shell (`src/components/`)

`Toolbar`, `TimelineView` (multi-track, ruler/scrubber, playhead, markers, zoom),
`PreviewPlayer` (§3), `Inspector` (transform/effects/audio; audio gain wired to
`adjust_audio`), `TranscriptView` (playhead-synced, click-to-seek), `CaptionEditor`
(generate caption track, word-level timestamps, templates/keywords/burn-in preview),
`Editor` (composition + rail tabs), and `App` (project New/Open/Save via the bridge).
`useEditor` is a thin `useReducer` adapter over the pure store, so components dispatch
named intents rather than mutating state.

The monitor separates playback from view configuration: frame navigation and play/pause
stay centered below the picture, while orientation, loop, composition guides, zoom,
and fullscreen are mounted into the same shared header as Source/Program. Both monitor and Assets layouts use
their own container width rather than viewport breakpoints, so resizable rails can
restructure controls without clipping. Transcript phrases wrap naturally within the
right rail instead of being forced into short fixed-width rows.

---

## 2. The invariant: validate → apply → record (every edit, manual or AI)

Every timeline change in the UI — dragging a clip edge, splitting, deleting, adjusting
gain, generating captions — is expressed as a **typed `Patch`** built in
`patch-builders.ts` / `captions.ts` and routed through `store.applyUserPatch`, which runs:

1. **validate** — `validatePatch(timeline, patch, { assetIds })`. If the patch has any
   `error`-severity issues it is **rejected**: the timeline is left untouched and the
   issues are returned for the UI to explain _why_ (AGENTS invariant 3).
2. **apply** — only a valid patch is applied (transactionally, via `editor-core`).
3. **record** — `commitPatch` pushes the forward patch **and its computed inverse** onto
   the undo/redo history ([ADR 0006](../adr/0006-reversible-operations-via-restore-clips.md)),
   so the manual edit is reversible exactly like an AI edit.

There is deliberately **no second, unchecked path** that mutates the timeline. This is what
makes manual edits as safe and reversible as AI-proposed ones, and it means the Phase 4 AI
layer plugs into the existing pipeline rather than a parallel one — the store's
`applyUserPatch` already accepts an agent-built patch unchanged.

Non-timeline view state (selection, playhead, zoom, markers) lives in the same store but
**bypasses the patch engine on purpose**: it is not part of the document and must not enter
undo history. `applyUserPatch` also drops a selection that an edit removed (e.g. deleting
the selected clip) so the inspector never points at a clip that no longer exists.

---

## 3. Render-vs-preview (PRD §9.2)

`PreviewPlayer` honors the critical project rule: **preview is HTML `<video>` + overlay
text, never MoviePy.** MoviePy is the _render/export_ engine only ([render-engine.md](render-engine.md)).
The player resolves the video clip active at the playhead via the pure `clipsActiveAt`
projection, plays its proxy/source media in an HTML `<video>`, and draws text/caption
overlays active at the same instant on top. The component is the thin DOM shell around a
tested projection; smooth scrubbing comes from proxy media + DOM, and accurate output comes
from the deterministic Python pipeline at export time.

Caption styling, templates, and keyword highlight are **preview-time settings**: no schema
field persists them yet, so they intentionally do not mutate the document (changing the
schema would require a migration — CLAUDE.md §2 — which Phase 3 did not take).

Burn-in, by contrast, **is** wired through the render engine (Phase 3.3, ADR 0011): the
Python compiler reconstructs each caption clip's text from the transcript by time-range
overlap (the same rule this UI uses) and burns it in when `burn_captions` is set, exposed
via the sidecar `/render` route and the CLI `--burn-captions`. The one remaining seam is
the renderer→engine **export IPC channel** that would carry the CaptionEditor toggle to a
real desktop export — tracked as a Phase 8 follow-up (no render IPC channel exists yet).

---

## 4. The bridge boundary (`src/editor/bridge.ts`)

The renderer reaches the desktop only through `window.framepilot`, the typed bridge exposed
by the preload script over the IPC contract ([desktop-shell.md](desktop-shell.md) §2). The
renderer-side wrapper:

- is **optional**: the same renderer also runs in a plain browser (Vite dev server, tests,
  an eventual web build) where `window.framepilot` is absent, so every helper **degrades
  gracefully** (returns `{ ok: false }`) instead of throwing;
- accepts an **injected bridge**, so the logic is testable without Electron; and
- **schema-validates opened projects** with `safeParseProject` — a file that does not match
  the schema is _never_ coerced into the editor (AGENTS invariant 3), mirroring the
  main-process `parseProject`-before-write on save.

---

## 5. Why pure-core is testable, glue is not

The pure core (`src/editor/`) is at **100% unit-test coverage** because it is plain
functions over plain data. The React glue (`main.tsx`, the DOM rendering inside components)
needs a browser runtime; its end-to-end behavior is the job of the Playwright harness, not
unit tests — the same coverage boundary ADR 0009 drew for `main.ts`/`preload.ts`. Keeping
the components thin keeps the amount of untested glue minimal.

---

## 6. Known issues / follow-ups (Phase 3 security review)

Two **LOW** findings from the Phase 3 review are tracked under Phase 8 hardening in
[`../../plan/PLAN.md`](../../plan/PLAN.md):

- **Bridge type duplication has no compile-time cross-check.** `src/editor/bridge.ts`
  re-declares the `RendererBridge`/`FramePilotBridge` shape from the canonical IPC contract
  (`apps/desktop/electron/ipc/contract.ts`). The two apps are independent deployables (apps
  never import each other), so the shape is restated — but **nothing fails to compile if the
  two drift.** The real authority is the main-process IPC handler; the renderer type is a
  convenience. Fix: collapse into a shared package, or add a compile-time assignability
  assertion. Risk is contained because the main process validates everything it receives.
- **Preview player uses raw `file://` media; no CSP.** `components/PreviewPlayer.tsx` points
  `<video>` at media by path, and the renderer ships without a Content-Security-Policy. Fix:
  add a CSP and migrate the player to a **sandboxed custom media protocol** resolved (and
  path-sandboxed) in the Electron main process, rather than handing the renderer raw
  filesystem URLs. See [../runbooks/security-hardening.md](../runbooks/security-hardening.md).
