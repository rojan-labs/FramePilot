Goal: implement the Elements programme in /Users/rjach/Stuffs/FramePilot end to end, production ready. Stock becomes Elements (Photos · Videos · Stickers · Shapes), CapCut-style, with large sticker and shape libraries.

Source of truth: plan/elements/ (README, 09-PHASES, 12-SURFACE-COVERAGE, 13-PRODUCTION-READINESS), plus AGENTS.md and CLAUDE.md. Read them first; re-read the phase you are on before starting it.

Git:

- No worktree. In the main checkout: git fetch; git switch -c feat/elements origin/docs/elements-plan. Leave other people's uncommitted files alone.
- Commit and push after every coherent change. Conventional Commits whose body explains why. Never put step, phase or task numbers in commit messages, and no AI attribution lines.
- Stage exact paths. Never git add -A/-u/., git stash, --no-verify or force-push.
- After the first push, open one ready-for-review PR to main (CI skips drafts) and keep pushing to it.

Order: EL1 → EL2a → EL3 → EL4a → EL5 → EL6a → EL2b → EL6b → EL7 → EL8 → EL9 → EL10 → EL11 → EL12. Mark each task [~] when you start and [x] only when its DoD, every 12-SURFACE-COVERAGE row tagged with it, and the 13 §1 checklist hold with evidence.

Decide autonomously. Answer MD-E1…MD-E7 with the plan's recommended answer when the phase needs it, and record each in README §1 as "decided autonomously, <date>". For any other ambiguity, choose what best serves correctness, preview/export parity, and the user outcome. Record decisions in the plan or an ADR. Never stop to ask.

Rules that cannot bend:

- Every edit is a typed, validated, reversible op, and the AI returns patches. Test apply and invert.
- Preview must equal export. Add each new PX4 oracle row passing, with vectors equal in TS and Python.
- A schema change means migration, Pydantic twin, schema:generate and drift tests.
- Never rename persisted or model-facing ids (`stock_pexels_*`, `search_stock`/`add_stock`, `framepilot:stock:*`).
- No new dependency without pnpm license:scan. A new env var goes into .env.example and turbo.json in the same commit.
- Use the scoped loggers, never console.log or print.
- Error messages state a remedy and contain no varying numbers.

Verification:

- Write the failing test first.
- Locally, run only the tests, typecheck and lint for what you touched (engine: uv run). Never run full suites, e2e, the oracle or golden runs locally (they exhaust the machine's memory). CI does that.
- After each push, read the checks for that exact head SHA and fix red before moving on.

When something breaks, fix it yourself:

- Find the root cause and fix it properly. Never skip, delete or weaken a test or gate, and never mark unverified work done.
- If a new surface or bug turns up, add it to 12-SURFACE-COVERAGE or the plan in the same PR and fix it.
- If a task is truly external (legal review, signing certificates, real-media desktop runs, a manual macOS/Windows pass), mark it [!] with the reason and exact instructions for a human, then carry on with the next independent task.

Every phase also updates: docs/guides/elements.md and the other guides, ADRs, CHANGELOG.md, plan/PLAN.md and the plan ledger. At the end, the website and the runbook.

Done when every phase is [x] and the release gate in 13 §10 holds, or the only open items are [!] human-only ones listed with instructions. Then post a final report: what shipped, CI links for the final SHA, evidence, and any remaining human steps.
