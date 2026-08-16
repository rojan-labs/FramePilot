# AGENTS.md - Universal Rules for All Agents

> **Canonical shared instruction file** for every AI coding agent working in this
> repo (Codex, Cursor, OpenCode, Claude Code, and any other). Project agent assets
> live under `.agents/`; harness-specific paths (`.cursor/rules`, `.claude/agents`,
> `.claude/commands`, `.codex/agents`, `.opencode/agent.json`) are adapters that
> reference those canonical files.
>
> **Quality, SECURITY, CORRECTNESS, and PRODUCT FOCUS are the priority.** When in
> doubt, do the safe, correct, tested, smallest useful thing. Never choose speed,
> cleverness, speculative architecture, or "magic" over those priorities.

---

## 1. Project mission

FramePilot is **"Cursor for video editing"**: a desktop editor where the user can
edit a video manually _and_ ask an AI agent to edit the **timeline**. The agent
never renders "magic" - it produces **typed, schema-validated, reversible timeline
operations (patches)** that a **deterministic Python render engine** executes and
that the app **automatically validates**.

The human stays in control through project authority, visible timeline changes,
diffs/receipts, undo, and deterministic state. A configured auto-apply policy may
commit a validated AI patch immediately; expensive perceptual review must not be
misrepresented as the authority that makes a typed patch safe to apply.

Read `PRD.md` for the full product spec and `plan/PLAN.md` for the live build plan.

### The six invariants (never violate these)

1. **Non-destructive** - never modify or delete original media. Edits are timeline ops.
2. **Every AI edit is a typed timeline operation** - no free-form mutation.
3. **Every operation is validated** before it is applied (PRD §8.5).
4. **Every render is checked automatically** after it runs (PRD §9.4).
5. **AI edits ONLY through registered, schema-validated tools and returns patches** -
   never a raw mutation of `project.fp.json`. Patches are reversible and host-authoritative.
6. **Finish the core user outcome before expanding product breadth.** Do not grow
   FramePilot into a wider professional NLE or add generalized infrastructure unless it
   directly unlocks a current workflow, closes a measured gap, or the maintainer explicitly
   chooses that scope.

**Build order is non-negotiable (PRD §23, plan strategy):** timeline + patch engine
→ deterministic render + validation → AI layer → professional compositing → full
agent mode. **Build the engine before the AI layer.**

### Product discipline and scope gate - hard rule

Read **`.agents/rules/product-discipline.mdc` before non-trivial feature, architecture,
or plan expansion.** It is an always-on canonical rule.

The default product benchmark is the first niche already defined by the PRD: SaaS demos,
screen recordings, product videos, talking-head content, and short-form edits. Major editing
work should make the end-to-end **raw footage → strong finished edit** loop better in quality,
speed, reliability, control, or observability.

Before expanding the product surface, answer:

- what concrete user outcome improves;
- what current workflow gap exists;
- what the minimum end-to-end vertical slice is;
- which existing primitives will be reused;
- what adjacent scope is explicitly deferred;
- what evidence proves completion.

If those answers are weak, **shrink or defer the work rather than expanding architecture.**
Use the `product-scope-reviewer` subagent or `/review-product-scope` command when available,
especially for new subsystems, new editing domains, large sub-plans, multiple ADRs, or work
that crosses several architecture layers.

**A schema, worker, backend, tool, ADR, or plan is not a shipped editing capability by itself.**
For an applicable editing feature, the usable path must exist end to end: user entry → target
resolution → operation/tool → validation → preview → render/export semantics → undo → failure
state → tests.

---

## 2. Architecture summary

Monorepo: **pnpm workspaces + Turbo** for TS, **`uv`** for the Python engine.

```
apps/
  desktop/          Electron shell (main/preload/renderer); secure IPC; spawns Python sidecar
  web-editor/       React + TS editor UI (timeline, preview, panels)
packages/
  timeline-schema/  Project/Timeline/Track/Clip/Effect/Keyframe schemas (Zod), versioning + migrations
  shared-types/     Cross-package TS types
  editor-core/      Typed timeline operations + patch engine (apply/invert/validate/diff/undo)
  ai-sdk/           AI orchestrator, tool registry, context builder, memory store (TS)
  ui/               Shared React components
engine/python/      framepilot_engine: render/ timeline/ effects/ audio/ tracking/ masking/ validation/ ai_tools/
tests/e2e/          Playwright end-to-end suite
plan/PLAN.md        Master living build plan (source of truth for execution)
docs/               architecture/ adr/ api/ guides/ runbooks/ reports/
```

