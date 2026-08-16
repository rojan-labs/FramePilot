# PRD: Cursor for Video Editing

## 1. Product Name

Working name: **FramePilot**

Positioning:

> Cursor for professional video editing. Chat with your timeline, autocomplete edits, run agent mode, review timeline diffs, and render reliable video edits through a deterministic Python-based engine.

---

## 2. Core Idea

FramePilot is a desktop video editor powered by an AI agent system.

The user can edit manually like a normal video editor, but also ask the AI to:

- trim clips
- remove silence
- add captions
- track objects
- add text behind objects
- create masks
- add zoom keyframes
- improve pacing
- grade color
- mix sound
- create platform exports
- explain and preview every edit before applying

The app should feel like Cursor, but instead of modifying code files, the agent modifies the video timeline.

---

## 3. Core Product Principles

### 3.1 Non-destructive editing

The app should never directly destroy the original video.

Every edit becomes a timeline operation.

Example:

```json
{
  "type": "trim_clip",
  "clipId": "clip_001",
  "start": 4.2,
  "end": 26.8
}
```

### 3.2 Agent edits must be reviewable

Every AI action must show:

- what changed
- why it changed
- before/after preview
- timeline diff
- undo option

### 3.3 Deterministic rendering

The AI should not directly “render magic.”

The AI creates structured operations. The render engine executes those operations deterministically.

### 3.4 Human remains in control

Agent mode can plan and execute, but every major destructive edit should be reversible.

### 3.5 Professional workflow first

The app should eventually support Premiere-style capabilities:

- timeline editing
- keyframes
- masking
- object tracking
- captions
- sound mixing
- color grading
- transitions
- render presets
- project files

### 3.6 Reliability over fake magic

The app should avoid pretending it can do perfect creative judgment. It should show confidence levels, previews, and editable steps.

---

## 4. Target Users

### Primary users

- SaaS founders
- indie hackers
- developers making product demos
- content creators
- YouTubers
- short-form video editors
- tutorial creators
- agencies editing client videos

### First niche

Start with:

> AI editor for SaaS demos, screen recordings, product videos, and talking-head shorts.

This niche is better than trying to beat Premiere Pro immediately.

---

## 5. Main User Workflows

## 5.1 Upload and edit manually

User flow:

1. User creates project.
2. User imports video.
3. App generates proxy file.
4. App extracts audio waveform.
5. App generates transcript.
6. User edits on timeline.
7. User exports final video.

---

## 5.2 Chat with video

Example commands:

```txt
What is the strongest hook in this video?
Where should I cut boring parts?
Make this suitable for LinkedIn.
Add captions with highlighted keywords.
Find repeated parts and suggest cuts.
```

The AI reads:

- transcript
- timeline state
- clip metadata
- frame analysis
- audio waveform
- scene boundaries
- current selected range
- target platform

---

## 5.3 Cmd+K style AI edit

User selects a clip or time range and types:

```txt
Make this section faster and more engaging.
```

AI returns a small patch:

```txt
Proposed edit:
1. Remove 2.1 seconds of silence.
2. Add 1.15x speed ramp from 00:12 to 00:17.
3. Add punch-in zoom at 00:14.
4. Add caption emphasis on "saves 3 hours."
```

User actions:

```txt
Apply
Edit prompt
Preview
Reject
```

---

## 5.4 Agent mode

User gives a high-level goal:

```txt
Create a 45-second product demo for Instagram Reels.
```

Agent flow:

1. Analyze transcript.
2. Detect hook moments.
3. Detect boring or repeated segments.
4. Create edit plan.
5. Ask for approval.
6. Apply timeline operations.
7. Render preview.
8. Self-check output.
9. Suggest improvements.
10. Export final version.

---

## 5.5 Plan mode

Plan mode should not edit directly.

Example:

```txt
Plan a professional edit for this raw recording.
```

AI returns:

```txt
Edit Plan:
- Use 00:08 to 00:13 as the hook.
- Remove intro silence from 00:00 to 00:07.
- Keep product demo section from 00:18 to 00:44.
- Add captions with keyword highlights.
- Add zooms on UI clicks.
- Add CTA at the end.
```

