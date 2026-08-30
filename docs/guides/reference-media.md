# Reference media

Attach a video or an image to a message and FramePilot measures it, then edits to what it
measured. "Make it feel like this" stops being a description you have to write and becomes
a file you can point at.

Desktop only: the measurement runs in the Python engine, which the browser build does not
have. In a browser the tile says so rather than pretending.

## Attaching one

The paperclip beside the composer takes video and image files, and so does dropping them
anywhere on the composer. Each becomes a tile above the message box — its own first frame
(or the image itself), its name, the runtime for a video, and the role FramePilot guessed —
while the engine measures it.

The tiles belong to the conversation, so they are still there when you come back to it:
reopen the chat after a restart and the references you attached, and what was measured
from them, come back with it. Nothing is re-measured.

What happens to the file: it is imported into the project's own media folder (the same
place your footage lives), measured there, and the measurement is cached against the
file's content hash — so attaching the same reference again in a later turn costs nothing.
Analysis is a sidecar job, not a model call: attaching a reference does not spend tokens.

## What FramePilot reads from it

Click a tile to see exactly what it learned. The lines you see are **the same lines the
model reads** — not a summary of them, and not a different wording:

| From a video                                              | From an image                              |
| --------------------------------------------------------- | ------------------------------------------ |
| `Pacing: fast — median shot 1.1s (most shots 0.7–1.9s)`   | `Image: 1024×1024, transparent background` |
| `Pacing: one continuous take over 42s — no cuts to match` | `Palette: #1b1b1f #e5670a #f7f7f8`         |
| `Music: about 128 BPM with a clear beat`                  | `Look: high contrast, warm`                |
| `Frame: portrait 1080×1920`                               |                                            |
| `Look: high contrast, cool, shallow depth`                |                                            |

If a file produced nothing measurable, the tile says that too — a reference that adds no
constraints is better known than assumed.

## Roles — what the reference is _for_

The same video means different things depending on why you attached it. FramePilot guesses
a role from the file and your message; the tile's **Use as** menu corrects it, and
correcting it re-measures under the new role.

`style` · `pacing` · `caption-style` · `color` · `brand-logo` · `thumbnail` · `b-roll` ·
`character` · `design`

The guess is a guess. If you attach a logo and the plan starts matching its colour grade,
set the role to `brand-logo` and ask again.

## When something goes wrong

A reference that cannot be read says why on its own tile — an unsupported codec, a file
the engine could not open — with **Re-analyze** next to the reason. Nothing is hidden in a
toast that disappears before you read it.

**Re-analyze** also exists for a reference that is fine: use it after changing the role, or
if you replaced the file on disk (it bypasses the content-hash cache).

## What the model does with it

Reference constraints enter the model's context as their own block, alongside the project
facts and your request. They are constraints, not commands: the model still decides which
cut serves the edit. A reference tells it what "like this" means in numbers — a median
shot length, a BPM, a palette — instead of leaving it to infer taste from an adjective.

At most 8 references travel with one turn.

## Limits worth knowing

- **Browser builds cannot analyze references at all** (no engine).
- **Roles beyond `style` and `pacing` are read but not yet acted on by a dedicated
  controller** — a `brand-logo` does not automatically become an overlay operation today.
  See `plan/system-mission/03-REFERENCE-MEDIA-CONTEXT.md` P3.4 for what remains.
- A reference binds **until you remove its tile**. A later turn that says nothing about it
  still applies what was measured; taking the tile away stops it, from that turn on.
