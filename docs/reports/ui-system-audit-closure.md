# UI system audit closure

Date: 2026-08-10

This report records the implementation state of the end-to-end FramePilot UI/UX
audit. It distinguishes behavior that is now corrected from structural cleanup
that should not be represented as complete until it can be changed and exercised
safely in a mounted checkout.

## Closed in this pass

### Design-system authority

- `packages/ui/src/tokens.css` is the canonical value source.
- `DESIGN_SYSTEM.md` now documents semantics and ownership instead of carrying a
  stale second palette.
- Added canonical sans-family, 400/500/600 weight, pill-radius, control-height,
  hit-target, panel-density, and semantic motion tokens.
- Defined the previously implicit caption `--font-sans` and pill-radius concepts.

### Readability and light-theme contrast

- Dense Settings, Inspector, and Caption editor chrome now has an ordinary 11px
  text floor through the editor foundation layer.
- The redesigned surfaces use the portable 400/500/600 weight contract instead
  of relying on intermediate system-font weights.
- Light-theme tertiary text is stronger so 11–12px metadata remains readable on
  bright panel surfaces.
- Compact density reduces space/control chrome without lowering the root font
  size.

### Precision targets and focus

- Timeline track flags, collapse/reorder controls, keyframe controls, Inspector
  reset controls, and Settings switches retain at least a 24px interaction
  target while keeping their glyphs visually compact.
- Dense controls get a common keyboard focus treatment.
- Caption hover/reveal transitions use the shared motion timing contract and
  still honor reduced motion.

### Shared controls

- `@framepilot/ui` now exports shared `Switch` and `SegmentedControl` primitives.
- Settings composes those primitives instead of owning duplicate switch and
  segmented interaction semantics.
- Button/Input/Switch/SegmentedControl ship token-driven baseline presentation
  with the UI package instead of requiring the web editor to make them usable.
- Button loading now remains disabled even if a caller explicitly supplies
  `disabled={false}`.
- Caption font selection uses the existing portaled, keyboard-aware FramePilot
  `Select` rather than a native OS dropdown.

### Regression coverage authored

Focused regression coverage was added for:

- shared Switch semantics and disabled behavior;
- SegmentedControl selection and disabled options;
- Button loading/disabled precedence;
- Caption font selection through the canonical Select and the resulting track
  style change.

The repository is available to this agent through the GitHub connector only, not
as a mounted local checkout, so these focused tests could be authored and diff-
reviewed but not executed locally in this session. Remote CI inspection is
explicitly deferred by task instruction.

## Styling ownership after this pass

The active ownership model is now documented and enforced for new work:

1. shared values in `packages/ui/src/tokens.css`;
2. cross-surface ergonomics in `apps/web-editor/src/editor-foundation.css`;
3. feature presentation beside each feature;
4. the existing `styles.css` treated as legacy/global code that should shrink as
   touched areas are safely extracted.

This prevents another redesign from adding a new unrelated global block while
allowing current behavior to remain stable.

## Residual source debt

Two findings are intentionally **not represented as physically removed** in this
PR:

1. `apps/web-editor/src/styles.css` still contains historical Home/Inspector and
   other feature blocks. The current Home and Inspector use their newer scoped
   implementations, and the foundation layer normalizes active ergonomics, but
   the old source should still be deleted/extracted in a dedicated cleanup with
   an executable checkout and visual regression pass.
2. The Caption sidebar still adapts the existing workspace markup with scoped
   selectors including `:has()`. The active typography/token inconsistencies are
   fixed, and the native font picker is gone, but changing the DOM structure only
   to eliminate those selectors would be a broader caption rewrite. Preserve the
   existing virtualization and patch behavior when that extraction is done.

These are maintainability follow-ups, not missing user-facing behavior in the
implemented audit closure. They remain visible in the plan because full PR/CI
verification and the dedicated legacy-CSS extraction have not been performed.

## Repository bookkeeping

The focused plan and all directly editable UI documentation are updated on this
branch. The connector available in this session can replace a complete repository
file but cannot safely apply a small line patch to the very large root
`plan/PLAN.md` or `CHANGELOG.md`. Reconstructing either file wholesale through a
connector response would risk unrelated historical content, so the master-plan
link and root Unreleased changelog entry are intentionally left for the mounted
checkout used during deferred verification. This gap is tracked explicitly in
`plan/UI-SYSTEM-AUDIT-CLOSURE.md` and the pull request description.

## Verification state

- No GitHub Actions status, workflow run, workflow log, or CI result was inspected.
- No repository-wide verification command was run.
- Focused tests were authored and the PR patch was reviewed file by file, but no
  package command is represented as passing because this session has no mounted
  private-repository checkout.
- Full PR/CI verification is intentionally deferred.
- The plan remains `[~]` until the required broader verification is completed.