User can then run:

```txt
Apply this plan.
```

---

## 5.6 Autocomplete edits

While user edits, AI suggests next actions:

```txt
Suggested:
Add zoom on the UI click at 00:18.
Remove silent gap at 00:23.
Add caption emphasis on "faster."
Change export to 9:16.
```

User can accept with one click.

---

## 6. Must-Have Professional Editing Features

## 6.1 Core timeline

Required:

- multi-track video
- multi-track audio
- overlay tracks
- caption tracks
- trim
- split
- delete
- move
- ripple delete
- snapping
- timeline zoom
- undo/redo
- project save/load
- markers
- nested sequences later

---

## 6.2 Captions

Required:

- automatic transcription
- word-level timestamps
- caption styling
- caption templates
- highlighted keywords
- manual edit
- caption burn-in
- subtitle export later

---

## 6.3 Motion and keyframes

Required:

- position
- scale
- rotation
- opacity
- crop
- blur
- audio volume
- easing curves
- keyframe editor
- AI-generated keyframes

Easing types:

```txt
linear
ease-in
ease-out
ease-in-out
hold
bezier
```

---

## 6.4 Object tracking

MVP:

- track face
- track object bounding box
- attach text to object
- blur tracked object
- add callout following object

Advanced:

- mask tracking
- occlusion handling
- manual correction
- tracking confidence score
- re-track from correction point

---

## 6.5 Masking

MVP:

- rectangle mask
- ellipse mask
- polygon mask
- feather
- opacity
- mask keyframes

Advanced:

- AI subject mask
- text behind object
- foreground/background separation
- mask propagation
- edge refinement

---

## 6.6 Text behind object

Pipeline:

1. User selects object.
2. AI creates subject mask.
3. App tracks mask across frames.
4. Text layer is placed behind subject.
5. Foreground subject is composited above text.
6. User can adjust mask errors.
7. Final render uses deterministic layer order.

---

## 6.7 Color grading

MVP:

- exposure
- contrast
- saturation
- temperature
- tint
- shadows
- highlights
- LUT import
- before/after preview

Advanced:

- curves
- color match
- skin tone protection
- scopes
- AI look generation
- shot-to-shot matching

---

## 6.8 Sound mixing

MVP:

- volume control
- fade in/out
- background music
- music ducking
- voice normalization
- noise reduction
- mute/split audio
- waveform display

Advanced:

- EQ
- compression
- limiter
- loudness target presets
- audio buses
- auto SFX placement

---

## 6.9 Transitions

MVP:

- cut
- fade
- cross dissolve
- push
- zoom transition
- blur transition
- whoosh sound sync

Advanced:

- rhythm-based transition suggestions
- beat detection
- motion-matched transition
- custom transition graph

---

## 7. Main AI Features

## 7.1 Chat

Purpose:

- answer questions about video
- explain timeline
- suggest edits
- generate hooks
- summarize story
- diagnose pacing

Example:

```txt
Why does this video feel slow?
```

AI answer:

```txt
The first 8 seconds contain setup without visual change. I recommend starting at 00:09 where the outcome is shown.
```

---

## 7.2 Edit

Purpose:

- apply selected timeline changes
- modify captions
- add overlays
- adjust pacing
- generate keyframes

Example:

```txt
Make the first 10 seconds more engaging.
```

Output:

```json
[
  {
    "type": "trim_clip",
    "clipId": "clip_001",
    "start": 3.4,
    "end": 10.0
  },
  {
    "type": "add_text_overlay",
    "text": "Launch faster",
    "start": 3.4,
    "end": 6.2
  }
]
```

---

## 7.3 Plan

Purpose:

- create edit strategy before modifying timeline

Required:

- no direct mutation
- no render action
- only structured plan

---

## 7.4 Agent Mode

Purpose:

- execute multi-step editing goals

Agent must:

- create plan
- ask for approval when needed
- use tools
- verify result
- create timeline diff
- create preview
- log all actions

---

## 7.5 Autocomplete

Purpose:

- suggest next best edit based on context

Triggers:

- playhead stops
- user selects clip
- user trims
- transcript selection
- empty timeline gap
- weak pacing detection
- long silence
- strong quote detected

