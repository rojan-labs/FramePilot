# Phase 0 — API key and the live quota surface — `[ ]`

> **Ships:** the user pastes a Pexels API key into Settings and sees their real quota —
> limit, remaining, and when it resets — updating as they use it.
> **Does not ship:** searching. Nothing fetches media in this phase.
> **Why first:** everything after it spends quota, and a metered key whose meter is invisible
> is a support burden rather than a feature.

This phase is deliberately a complete, useful, _stoppable_ unit. Even with nothing else
built, a user can confirm their key works — which is the single most common integration
question — and the quota store becomes the choke point every later request passes through.

---

## P0.1 — Key custody

**Touch:** `apps/desktop/electron/ai/ai-config.ts`,
`packages/shared-types/src/ipc.ts`, `apps/desktop/electron/ipc/contract.ts`.

Per `CONTRACTS.md` §2 — the **write-only, main-owned** design the music slice specified and
never got to use, because Openverse takes no key. This is where it becomes real.

- `StoredConfig` gains `pexelsApiKey?: string`.
- `resolvePexelsApiKey()` mirrors `resolveAsrApiKey()` (`ai-config.ts:310`) exactly: file
  value wins, env fallback `PEXELS_API_KEY`, empty string means absent.
- `AiConfig` gains **`pexelsReady: boolean`** — and nothing else. The key never appears in
  `toAiConfig()`'s return.
- `AiConfigUpdate` gains `pexelsApiKey?: string | null`, `null` meaning clear, matching how
  chat keys and `asrApiKey` are cleared.
- `applyUpdate`'s log payload gets a **presence check** (`'pexelsApiKey' in update`), never
  the value. The reason is written in that file at line 376: CodeQL alert #61, clear-text
  logging. Do not regress it.

**Same change, or it is a bug (CLAUDE.md §2):** add `PEXELS_API_KEY` to the root
`.env.example` (near `TWELVELABS_API_KEY`, ~line 98) **and** to `turbo.json` `globalEnv`.
Unlike the music slice, this obligation is **live, not vacuous** — it is the most likely thing
to be forgotten in this whole plan.

**Tests** — extend `ai-config.test.ts`:

- file value wins over env; env is used when the file has none
- key round-trips through save → reload
- clearing with `null` removes it, and removes it from the persisted file
- **`toAiConfig()` never returns the key**, under any state (this assertion already exists for
  chat keys — extend the same test rather than writing a parallel one)
- `applyUpdate` log payload contains no key material

---

## P0.2 — The quota store

**New:** `apps/desktop/electron/media/stock-quota.ts`.

Implements `StockQuotaSnapshot` / `StockQuotaObservation` per `CONTRACTS.md` §3. No Electron
import — take a file path, stay unit-testable without an Electron runtime, exactly as
`ai-config.ts` does.

```ts
export class StockQuotaStore {
  constructor(filePath: string);
  /** Feed every provider response's headers through here. Ignores stale observations. */
  observe(headers: Headers, at: Date): void;
  /** Record a 429. Preserves the last monthly observation. */
  observeRateLimited(at: Date, retryAfterSeconds?: number): void;
  snapshot(keyConfigured: boolean): StockQuotaSnapshot;
  /** Key cleared → back to `no_key`, and the persisted file is deleted. */
  reset(): void;
}
```

Header parsing is its own exported pure function, because it is where the bugs live:

```ts
export function parseQuotaHeaders(headers: Headers, at: Date): StockQuotaObservation | undefined;
```

- `X-Ratelimit-Limit`, `X-Ratelimit-Remaining`, `X-Ratelimit-Reset`, case-insensitively.
- **All three or nothing.** A partial set is `undefined`, not a half-filled observation.
- `X-Ratelimit-Reset` is a UNIX timestamp → ISO-8601, converted **exactly once, here**.
  A value that is not a plausible epoch second (before now, or more than ~70 days out)
  is rejected rather than rendered as 1970.
- Non-numeric, negative, or `remaining > limit` → rejected.

**The rules from `CONTRACTS.md` §3 are the test list**, in particular:

- observations only ever move forward in `observedAt`; a slow response cannot overwrite a
  newer one with staler numbers
- `remaining` is **never** decremented locally — assert that no code path writes it except
  `observe`
- `observeRateLimited` preserves `monthly`
- `reset()` deletes the file
- persistence is atomic (temp + rename), and a corrupt or truncated file loads as
  `unmeasured` rather than throwing

---

## P0.3 — IPC

**Touch:** `apps/desktop/electron/ipc/contract.ts`, `preload.cts`, `main.ts`,
`packages/shared-types/src/ipc.ts`.

