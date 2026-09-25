Goal: implement plan/elements in /Users/rjach/Stuffs/FramePilot end to end, production ready: Stock becomes Elements (Photos · Videos · Stickers · Shapes), CapCut-style, with large sticker and shape libraries.

Read first: plan/elements/ (README, 09-PHASES, 12-SURFACE-COVERAGE, 13-PRODUCTION-READINESS), AGENTS.md, CLAUDE.md; re-read each phase before starting it.

Git:

- No worktree. In the main checkout: git fetch; git switch -c feat/elements origin/docs/elements-plan. Leave others' uncommitted files alone.
- Commit and push after every coherent change: Conventional Commits with a why-body; no step/phase/task numbers and no AI attribution in messages.
- Stage exact paths. Never git add -A/-u/., git stash, --no-verify or force-push.
- After the first push, open one ready-for-review PR to main (CI skips drafts) and keep pushing to it.

Order: EL1 → EL2a → EL3 → EL4a → EL5 → EL6a → EL2b → EL6b → EL7 → EL8 → EL9 → EL10 → EL11 → EL12. Mark each task [~] when you start and [x] once its DoD, every 12-SURFACE-COVERAGE row tagged with it, and the 13 §1 checklist hold with evidence.

Decide autonomously. Answer MD-E1…MD-E7 with the plan's recommended answer when the phase needs it, and record each in README §1 as "decided autonomously, <date>". For any other ambiguity, choose what best serves correctness, preview/export parity and the user outcome, and record it in the plan or an ADR. Never stop to ask.

Rules that cannot bend:

- Every edit is a typed, validated, reversible op; the AI returns patches. Test apply and invert.
- Preview equals export: every new PX4 oracle row lands passing; TS and Python vectors equal.
- A schema change means migration, Pydantic twin, schema:generate and drift tests.
- Never rename persisted or model-facing ids (`stock_pexels_*`, `search_stock`/`add_stock`, `framepilot:stock:*`).
- No new dependency without pnpm license:scan. A new env var goes into .env.example and turbo.json in the same commit.
- Scoped loggers only, never console.log or print.
- Error messages state a remedy and contain no varying numbers.

Verification — asynchronous, never idle:

- Write the failing test first.
- Never wait on tests: run targeted tests, typecheck and lint for what you touched in the background (engine: uv run), keep building, and act on results as they land. Full suites, e2e, the oracle and golden runs are CI-only (they exhaust local memory).
- Never wait on CI either: push and move on; check the latest head SHA's checks later (a push cancels the in-flight run). A red check jumps the queue.
- A phase is [x] only when CI is green on a SHA that contains it.

When something breaks, fix it yourself:

- Find the root cause and fix it properly. Never skip, delete or weaken a test or gate; never mark unverified work done.
- A newly found surface or bug gets a 12-SURFACE-COVERAGE or plan entry and a fix in the same PR.
- Truly external tasks (legal review, signing certificates, real-media desktop runs, manual macOS/Windows passes): mark [!] with the reason and exact human instructions, then continue with the next independent task.

Every phase also updates the guides, ADRs, CHANGELOG.md, plan/PLAN.md and the plan ledger; at the end, the website and the runbook.

Done when every phase is [x] and the 13 §10 release gate holds, or the only open items are [!] human-only ones with instructions. Then post a final report: what shipped, CI links for the final SHA, evidence, remaining human steps.