---

## 8. AI Engine Architecture

## 8.1 Main components

```txt
AI Orchestrator
Tool Registry
Timeline Patch Engine
Context Builder
Memory Store
Plan Generator
Patch Validator
Render Preview Worker
Critic / Review Agent
```

---

## 8.2 AI Orchestrator

Responsibilities:

- receive user request
- build context
- choose mode
- call planner
- call tools
- validate operations
- return diff
- trigger preview
- store learning log

Modes:

```txt
chat
plan
edit
agent
autocomplete
review
```

---

## 8.3 Tool Registry

The AI can only edit through approved tools.

Core tools:

```txt
get_project_state
get_timeline
get_transcript
get_selected_range
analyze_silence
detect_scenes
detect_faces
track_object
generate_mask
add_text_layer
add_caption_layer
trim_clip
split_clip
delete_range
add_keyframes
apply_color_grade
adjust_audio
add_transition
render_preview
export_video
```

The AI must not directly mutate project JSON.

It must propose patches.

---

## 8.4 Timeline Patch Engine

Every edit is a patch.

Patch format:

```json
{
  "patchId": "patch_123",
  "createdBy": "agent",
  "reason": "Improve intro pacing",
  "operations": [
    {
      "type": "delete_range",
      "trackId": "video_1",
      "start": 0,
      "end": 3.2
    }
  ]
}
```

Patch lifecycle:

```txt
proposed
validated
previewed
applied
reverted
failed
```

---

## 8.5 Patch Validator

Before applying, validate:

- timeline references exist
- no negative duration
- no invalid layer order
- no missing asset
- no unsupported effect
- no broken audio link
- no overlapping state error
- render engine supports operation
- operation is reversible

---

## 8.6 Critic Agent

After agent edits, critic checks:

- did output match user request?
- did video duration match target?
- are captions aligned?
- are overlays inside safe area?
- is audio clipping?
- are there black frames?
- are there missing assets?
- are export settings correct?

---

## 8.7 Memory Store

Project memory:

```txt
target audience
brand style
caption style
preferred pacing
export platforms
previous accepted edits
previous rejected edits
```

Agent should learn from user corrections inside the project.

Example:

```txt
User prefers bold captions with yellow keyword highlight.
User rejects aggressive zooms.
User wants clean SaaS demo style.
```

---

## 9. Render Engine

## 9.1 Chosen engine

Use:

```txt
MoviePy + FFmpeg + Python render workers
```

MoviePy handles composable Python editing logic.

FFmpeg handles encoding and low-level media operations.

Python workers handle:

- render preview
- final export
- waveform generation
- frame extraction
- mask rendering
- tracking jobs
- proxy creation

---

## 9.2 Important architecture rule

MoviePy should be used as the render engine, not the real-time UI preview engine.

The UI preview should use:

```txt
HTML video
Canvas overlays
WebGL/canvas preview layers
proxy media
low-res previews
```

Final export should use Python render pipeline.

---

## 9.3 Render job lifecycle

```txt
queued
preparing_assets
rendering_frames
encoding
validating_output
completed
failed
```

---

## 9.4 Render validation

After render:

- verify file exists
- verify duration
- verify audio stream exists if expected
- verify video stream exists
- verify no zero-byte output
- detect black frames
- detect audio clipping
- compare expected timeline duration

---

## 10. Desktop App Architecture

## 10.1 Recommended stack

Preferred:

```txt
Tauri desktop shell
React frontend
TypeScript
Python sidecar service
MoviePy render engine
SQLite local database
Local file project storage
```

Alternative faster prototype:

```txt
Electron
React
TypeScript
Python child process
MoviePy render engine
SQLite
```

Recommendation:

- Use Electron for fastest MVP if speed matters.
- Use Tauri for cleaner long-term desktop app if you are comfortable with Rust sidecar integration.
- Keep the Python render engine isolated so shell choice can change later.

---

## 10.2 App processes

```txt
Desktop shell
Frontend editor
Python local API server
Render worker
AI orchestrator
Asset indexer
Background job queue
```

---

## 10.3 Local-first storage

