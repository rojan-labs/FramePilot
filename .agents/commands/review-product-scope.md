---
description: Review proposed FramePilot work for product focus, minimum vertical slice, and overengineering risk
---

Review the proposed task against the mandatory product discipline rules in
`.agents/rules/product-discipline.mdc` before implementation.

Prefer delegating to the `product-scope-reviewer` subagent when the harness supports it.

Return:

1. **User outcome** - what concrete user result improves.
2. **Current gap** - what is blocked, weak, slow, unreliable, or impossible today.
3. **Minimum vertical slice** - the smallest end-to-end implementation that proves value.
4. **Reuse plan** - existing operations, schemas, tools, render paths, analysis, UI, and storage
   that should be reused.
5. **Deferred scope** - tempting adjacent work that should stay out of this task.
6. **Evidence required** - the test, timeline result, render, fixture, or measurement required
   before calling it complete.
7. **Overengineering risks** - speculative abstractions, new runtimes, parallel sources of truth,
   excessive planning, or mega-PR risk.
8. **Verdict** - `PROCEED`, `SHRINK`, `DEFER`, or `MAINTAINER DECISION`.

Do not implement anything during this command. Focused security, data-loss, correctness, severe
performance regression, and release-blocker work may proceed with a narrower scope review.