**Render engine vs preview engine (PRD §9.2 - hard rule):**

- **Render engine** = Python **MoviePy + FFmpeg**. Used for final export, preview
  _render_, waveforms, frame extraction, masks, tracking, proxies. **Deterministic.**
- **Preview engine** = the UI. Uses **HTML `<video>`, canvas/WebGL overlays, proxy
  / low-res media**. **MoviePy must never be used for real-time UI preview.**

**Package boundaries:** AI never imports the render engine directly to mutate state;
it goes through tools → patches → editor-core → validated apply. Keep the Python
render engine isolated so the desktop shell choice can change later.

---

## 3. Setup commands

```bash
pnpm install            # JS/TS workspaces
pnpm engine:sync        # uv sync in engine/python
cp .env.example .env    # fill secrets locally (never commit .env)
```

## 4. Test & verify commands

```bash
pnpm test               # all TS unit/integration (turbo)
pnpm test:coverage      # coverage
pnpm test:e2e           # Playwright e2e
pnpm lint               # eslint
pnpm typecheck          # tsc
pnpm engine:test        # pytest
pnpm engine:test:cov    # pytest --cov
pnpm engine:lint        # ruff
pnpm engine:typecheck   # mypy
pnpm license:scan       # dependency license gate
pnpm verify             # typecheck + lint + test + engine:test (run before declaring done)
```

**After every edit, run the affected tests.** Do not declare work complete on an
unverified change.

---

## 5. Coverage rules

- **Cover the core deterministic modules thoroughly** (PRD §16.1) - every branch
  that changes behavior, every error path a user can hit:
  - timeline operations (`packages/editor-core`)
  - patch validator
  - AI tool schemas / input validation (`packages/ai-sdk`, `engine/python/.../ai_tools`)
  - render validation (`engine/python/.../validation`)
- UI: component, integration, e2e, visual regression, accessibility tests.
- **No vanity coverage.** Critical behavior must be exercised through real
  workflows, not lines hit by accident. Every operation tests `apply` **and** `invert`.
- **No coverage gate.** There is no percentage to hit and no threshold in any config
  (ADR 0110) - coverage is reported as a diagnostic for finding untested behavior.
- **No skipped tests** without a linked issue.

---

## 6. Safety rules (PRIORITY - see `.agents/rules/security.mdc`)

- **Path sandbox:** all file ops resolve inside the project directory
  (`FRAMEPILOT_PROJECTS_ROOT`). Reject path traversal (`..`, absolute escapes,
  symlink escapes). Use safe path resolution helpers.
- **No arbitrary shell from the agent runtime.** The in-app AI agent can ONLY call
  registered tools - never execute shell, eval, or spawn processes.
- **Schema-validate every tool input** before doing anything with it.
- **Never delete or overwrite originals.** Never overwrite user files without
  explicit confirmation. Renders go to the project `renders/` folder.
- **Secrets live in `.env` only.** Never commit `.env`, media, renders, or keys.
- **Render jobs must have a timeout and cancellation** (`FRAMEPILOT_RENDER_TIMEOUT_SECONDS`).
- **Electron hardening:** `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, IPC only through the preload bridge.

---

## 7. Code style

- **TypeScript:** `strict` mode; no `any` (use `unknown` + narrowing); named exports;
  small focused functions; early returns; meaningful names; no magic numbers/strings.
- **Python:** `ruff` + `mypy --strict`; `pathlib` over string paths; type hints
  everywhere; deterministic, side-effect-isolated functions.
- **Errors:** typed, with context (what failed, which id/path, why). No silent catch.
- **Comments:** explain **WHY**, not WHAT. JSDoc/docstrings on public APIs.
- **Logging:** every new module that does anything worth tracing (patch application,
  provider/tool calls, IPC handlers, render/queue steps) must log through the shared
  scoped logger - TS via `createLogger('<pkg>:<module>')` from `@framepilot/shared-types`
  (`packages/shared-types/src/logger.ts`), Python via the equivalent `logging.getLogger`
  scoped logger in `engine/python`. Use `log.action(...)` for high-signal events (a run
  started, a patch applied, an IPC call handled) and `debug`/`warn`/`error` for the rest.
  Never reach for a bare `console.log`/`print` in library code - untagged output can't be
  filtered or attributed when debugging a live session.
- **Conventional Commits** (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`).
- **Small, reviewable patches.** No large unreviewed rewrites.