Each project folder:

```txt
project-name/
  project.fp.json
  assets/
  proxies/
  renders/
  cache/
  transcripts/
  masks/
  waveforms/
  logs/
```

---

## 11. Data Model

## 11.1 Project

```json
{
  "id": "project_001",
  "name": "Demo Video",
  "version": 1,
  "fps": 30,
  "resolution": {
    "width": 1920,
    "height": 1080
  },
  "assets": [],
  "timeline": {},
  "transcript": [],
  "aiMemory": {},
  "history": []
}
```

---

## 11.2 Timeline

```json
{
  "tracks": [
    {
      "id": "video_1",
      "type": "video",
      "clips": []
    },
    {
      "id": "audio_1",
      "type": "audio",
      "clips": []
    },
    {
      "id": "caption_1",
      "type": "caption",
      "clips": []
    },
    {
      "id": "overlay_1",
      "type": "overlay",
      "clips": []
    }
  ]
}
```

---

## 11.3 Clip

```json
{
  "id": "clip_001",
  "assetId": "asset_001",
  "trackId": "video_1",
  "start": 0,
  "end": 12.5,
  "sourceStart": 4.0,
  "sourceEnd": 16.5,
  "effects": [],
  "keyframes": []
}
```

---

## 11.4 Effect

```json
{
  "id": "effect_001",
  "type": "transform",
  "params": {
    "scale": 1.1,
    "x": 0,
    "y": 0,
    "rotation": 0,
    "opacity": 1
  },
  "keyframes": []
}
```

---

## 12. Repository Structure

```txt
framepilot/
  apps/
    desktop/
      src/
      package.json
      tauri.conf.json
    web-editor/
      src/
      package.json

  engine/
    python/
      framepilot_engine/
        render/
        timeline/
        effects/
        audio/
        tracking/
        masking/
        validation/
        ai_tools/
      tests/

  packages/
    timeline-schema/
    ui/
    editor-core/
    ai-sdk/
    shared-types/

  agents/
    skills/
      timeline-editing/
        SKILL.md
      render-debugging/
        SKILL.md
      e2e-testing/
        SKILL.md
      ai-safety/
        SKILL.md
      media-pipeline/
        SKILL.md

  .cursor/
    rules/
      architecture.mdc
      testing.mdc
      ai-engine.mdc
      desktop.mdc
      python-engine.mdc

  .claude/
    settings.json
    agents/
    commands/

  .codex/
    AGENTS.md

  .opencode/
    agent.json

  AGENTS.md
  CLAUDE.md
  README.md
  LICENSE
  package.json
  pnpm-workspace.yaml
  pyproject.toml
```

---

## 13. Agent Instruction Files

## 13.1 Root AGENTS.md

Purpose:

Universal rules for Codex, Cursor, OpenCode, and other agents.

Must include:

```txt
Project mission
Architecture summary
Setup commands
Test commands
Coverage rules
Safety rules
Code style
Forbidden shortcuts
Definition of done
```

---

## 13.2 CLAUDE.md

Purpose:

Claude Code specific memory and working rules.

Must include:

```txt
how to plan
how to edit
how to run tests
how to update learning log
when to ask before dependency changes
how to avoid large unreviewed rewrites
```

---

## 13.3 .cursor/rules

Purpose:

Cursor IDE project rules.

Suggested files:

```txt
architecture.mdc
testing.mdc
python-engine.mdc
frontend-editor.mdc
ai-agent-system.mdc
desktop-shell.mdc
security.mdc
```

---

## 13.4 .codex/AGENTS.md

Purpose:

Codex global/project working agreements.

Rules:

```txt
Run affected tests after edits.
Do not bypass failing tests.
Do not change timeline schema without migration.
Do not add dependencies without license check.
Prefer small patches.
Always update tests with behavior changes.
```

---

## 13.5 .opencode

Purpose:

OpenCode-specific agent setup.

Use:

```txt
AGENTS.md for shared rules
skills/ for reusable workflows
subagents for specialized tasks
```

---

## 14. Agent Skills

## 14.1 Timeline Editing Skill

Purpose:

Make safe timeline changes.

Rules:

