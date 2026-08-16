# Authoring skills

Skills are developer-authored knowledge modules that teach the AI agent editing craft —
"how keyframe animation should be done", "how to pace a short" — without bloating every
run's context. Craft belongs here because its domain-specific heuristics change
independently from the global authority and orchestration rules; keeping those concerns
separate avoids duplicated or conflicting instructions during a long run. Only a
one-line manifest entry per skill rides in the agent's context; the full body loads on
demand when the model calls the `load_skill` tool. See
[ADR 0057](../adr/0057-runtime-skills.md) for the loading design and
[ADR 0077](../adr/0077-layered-prompt-and-editing-knowledge-architecture.md) for the
responsibility split.

## Where skills live

`packages/ai-sdk/skills/<name>.md` — bundled into the SDK at build time and
served identically by the desktop app, the web editor, and the MCP server.
There are no user-facing skills folders and no runtime filesystem access.

## File format

Strict frontmatter, then the markdown playbook:

```markdown
---
name: keyframe-animation
description: How to animate clip properties (scale, position, opacity) with keyframes.
tools: [get_timeline, add_keyframes, punch_in]
---

# Keyframe animation

## Purpose

Direct attention with technically valid, clip-relative animation.

## When to use

Punch-ins, pans, drifts, and overlay fades.
```

Rules (enforced by `SkillSchema` in `packages/ai-sdk/src/skills.ts`):

- `name` — kebab-case, unique across the bundle. The model uses it to call
  `load_skill`, so keep it short and descriptive.
- `description` — one line, ≤ 300 chars, **written for the model**: it is the
  only thing the agent sees before deciding whether to load the skill, so say
  _when_ to use it, not just what it is.
- `tools` — optional inline list. Every entry must name a registered tool
  (`TOOL_REGISTRY`); unknown names are dropped with a warning at load time
  (ADR 0055: never advertise a capability that does not exist). In v1 this is
  documentation/validation only — it does not re-scope the agent's tools.
- Body — non-empty markdown, ≤ 32,768 characters. Bundled professional knowledge
  modules are additionally tested below 8,000 characters because loaded bodies are
  pinned for the run.
- At most 32 skills may be bundled.

`SkillSchema` enforces the metadata and body bounds. The bundled-skills test, rather
than the runtime schema, enforces the professional section contract below and the
8,000-character authoring limit. This keeps runtime parsing backward-compatible while
preventing incomplete first-party modules from shipping.

## Workflow

1. Create or edit `packages/ai-sdk/skills/<name>.md`.
2. Regenerate the bundles:

   ```sh
   pnpm --filter @framepilot/ai-sdk generate:skills
   ```

   This rewrites the two **committed** generated modules:
   - `packages/ai-sdk/src/skills/generated.ts` (raw text, parsed by the SDK)
   - `engine/python/framepilot_engine/ai_tools/skills_generated.py`
     (pre-parsed Python mirror, served by the engine's `load_skill`)

   `pnpm build` in the package runs the codegen automatically; a unit test
   (`skills.test.ts` → "generated.ts is in sync") fails if you commit an edited
   `.md` without regenerating.

3. Run the tests: `pnpm --filter @framepilot/ai-sdk test` (the bundled-skills
   test asserts your new file parses cleanly and names only real tools) and
   `pnpm engine:test` for the Python mirror.
4. Commit the `.md` **and** both generated files together.

## How skills reach the model

- `assembleContext` injects a `skills` tier (one manifest line per skill plus
  the instruction to call `load_skill`). Agent runs get the bundled skills by
  default; chat/edit modes only include them when the caller passes
  `ContextInput.skills`.
- Under context-budget pressure the skills tier is dropped after `timeline`
  but before `memory`. The bodies remain available to `load_skill`, but dropping
  the manifest removes automatic discovery for that turn.
- `load_skill` is a plain read tool: it returns
  `{ name, description, tools, body }` from `ToolContext.skills`, or an error
  listing the valid names.
- Once loaded, a body is removed from the rolling action log and pinned into the
  run-stable instruction head. Repeat loads point to that pinned copy. A run may
  pin at most eight bodies; further loads are refused honestly rather than silently
  growing or truncating the prompt.

## Writing tips

- One skill owns one professional decision boundary. Put shared authority,
  recovery, source/sequence timing, and tool-safety laws in the agent contract;
  put editing psychology, trade-offs, heuristics, and quality standards here.
- Every module uses this retrieval-stable structure: **Purpose**, **When to
  use**, **When not to use**, **Required inputs**, **Expected outputs**, **Core
  philosophy**, **Professional heuristics**, **Decision framework**, **Common
  mistakes**, **Verification checklist**, **Recovery advice**, **Related
  skills**. Each section must carry domain-specific information, not boilerplate.
- Name only registered tools. Describe their current limits honestly; never
  infer a detector, renderer, or effect capability from industry convention.
- Route adjacent craft through **Related skills** instead of duplicating it.
  For example, beat syncing owns music/visual alignment while speed ramping owns
  retiming physics and transition grammar owns effect meaning.
- Write verification as observable timeline/render/audio checks, never “did you
  follow the steps?” A successful tool response proves application, not quality.
- Recovery continues from the smallest failed region. A skill must never tell
  the agent to wipe partial work or restart a long run.

## Current limitations

- Skills are build-time, first-party content. There is no user skill directory,
  runtime filesystem loading, or hot reload.
- The `tools` list documents and validates required capabilities but does not narrow
  the tool surface available to a run.
- The eight-body pin limit is per run, so modules should keep related-skill routing
  selective instead of asking the agent to preload an entire chain.
- Skill advice cannot prove correctness. Authors must route technical checks to the
  available deterministic verification tools and describe unsupported checks honestly.
