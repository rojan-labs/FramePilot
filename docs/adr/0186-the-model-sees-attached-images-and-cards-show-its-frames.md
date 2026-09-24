# ADR 0186 — The model sees attached images; a look's card shows the frame it saw

- **Status:** Accepted. The maintainer asked on 2026-09-24 that an image passed in the AI sidebar
  go to the model "as a image as a attachment how it goes on get frame", and that expanding a
  "Looking at the frame" card show "the actual frame that gone into the ai context not the json".
- **Date:** 2026-09-24
- **Relates to:** plan/system-mission P3.1–P3.5 (references), ADR 0069 (vision capability gate),
  EQ2 (the Claude Agent SDK provider carries images), plan `EQ18` in
  [`plan/PLAN.md`](../../plan/PLAN.md).

## Context

An attached image reached the model only as its measured profile: size, alpha, a four-colour
palette and tone words. That is enough for "grade toward this look" and useless for "put my logo
in the corner" (what does it say?), "keep this person in frame" (who?) or "titles like this
design". The model was told to apply references it could not see.

The `get_frame` card's expander showed the tool's result, which is the facts about a frame (its
time and size), not the frame. The picture the model judged was visible nowhere.

## Decision

**Attached images travel as pixels.** `ContextInput.referenceImages` carries one picture per image
reference still in force, attached as real image parts through the same `AiMessage.images`
channel `get_frame` uses and labelled `reference <id> · <file> (<role>)`. The pictures are priced
into the references block's budget and dropped with it, so a picture never arrives without the
text that says what it is for. `Orchestrator#budgeted` withholds them from a model that cannot read
images. Every route assembles through it, so no route can bill a text-only model for a picture.
In agent mode they sit in their own message **below** the cache boundary: the Claude Agent SDK
provider (the desktop default) renders everything at or above the boundary into its system prompt,
which is text-only, so a picture above it would be silently dropped. It is a separate message
rather than part of the turn message, so a prefix-caching provider can still reuse the bytes.
Reference **videos** are unchanged: a few stills say little about pacing.

**The engine makes the still** (`POST /references/still`): a 1024 px longest edge, EXIF
orientation applied, PNG only when a pixel is actually transparent (an RGBA screenshot is JPEG).
The desktop host loads it from the imported copy. The renderer sends `referenceFiles` (id → path)
beside the profiles. Main honours only ids the request still lists, resolves the path inside the
projects root, and loads nothing for a blind model. A failed load costs that picture, never the run.

**Tool pictures are stored by path.** `ToolResultEvent.images` carries what the model was shown.
The desktop host writes the bytes to `media/<project>/attachments/frame-<sha256>.<ext>`
(content-addressed, written as a `.part` then renamed, registered live for the session) and the
event carries the path. The transport drops any bytes that got past this. The conversation store
counts `images[].path` as a reference, so the existing attachment sweep keeps a frame exactly as
long as a card shows it. The browser build keeps the bytes inline; it has no such store.

## Consequences

- A sighted run pays for each attached image on every request, about 800 tokens for a 732 × 828
  still, priced into the context budget. Pictures ride every agent turn by design: the model is
  asked to apply the reference throughout the run.
- Live check (2026-09-24, Claude Agent SDK, a real sidebar attachment): the model quoted the
  on-screen text ("M / THAT MAKE / FOUNDERS / STOP") and described the person. With the profile
  alone it could have known neither.
- Frames accumulate in the attachments folder while their conversation exists and are reclaimed
  with it. Identical looks share one file.