```txt
Always inspect timeline schema first.
Return timeline patch, not raw mutation.
Validate references.
Preserve original assets.
Add tests for new operations.
```

---

## 14.2 Render Debugging Skill

Purpose:

Debug failed MoviePy/FFmpeg renders.

Rules:

```txt
Check project JSON.
Check asset paths.
Check codec availability.
Check duration mismatch.
Check missing audio streams.
Check render logs.
Add regression test.
```

---

## 14.3 E2E Testing Skill

Purpose:

Create Playwright/Cypress style end-to-end tests.

Rules:

```txt
Every critical user flow must have e2e coverage.
Test import, edit, preview, export.
Use fixture videos.
Do not rely on network.
Record screenshots/video on failure.
```

---

## 14.4 AI Tooling Skill

Purpose:

Add new AI tools safely.

Rules:

```txt
Every tool needs schema.
Every tool needs validation.
Every tool must be reversible if it edits timeline.
Every tool must have tests.
No direct file mutation without permission.
```

---

## 14.5 Media Pipeline Skill

Purpose:

Work on video, audio, masks, and render internals.

Rules:

```txt
Use deterministic fixtures.
Use golden output tests.
Use perceptual tolerances for video.
Use exact tests for JSON patches.
Use duration/audio/video stream checks.
```

---

## 15. Commands

## 15.1 Root commands

```bash
pnpm install
pnpm dev
pnpm test
pnpm test:e2e
pnpm test:coverage
pnpm lint
pnpm typecheck
pnpm build
pnpm desktop:dev
pnpm desktop:build
```

---

## 15.2 Python commands

```bash
uv sync
uv run pytest
uv run pytest --cov
uv run ruff check .
uv run mypy .
```

---

## 15.3 Render commands

```bash
uv run framepilot render fixtures/basic/project.fp.json
uv run framepilot validate-render renders/output.mp4
uv run framepilot inspect-media assets/input.mp4
```

---

## 16. Testing Strategy

## 16.1 Coverage goal

There is **no coverage percentage target**. The goal is meaningful coverage of the
core deterministic modules — every behavior branch and every user-reachable error
path, exercised through real workflows:

```txt
timeline operations (apply + invert)
patch validation
AI tool schemas / input validation
render validation
```

UI coverage should include:

```txt
component tests
integration tests
e2e tests
visual regression tests
accessibility tests
```

Coverage should not be vanity coverage. Critical behavior must be tested through real workflows.

---

## 16.2 Test types

### Unit tests

For:

- timeline operations
- patch validator
- schema parser
- keyframe interpolation
- caption alignment
- export settings
- AI tool validation

### Integration tests

For:

- import video
- generate proxy
- create transcript
- apply patch
- render preview
- export final video

### E2E tests

Required flows:

```txt
Create project
Import video
Generate transcript
Add captions
Trim clip
Add text overlay
Use AI edit command
Review timeline diff
Apply patch
Undo patch
Render preview
Export final video
Validate output
```

### Visual regression tests

For:

- timeline UI
- caption overlay
- text behind object preview
- export preview frame
- mask editor
- color panel
- keyframe panel

### Golden media tests

Use fixture videos and expected output metadata.

Validate:

```txt
duration
resolution
fps
audio stream
video stream
expected frame hash tolerance
caption timing
black frame detection
audio clipping
```

---

## 17. CI/CD Quality Gates

Every PR must pass:

```txt
TypeScript typecheck
Python typecheck
lint
unit tests
integration tests
coverage
e2e smoke tests
license scan
build desktop app
render fixture project
```

Blocking rules:

```txt
No failing tests.
No skipped tests without issue link.
No unvalidated timeline operation.
No new dependency without license review.
No render change without golden test update.
```

---

## 18. Security and Reliability Rules

### 18.1 Local file safety

- Never delete original assets.
- Never overwrite user files without confirmation.
- Store renders in project render folder.
- Use safe path resolution.
- Prevent path traversal.

### 18.2 Agent safety

- Agent cannot run arbitrary shell commands inside app runtime.
- Agent can only call registered tools.
- Tool inputs must be schema-validated.
- File operations must be sandboxed to project directory.
- Render jobs must have timeout and cancellation.

