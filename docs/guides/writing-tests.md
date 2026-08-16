# Writing Tests

Testing is load-bearing in FramePilot: the entire reliability thesis (concrete,
reviewable, reversible edits) only holds if the editing engine, validator, AI tools, and
render validation are thoroughly tested. This page covers the test types, where they live,
coverage targets, and the rules. See PRD §16 and the `media-pipeline`,
`correctness-verification`, and `e2e-testing` skills under `.agents/skills/`.

---

## Test types & where they live

| Type              | Tool            | Location                  | Covers                                                                                                                      |
| ----------------- | --------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Unit              | Vitest          | `packages/*` (co-located) | Timeline ops, patch validator, schema parsing, keyframe interpolation, caption alignment, export settings, AI tool schemas. |
| Unit (engine)     | pytest          | `engine/python/tests`     | Render compiler, render validation, media inspection, masks, tracking.                                                      |
| Integration       | Vitest / pytest | packages + engine         | Import → proxy → transcript → apply patch → render preview → export.                                                        |
| E2E               | Playwright      | `tests/e2e/specs`         | Full user flows (see below).                                                                                                |
| Visual regression | Playwright      | `tests/e2e`               | Timeline UI, caption overlay, text-behind-object, export frame, mask editor, color panel, keyframe panel.                   |
| Golden media      | pytest          | `engine/python/tests`     | Render output metadata + frame-hash tolerance.                                                                              |

---

## Coverage expectations (PRD §16.1)

**There is no coverage percentage to hit and no coverage gate in CI.** What matters is
that the core deterministic modules are covered where it counts — every behavior branch
and every user-reachable error path:

- timeline operations (each `apply` **and** its `invert`),
- patch validation,
- AI tool schemas,
- render validation.

UI gets component, integration, e2e, visual-regression, and accessibility coverage.
Coverage must be **real** — exercise critical behavior through real workflows, not vanity
lines written to move a number. See
[../adr/0110-no-coverage-percentage-gate.md](../adr/0110-no-coverage-percentage-gate.md)
for why the 100% gate was removed.

---

## E2E flows that must stay green (PRD §16.1)

```
Create project → Import video → Generate transcript → Add captions →
Trim clip → Add text overlay → Use AI edit command → Review timeline diff →
Apply patch → Undo patch → Render preview → Export final video → Validate output
```

Every critical user flow must have e2e coverage. Use **fixture videos**, do **not** rely
on the network, and record screenshots/video on failure.

### Browser E2E suite layout (`tests/e2e/specs`)

The suite runs against the **in-browser** build of `apps/web-editor` (Playwright's
`webServer` boots `vite --host 127.0.0.1`, since Vite binds IPv6 `localhost` by default
and `baseURL` is the IPv4 loopback). It runs fully offline: the **mock** AI provider is
the browser default, with no Electron and no Python engine. The app boots into a seeded
"Demo Project" (`src/editor/demo.ts`) that stands in for an opened `project.fp.json`.

| Spec                                | §16.1 flow(s)                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| `smoke.spec.ts`                     | boots, core chrome + rails reachable                                                |
| `project-and-transport.spec.ts`     | load project, New project, Space/J/K/L + Home/End transport                         |
| `timeline-interaction.spec.ts`      | select → split (S) → drag-trim → drag-move → delete → undo/redo → ruler seek → zoom |
| `transcript-and-captions.spec.ts`   | transcript view + seek-on-click; Generate captions (+ undo)                         |
| `ai-edit-review-apply-undo.spec.ts` | mock AI propose → review diff → apply → undo; reject; chat                          |
| `preview-export-validate.spec.ts`   | preview engine surface; export desktop-only boundary                                |
| `visual.spec.ts`                    | `@visual` screenshot regression of timeline/captions/color/keyframe/mask/AI panels  |

Assert **real outcomes**, not just presence: clip count, the clip's `left`/`width` px
geometry (a faithful `secondsToPx` proxy for `start`/`duration`), the exact AI diff
summary line, caption-clip count, and the playhead readout — and that **undo reverts**
each edit. Selectors prefer role/label (matching the real DOM); shared helpers live in
`specs/helpers.ts`.

**Out of scope for browser e2e (documented, never faked):** real export/render + output
validation (duration/streams) and live media import/transcription run only in the
Electron desktop shell driving the deterministic Python MoviePy engine (render-vs-preview
rule). Those are covered by the Python engine's golden-media/validation tests. See the
rationale comment in `preview-export-validate.spec.ts`.

### Running the suite

```bash
pnpm test:e2e                                   # functional flows (excludes @visual)
pnpm --filter @framepilot/e2e test:visual       # visual regression (current platform)
pnpm --filter @framepilot/e2e test:visual:update # regenerate baselines for this platform
```

**Visual baselines are environment-sensitive** — font anti-aliasing differs between
macOS and Linux. The committed golden set is macOS (`*-chromium-darwin.png`), so the blocking
`e2e-visual` CI job also runs on macOS and compares against it; CI never updates snapshots.
The `@visual` suite remains split from functional smoke (`pnpm test:e2e` excludes it) so failures
have an unambiguous report. A pinned 1280x800 viewport plus
`reducedMotion: 'reduce'` (the app honours `prefers-reduced-motion`) and a per-pixel
`maxDiffPixelRatio` tolerance keep the comparisons stable.

---

## Golden-media tests & tolerances (PRD §16.2)

Render output is validated against expected metadata and perceptual tolerances:

- exact checks for JSON/patch output;
- duration, resolution, fps, audio-stream, video-stream presence;
- **frame-hash within tolerance** (perceptual — never bit-exact, since codecs vary);
- caption timing, black-frame detection, audio-clipping detection.

**No render change without a golden-test update** (blocking CI rule). When intended output
changes, update the golden fixture in the same PR and explain why.

---

## Fixtures

- Live under `tests/fixtures` (JS/TS) and engine fixture dirs (Python).
- Use small, deterministic fixture videos so renders are fast and reproducible.
- The fixture project (e.g. `fixtures/basic/project.fp.json`) is rendered and validated in
  CI on every PR via the `framepilot` CLI
  ([../api/python-engine-api.md](../api/python-engine-api.md)).

---

## Rules

- **No network in tests.** Use the `mock` AI provider
  ([ai-providers.md](ai-providers.md)) and local fixtures.
- **No skipped tests without a linked issue** (blocking CI rule).
- **Behavior change ⇒ test change** — update tests in the same PR as the behavior.
- New timeline operations must include round-trip (`invert(apply(...))`) tests — see
  [adding-a-timeline-operation.md](adding-a-timeline-operation.md).

Generated test/coverage artifacts land in the repo-root `reports/` tree; human-written
summaries live in [../reports/](../reports/README.md).
