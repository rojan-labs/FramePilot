# ADR 0164 — Two processes agree on bytes, not on a revision

- **Status:** Accepted
- **Date:** 2026-08-30
- **Supersedes / relates to:** ADR 0030 (project watcher + canonical serialization)

## Context

Two writers in two OS processes end at the same `writeProjectFile`:

- the Electron main process — autosave, save-as, and AI patch commits, via
  `projectCommands.write` / `projectCommands.commitPatch`;
- the MCP server (`packages/mcp-server/src/session.ts`), which an external agent drives
  while the desktop app has the same project open.

Atomic writes were added earlier. They stop interleaved **bytes**; they do not stop a
**lost update**. `rename` publishes a whole document, so both processes can read the same
project, each apply a different edit, and whichever renames last silently erases the
other's work. Nothing reports it. The user just finds an edit missing.

The protection each writer had was strictly weaker than it looked:

- The **desktop had no on-disk guard at all.** `ProjectCommandService.write` compares
  `expectedRevision` against an in-memory map that only learns of an external write ~120 ms
  later, when the project watcher re-reads the file and calls `observe()`.
- The **MCP session** re-read the target and compared it to a baseline _before_ calling the
  writer — a TOCTOU check. The desktop could publish its own save between that check and
  our rename, and we would overwrite it anyway.

## Decision

Compare-and-swap on file **content**, implemented inside `writeProjectFile` as a
per-process registry of observed content, so no call site has to opt in.

> A write publishes only over content this process has proven it has seen: the bytes the
> last successful `readProjectFile` parsed, or the bytes it last published itself.

- **Unknown path** → fail open (save-as, first save, fixtures — behaviour unchanged).
- **File absent** (a genuine `ENOENT`) → allowed; there is nothing to lose.
- **Unreadable target** (`EACCES`, `EISDIR`, …) → refused. "I could not look" is not
  "there is nothing there".
- **Content differs** → typed `ProjectFileConflictError`, with the recovery step in the
  message.

Four details are load-bearing:

1. The observation is recorded **only on a successful parse**. A read that lands mid-rename
   returns a half-written file, and half a document is not evidence of what is on disk.
2. The compare-and-swap runs **as late as possible** — after the temp file is serialized
   and fsynced, immediately before the rename — so the unguarded window is one read plus
   one rename, not the tens of milliseconds a multi-megabyte serialize takes.
3. The error is discriminated by a `code` property with an `isProjectFileConflictError`
   guard, never `instanceof`: consumers resolve this module through its built `dist`, and a
   duplicated module identity would make `instanceof` quietly false. A lost-update guard
   that quietly stops guarding is worse than none.
4. It is **self-healing**. The desktop watcher re-reads the file on every debounced fs
   event, so an external write refreshes the baseline within ~120 ms and the refused writer
   can retry — the guard is not a deadlock.

### Why content, not a revision number

There is no shared revision on disk. `ProjectCommandService`'s revision is process-local,
and the MCP process has never heard of it. The only fact both processes can agree on is the
bytes of the file. `sha256` is the fingerprint vocabulary the revision service already uses.

### Why not a lockfile

Rejected. The unit that has to be atomic is the whole read-modify-write, and both writers
hold a project open for minutes to hours. A lock could only cover the publish critical
section — exactly what the CAS already covers — while adding a failure mode that is worse
than the race it removes: a stale lock (crashed app, reused pid, or a projects root on a
network/synced volume where pid liveness means nothing) blocks the user from saving their
work at all. "Cannot save" beats "microsecond window" only if you never have to live with
it.

## Consequences

- Every save now costs one extra read + hash of the target. Project files are small
  relative to media; the alternative is losing user work.
- `session.ts` deletes its TOCTOU `assertNoExternalChange` and baseline plumbing entirely,
  and maps the typed conflict onto the existing `SessionError('conflict', …)` with retry
  instructions **in the message** (`dispatch.ts` renders only `[code] message`).
- `ProjectCommandService.commitPatch` maps a refused publish to the existing
  `revision_conflict` — **not** `invalid_patch`; the patch was valid, the target moved —
  and omits `currentRevision`, because the in-memory revision did not advance and returning
  it would invite a retry at the same number. `main.ts` already turns `revision_conflict`
  into a `stale` patch event telling the agent to replan.

## Residual gaps (deliberately not closed here)

- **In-process concurrency is unchanged.** The registry cannot tell two writers in one
  process apart. Ordering read-modify-write inside a process remains the caller's job.
- **One read plus one rename** remain unguarded. An explicit per-writer token exchanged
  through the file itself would close it; that is a schema change and needs maintainer
  sign-off.
- **`main.ts` does not map the typed conflict on the save path.** `projectCommands.write`
  logs and rethrows; the renderer sees a generic save failure rather than a conflict it
  could offer to reload from. `main.ts` was out of scope for this change.
- **The Python writer does not fsync the containing directory** either
  (`engine/python/framepilot_engine/timeline/models.py`). The TS writer now does, best
  effort. The divergence is documented rather than fixed blind from a TS-side patch.
