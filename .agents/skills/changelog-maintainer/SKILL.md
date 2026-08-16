# Skill: Changelog Maintainer

Keep the **public, customer-facing changelog** on the marketing website current:
`apps/website/content/changelog/*.mdx`, surfaced at `/changelog`.

## Audience — read this first

This changelog is for **customers**: creators and editors who use FramePilot and
**do not read code**. It is NOT the developer changelog.

- **Developer changelog** — root `CHANGELOG.md` (Keep a Changelog, engineer-facing:
  modules, tests, schemas, ADRs). Owned by the `docs-maintainer`. **Source material.**
- **Customer changelog** — `apps/website/content/changelog/*.mdx` (plain language,
  benefit-first). Owned by **you**. **The deliverable.**

Your job is to **translate** shipped changes from the developer record (and the plan,
PRs, and commits) into language a non-technical customer understands and cares about.

## When to use

- A user-visible feature, improvement, or fix has shipped (or is being released).
- The root `CHANGELOG.md` gained entries under `[Unreleased]` that affect customers.
- A release/version is being cut and needs a public "What's new" entry.

## Translate, don't copy

Rewrite every change around **what the customer can now do**, not how it was built.

| Instead of (developer)                                                       | Write (customer)                                                                       |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| "Added `analyze_silence` tool via `silencedetect`; parser at 100% coverage." | "Ask the agent to find silent gaps and dead air, then trim them in one pass."          |
| "Electron license gate with device-uid activation + 7-day offline grace."    | "Activate once with your key and keep editing — even offline for up to a week."        |
| "Retry with exponential backoff + jitter honoring Retry-After."              | "If the AI service is briefly busy, FramePilot retries on its own instead of failing." |

Rules:

- **No internal detail.** Never mention module/file names, function names, test counts,
  coverage, schemas, ADR numbers, dependencies, or IPC/sidecar plumbing.
- **Benefit first.** Lead with the outcome for the user; keep it concrete and warm.
- **No jargon.** Avoid "patch", "sidecar", "orchestrator", "Pydantic", etc. Prefer
  "the agent", "your timeline", "captions", "exports".
- **Honest.** Only list what actually shipped and is user-visible. Skip pure-internal
  refactors, CI, and test-only changes entirely.
- **No links** — especially no GitHub/repo links. This page is self-contained.

## File format

One `.mdx` file per release under `apps/website/content/changelog/`, named
`YYYY-MM-DD-short-slug.mdx` (date it shipped + kebab-case slug). Newest sorts first
automatically (by `date`).

```mdx
---
title: 'Smarter cleanup: find silences and scene changes'
summary: 'Ask the agent to find dead air or spot where each shot begins — then cut in one click.'
date: '2026-07-04'
version: '1.1.0' # optional product version
tags: ['New', 'Improved'] # any of: New, Improved, Fixed — match the sections below
---

### New

- **Short bold lead-in.** One or two sentences of plain-language benefit.

### Improved

- **Short bold lead-in.** What's better now, from the customer's point of view.

### Fixed

- **Short bold lead-in.** What annoyance is gone.
```

Frontmatter is validated by `apps/website/src/lib/changelog.ts` (`ChangelogFrontmatter`):
`title`, `summary`, `date` are required; `version`, `tags`, `draft` are optional. Keep
`tags` in sync with the `###` sections you actually include. Use only the tags
`New`, `Improved`, `Fixed`. Set `draft: true` to stage an entry that shouldn't publish yet.

## Workflow

1. **Gather what shipped.** Read the root `CHANGELOG.md` `[Unreleased]` section, recent
   `plan/PLAN.md` completed items, and (if needed) recent commits/PRs. Identify only the
   **user-visible** changes.
2. **Group + translate.** Sort each change into New / Improved / Fixed and rewrite it per
   the table and rules above. Merge tiny related items into one clear bullet.
3. **Write the entry.** Create `YYYY-MM-DD-slug.mdx` with complete frontmatter. Write a
   compelling `title` and a single-sentence `summary` (used on the page and for SEO).
4. **Verify.** From `apps/website/`, run `pnpm typecheck` and `pnpm build`; confirm the
   entry renders at `/changelog` and the chips match the sections.
5. **Record.** Note the customer-facing entry where appropriate and update `plan/PLAN.md`.

## Definition of done

- New `apps/website/content/changelog/YYYY-MM-DD-slug.mdx` exists with valid frontmatter.
- Copy is plain-language, benefit-first, jargon-free, link-free, and honest.
- `tags` match the sections present; `pnpm build` passes and `/changelog` renders it.
- No internal/engineering detail leaked from the developer `CHANGELOG.md`.