Add `framepilot:stock:quota` (read) and `framepilot:stock:quota-changed` (main → renderer
event). Both bridge methods optional (`?:`) so the browser build type-checks.

Main emits `quota-changed` on **every** store mutation, and the renderer never polls. This
matters: a 3-second `setInterval` refresh — the pattern
`MediaIntelligenceSettings` uses at `SettingsDialog.tsx:669` for engine status — would be
wrong here, because there is no remote to poll. The quota only changes when _we_ make a
request, so pushing on change is both cheaper and more accurate.

**Tests:** handler unit tests — snapshot reflects key presence; `quota-changed` fires exactly
once per observation; **an explicit assertion that no wire payload contains the API key.**

---

## P0.4 — Settings section

**Touch:** `apps/web-editor/src/components/SettingsDialog.tsx`.

A new `SettingGroup` titled **"Stock media"**, description "Search Pexels for photos and video
without leaving the editor." Placed after Media intelligence. Reuse the existing patterns
verbatim — `setting-row--stack`, `setting-field-label`, `setting-text-input`,
`setting-hint`, `ai-tone`, `ai-progress-track` (`SettingsDialog.tsx:588-740`). **No new
settings framework, no new component language.**

**The key field is not a bound input.** Because the key is write-only, there is no value to
read back. The affordance is:

- unset → a `type="password"` field, placeholder `563492…`, Save
- set → the text **"Configured"** with a `ai-tone[data-tone="completed"]`, plus **Replace**
  (reveals an empty field) and **Clear**

That is deliberately different from the TwelveLabs field above it, which _is_ value-bound
(`config.twelveLabs ?? ''`, line 711) because that key is renderer-readable by design.
Explain the difference in a code comment so the divergence reads as a decision rather than an
inconsistency.

**The quota block**, rendered per the `CONTRACTS.md` §5 Settings matrix:

```
Monthly API quota
18,431 of 20,000 requests left          [████████████████░░]
Resets 1 Sep 2026, 00:00 · in 8 days
As of 2 minutes ago
```

Non-negotiable details, each of which is a test:

- The word **"Monthly"** is in the label. `PEXELS-API.md` §3: the headers describe the
  monthly quota only, and the ~200/hour cap is invisible. A bar labelled just "quota" is a
  lie waiting for a 429.
- **"As of"** is always shown. These are last-observed values; another client using the same
  key moves them without us hearing about it.
- The reset time is rendered **absolute and relative** — absolute so it is unambiguous across
  timezones, relative so it is readable at a glance.
- The `unmeasured` state says **"Not measured yet — search once to see your quota."** It does
  not render a zero, a full bar, or a guessed 20,000.
- `hourly_limited` renders the monthly block **plus** its own line. It never rewrites the
  monthly numbers, which may legitimately look healthy.
- `role="progressbar"` with `aria-valuenow`/`aria-valuemin`/`aria-valuemax` and an accessible
  label, following `SettingsDialog.tsx:563`.
- Numbers are locale-formatted (`toLocaleString`), because `18431` in a quota readout is
  harder to read than `18,431` and this is a number people scan.

**Tests** — `SettingsDialog.test.tsx`, one per row of the Settings matrix: field renders,
saves, clears; "Configured" state; each of the four quota `kind`s; the low-quota tone; the
hourly-limited line coexisting with a healthy monthly bar; progressbar ARIA.

---

## P0.5 — Docs

- `docs/guides/configuration.md` and `docs/guides/settings.md`: the new key, where to get it
  (free, instant, self-serve), and what the quota numbers mean — **including that the hourly
  cap is not shown because the provider does not report it.**
- `apps/website/src/app/legal/privacy/page.tsx`: it promises "your media stays on your
  machine." Still true — outbound is a text query only — but say so for stock as the music
  slice did, rather than leaving a reader to infer it.
- `CHANGELOG.md`.

---

## Definition of done

- [ ] Key saves, clears, round-trips; **never** crosses the preload bridge (tested)
- [ ] `PEXELS_API_KEY` is in **both** `.env.example` and `turbo.json` `globalEnv`
- [ ] Quota store parses real headers, rejects partial/implausible ones, persists atomically,
      survives a corrupt file, and never decrements locally
- [ ] All four snapshot `kind`s render correctly in Settings, each tested
- [ ] The monthly/hourly distinction is visible in the UI and asserted by test
- [ ] `pnpm typecheck` / lint / unit green across desktop, shared-types, web-editor
- [ ] Guide + privacy line + `CHANGELOG.md` landed

**Deliberately not built:** a "test this key" button (the first search is the test, and a
dedicated button spends a request to tell the user something the next thing they do would
tell them anyway); usage history or charts over time; per-project quota accounting.
