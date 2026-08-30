# ADR 0165 — An attachment belongs to the message that sent it

- **Status:** Accepted
- **Date:** 2026-08-30
- **Schema:** unchanged (`UserMessageEvent` gains an optional field; conversations are a
  UI store, not the project, and their persistence is a permissive JSON pass-through)
- **Relates to:** ADR 0033 (the streaming event log), plan/system-mission P3.1–P3.6
  (reference analysis), PROMPT.md §6

## Context

An attachment existed in exactly one place: `ConversationUiState.attachments`, the
composer's React state. A sent message carried nothing but `text`. Every symptom of the
reported defect follows from that single missing field, and none of them is fixable
where it shows:

- **It stayed in the composer after sending.** Nothing cleared it, because nothing else
  owned it — clearing would have destroyed the only record that it existed.
- **It could not appear in the bubble.** Neither `UserMessageEvent` nor the `UserNode`
  the chat renders had anywhere to put it. Attaching a reference and asking "make it feel
  like this" scrolled away into a conversation that no longer remembered the "this".
- **It was silently re-sent.** The run's `references` were read from live composer state,
  so a file attached to turn 1 arrived again on turns 2 through 7.

The obvious fix — move the attachments onto the message — is half of the answer, and on
its own it is a worse bug than the one it fixes. Two different questions were being served
by that one array:

1. _What did the user attach to THIS message?_ Provenance. Immutable, owned by the
   message, rendered in its bubble, replayed by Retry.
2. _Which references is the run working under RIGHT NOW?_ Policy. Conversation-scoped, and
   the SDK is explicit about it: `ContextInput.references` is the **complete live set**
   every turn, and an id missing from it means the editor removed that tile, so the
   decision it was binding must stop applying (`kernel/conductor.ts`, P3.5).

Answering (2) with (1) sends `[]` on the turn after an attachment was sent, which the run
reads as a deliberate removal and uses to retire every reference the editor attached.

## Decision

**Split the two questions, and derive the second rather than storing it.**

- `MessageAttachment` is what a message owns: id, kind, name, role, path, profile.
  Immutable. Deliberately WITHOUT the composer's `status`/`error`, which describe work
  that is over the moment the message is sent — a message that kept them would re-render
  whenever a spinner elsewhere moved.
- The composer's `Attachment` keeps the work-in-progress half.
- `activeReferences(events, dismissed)` derives the live set: every reference any message
  in the conversation attached, minus what has since been dismissed, de-duplicated by
  **content hash**. Not by profile id — that is the attachment id, minted fresh on every
  attach, so the same bytes attached twice produced two ids and the de-duplication never
  fired.
- Dismissal moved onto the bubble's own tile. That is not a contradiction of the tile
  being read-only: the record stands either way — the bubble goes on saying the file was
  attached — and what changes is whether the run is still working under it. The composer
  no longer holds the reference, so the bubble is the only place the control can live.

**The per-turn limit is enforced where the intent is expressed, never by truncation.**
Slicing the live set to fit would be indistinguishable, to the run, from the editor
deleting a tile. So it is refused at attach time — where the editor still has the composer
to remove something from — and a conversation that arrives over the line has its oldest
references turned into a real `dismissedReferenceIds` entry. Nothing leaves the live set
without a record behind it.

**On disk, an attachment is reclaimed by reachability, never by deletion on removal.**
A file is reachable while any message in any conversation of the project names it, or any
composer holds it, or this session imported it — so removing one chip cannot delete a file
another bubble still renders a thumbnail from. Attachments are imported into
`media/<project>/attachments/`, selected by a closed single-literal `destination` on the
existing import channel, because while attachments and bin footage shared one directory
under the user's own filenames nothing could tell them apart, and a sweep that cannot tell
them apart cannot safely run at all.

## Consequences

- The chat bubble is now the durable record of what a turn was sent with, which makes
  Retry's correctness depend on it: Retry replays the message's attachments, not the
  composer's, because the composer is empty by then.
- A send that fails before the run reaches a terminal status restores the request and its
  references to the composer. Without that, clearing-before-running would lose analyzed
  references outright, since Retry is only offered for a run that actually started.
- Markdown export names each attachment and says when one was never analyzed, rather than
  claiming the model received a file it never got.
- Attachments imported before the `attachments/` split are permanently unreclaimable:
  they sit in the media root, indistinguishable from footage. Unreclaimable is a better
  bug than unrecoverable, and a migration would need per-file provenance that does not
  exist.
- Reachability matches by basename, deliberately the generous direction. Being too
  generous costs disk; being too strict costs a live reference its bytes.