---

## 8. Forbidden shortcuts

- ❌ Bypassing, deleting, or skipping a failing test to make CI green.
- ❌ Changing the timeline/project schema without a **migration** (PRD §11, plan §1.1).
- ❌ Adding a dependency without a **license check** (`pnpm license:scan`).
- ❌ AI directly mutating `project.fp.json` - must go through tools → patches.
- ❌ A timeline operation that is not validated before apply, or not reversible.
- ❌ A render change without a **golden-test update**.
- ❌ Using MoviePy for the UI preview path.
- ❌ Committing media, renders, secrets, or `.env`.
- ❌ Marking backend-only, placeholder, hardcoded-demo, or docs-only work as a shipped
  editing capability.
- ❌ Building speculative frameworks, runtimes, stores, plugin systems, provider layers,
  or generalized abstractions without a current concrete consumer or explicit maintainer decision.
- ❌ Bundling several unrelated subsystems into a mega-PR when vertical slices are possible.

---

## 9. Definition of Done (PRD §20)

A unit of work is done **only** when:

- The concrete user outcome described by the task works end to end at the applicable layer.
- Feature works manually **and** through its AI tool call (if applicable).
- Timeline operation is **reversible** (apply + invert tested).
- Schema is documented; any schema change has a migration.
- Unit + integration tests added; **e2e test added for critical flows**.
- Core deterministic modules are meaningfully covered (behavior + error paths).
- **Render output is validated** (PRD §9.4) where rendering is involved.
- Visual/audio completion claims have the appropriate render-backed or deterministic evidence.
- User-facing errors are clear and typed.
- Agent rules / skills updated if behavior changed.
- **`plan/PLAN.md` updated** (task checked off only when DoD is met).
- **`docs/` and `CHANGELOG.md` updated.**
- Adjacent scope that was intentionally deferred remains deferred instead of being silently
  bundled into the task.

CI gates that must pass (PRD §17): TS typecheck, Python typecheck, lint, unit,
integration, coverage, e2e smoke, license scan, desktop build, render fixture project.

---

## 10. Plan discipline (PRIORITY - see `.agents/rules/plan-management.mdc`)

- **Before starting work:** read `plan/PLAN.md`. Find or add your task.
- For non-trivial feature/architecture work, run the product scope gate in
  `.agents/rules/product-discipline.mdc` before expanding the plan.
- **When starting:** mark it `[~]`.
- **When done (DoD met, tested):** mark it `[x]`. Never check off untested work.
- **Discovered work:** add new `[ ]` tasks. If a sub-area is large, create a new
  plan doc under `plan/` and link it only after confirming the sub-area is justified by the
  current product scope.
- Keep the **"Status snapshot"** and **"Last updated"** date current.
- See `.agents/skills/plan-keeper/SKILL.md`.

## 11. Docs discipline (PRIORITY - see `.agents/rules/documentation.mdc`)

- **Every change updates `docs/`.** New feature → guide and/or API doc. Architectural
  decision → new **ADR** in `docs/adr/` (template + incrementing number).
  User-facing change → `CHANGELOG.md` (Keep a Changelog format).
- Keep docs in sync with code; document **WHY**. Create docs proactively.
- Keep design documentation proportional to the decision. A large plan or ADR set must lead to
  a near-term executable vertical slice; documentation volume is not implementation progress.
- See `.agents/skills/docs-maintainer/SKILL.md`.

---

## 12. Skills & workflows

Reusable workflows live in `.agents/skills/<name>/SKILL.md`:
`timeline-editing`, `render-debugging`, `e2e-testing`, `ai-safety`,
`media-pipeline`, `security-hardening`, `correctness-verification`,
`plan-keeper`, `docs-maintainer`, `changelog-maintainer`. Read the matching skill
before doing that work.

Always-on rules live under `.agents/rules/`, including the priority
`product-discipline.mdc` scope gate.

Rules, commands, and subagent definitions also live under `.agents/`:
`.agents/rules`, `.agents/commands`, `.agents/agents/claude`,
`.agents/agents/codex`, and `.agents/agents/opencode`. Update these canonical
files first, then keep harness adapters and docs in sync.