### 18.3 Reliability

- Every background job must be resumable or retryable.
- Failed renders must show useful logs.
- Project save must be atomic.
- Timeline history must support undo/redo.
- App should recover from crash using last valid project state.

---

## 19. MVP Scope

## MVP 1: Reliable AI Video Editor Core

Features:

```txt
Desktop app shell
Import video
Project save/load
Timeline UI
Trim/split/delete
Preview player
Transcript generation
Caption generation
Text overlays
AI chat with transcript
AI plan mode
AI edit mode for timeline patches
Timeline diff
Undo/redo
Export with MoviePy
E2E test suite
Coverage gates
```

AI commands:

```txt
Make this into a 45-second product demo.
Remove silence.
Add captions.
Find the best hook.
Make this suitable for Reels.
Add text overlay for key points.
Improve pacing.
```

---

## MVP 2: Professional Motion and Masking

Features:

```txt
keyframes
zoom animation
object tracking
face tracking
manual tracking correction
basic masks
text behind object
tracked text
blur tracked object
```

---

## MVP 3: Color, Sound, and Polish

Features:

```txt
color correction
LUTs
color match
audio cleanup
music ducking
transition suggestions
beat detection
render presets
visual rhythm suggestions
```

---

## MVP 4: Full Agent Mode

Features:

```txt
multi-step autonomous edit
agent plan
agent execution
critic review
auto preview render
self-check
timeline diff
one-click revert
project memory
style presets
```

---

## 20. Definition of Done

A feature is done only when:

```txt
Feature works manually.
Feature works through AI tool call if applicable.
Timeline operation is reversible.
Schema is documented.
Unit tests are added.
Integration tests are added.
E2E test is added for critical flow.
Core deterministic modules are meaningfully covered.
Render output is validated.
Agent rules are updated if needed.
User-facing errors are clear.
```

---

## 21. First 30-Day Build Plan

## Week 1: Foundation

Build:

```txt
monorepo
desktop shell
React editor shell
Python engine package
project file format
asset import
basic video preview
test setup
CI setup
AGENTS.md
CLAUDE.md
Cursor rules
Codex rules
OpenCode rules
```

Deliverable:

```txt
User can create project and import video.
```

---

## Week 2: Timeline and Render

Build:

```txt
timeline schema
tracks/clips
trim/split/delete
undo/redo
MoviePy render pipeline
render validation
fixture videos
unit tests
integration tests
```

Deliverable:

```txt
User can edit a clip and export rendered video.
```

---

## Week 3: Transcript, Captions, AI Chat

Build:

```txt
transcription pipeline
caption track
caption editor
AI context builder
chat with transcript
plan mode
timeline patch format
patch validator
```

Deliverable:

```txt
User can ask AI for an edit plan and add captions.
```

---

## Week 4: AI Edit Mode and E2E

Build:

```txt
AI tool registry
AI edit command
timeline diff UI
apply/reject patch
render preview
Playwright e2e tests
coverage reporting
golden render tests
```

Deliverable:

```txt
User can ask AI to improve pacing, review diff, apply edit, and export.
```

---

## 22. First Agent Commands

Add these commands first:

```txt
/plan-edit
/create-short
/remove-silence
/add-captions
/improve-pacing
/add-hook
/export-reels
/debug-render
/write-tests
/review-timeline-patch
```

---

## 23. Main Engineering Risk

The biggest risk is trying to build Premiere Pro, After Effects, DaVinci Resolve, and Cursor at the same time.

The correct strategy:

```txt
Build the reliable timeline and patch engine first.
Then build AI tools on top.
Then add professional compositing features.
Then improve creative judgment.
```

The AI layer is only powerful if the editing engine is structured, testable, and deterministic.

---

## 24. North Star

The app succeeds when a user can import a raw product recording and say:

```txt
Make this a professional 45-second product demo for Reels and LinkedIn.
```

Then the app:

```txt
creates a plan
shows timeline diff
adds captions
cuts weak parts
adds zooms
adds overlays
mixes audio
renders preview
validates output
lets user approve export
```

That is the Cursor-for-video experience.
