# Runbook: masking observability

What the masking program (background removal, masks, tracking, AI Object hover) tells a
maintainer about itself in the field, which dashboard panel each signal feeds, and what the
maintainer has to set up. Plan: `plan/background-removal-ai/12-PARITY-AND-PRODUCTION-AUDIT.md`
§B P19 and RD2.2. Budgets the panels are read against: `06-PRECISION-AND-EVAL.md` and
`PX5-BUDGETS.md`.

## The rule: counts, codes and durations, never content

Every event below is a scoped-logger event (`createLogger(scope)`, `log.action`/`warn`/`debug`)
the app already emits. Its payload goes through one allow-list,
`maskingEventPayload(name, payload)` in `packages/shared-types/src/masking-telemetry.ts`, which
copies only the catalogued fields and only values of the declared kind: a count, milliseconds, a
ratio in [0, 1], a size, a boolean, a closed-vocabulary code (no `/`, at most 48 characters), a
semantic version, an ISO timestamp, or milliseconds per named phase. Anything else an emit site
passes is dropped, not coerced.

So no catalogued event carries **media, frames, prompts (their content), paths, names, free-text
error messages, or project, asset, clip, mask, request or artifact ids**. That is checked in code
by `packages/shared-types/src/masking-telemetry.test.ts`:

1. every catalogued field name is scanned against a pattern for ids, paths, names, text, media,
   pictures, hashes, keys and credentials, and every kind must be a scalar kind;
2. the allow-list is fed ids, a path, prompt points and a frame buffer and must drop them;
3. the source of `apps/desktop/electron`, `apps/web-editor/src`, `packages/capability-packs/src`,
   `packages/ai-sdk/src` and `packages/editor-core/src` is scanned for every catalogued event
   name: each emission must exist, come from the catalogued scope at the catalogued level, and
   build its payload with the allow-list.

Adding a field means adding it to the catalogue first, and the test decides whether its name is
acceptable. Two emissions lost fields when the allow-list went in (RD2.2): `workerComplete` no
longer logs the request id, and `trackCommitted` no longer logs the clip and mask ids (it gained
the flagged-range count and the worst residual instead).

## Where the events go

FramePilot uploads nothing. Events go to the process console: the Electron main process's
stdout/stderr for the desktop scopes, the renderer's console for `web-editor:*`. A line reads

```text
2026-09-18T12:00:00.000Z ACT [desktop:capability-packs:matte] matteJobEnd {"status":"completed",…}
```

(`ACT` = `action`, `WRN` = `warn`, `DBG` = `debug`; `FRAMEPILOT_LOG_LEVEL` filters below a level,
default `debug`). The only thing that leaves a machine on the product's own terms is the opt-in
**diagnostic bundle** (`pack-diagnostics.ts`, written through the
`capabilityPackExportDiagnostics` IPC to a file the editor picks in an "Export diagnostic bundle"
save dialog), which holds the last 50 `matteJobEnd` reports under the same rules. No renderer
control calls that IPC yet, so today a bundle can only be requested from the desktop main process;
a Settings button is part of the beta work (RD2.4), not of this runbook. A dashboard therefore reads
either bundles that beta testers send, or console lines captured on machines whose owners agreed
to it (the closed beta, RD2.4). Choosing and running that capture is the maintainer step below.

## The event catalogue

Queries are written against a table `masking_events(ts, scope, level, event, payload)` with
`payload` the JSON object, one row per log line whose event name is in the catalogue. Translate
them to the telemetry account's own query language.

### Background removal (Smart Mask matte jobs)

| Event                       | Scope · level                           | Fields                                                                                                                                                                                                                                                                                                                                                                                | Feeds                                                                                    |
| --------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `matteJobStart`             | `desktop:capability-packs:matte` action | `prompts` (count of prompt points), `rerun` (bool)                                                                                                                                                                                                                                                                                                                                    | **Jobs started** per day; re-run share                                                   |
| `matteJobEnd`               | same, action                            | `at`, `status` (`completed`, `failed`, `needs_prompt`, `pack_missing`, …), `code` (the `MatteFailureCode`), `verificationCode`, `cacheHit`, `executionProvider` (`coreml`, `directml`, `cpu`), `packVersion`, `verifiedFrames`, `flaggedFrames`, `flaggedRatio`, `phasesMs` (host `media`, `autoPrompt`, `cache`, `stage`, `worker`, `verify`, `commit`; `worker.<phase>`), `totalMs` | **Job failures by code and EP**, **flagged ratio**, **phase time**, **cache hit rate**   |
| `matteMonitorTier`          | same, action                            | `status`, `width`, `height`, `alpha` (bool), `elapsedMs`                                                                                                                                                                                                                                                                                                                              | **Monitor tier**: time to make, share with an alpha plane                                |
| `matteMonitorTierFailed`    | same, warn                              | `code`, `elapsedMs`                                                                                                                                                                                                                                                                                                                                                                   | **Monitor tier failures by code** (the monitor falls back to decoding 4K masters: PX5.3) |
| `matteDiskPreflightRefused` | same, action                            | `requiredBytes`, `freeBytes`                                                                                                                                                                                                                                                                                                                                                          | **Refused for disk**                                                                     |

```sql
-- Job failures by code and execution provider (daily)
SELECT date(ts), payload->>'code' AS code, coalesce(payload->>'executionProvider', 'none') AS ep, count(*)
FROM masking_events WHERE event = 'matteJobEnd' AND payload->>'status' = 'failed'
GROUP BY 1, 2, 3;

-- Flagged ratio ("review load", 06): distribution over completed jobs, by pack version
SELECT payload->>'packVersion', percentile_cont(ARRAY[0.5, 0.9]) WITHIN GROUP (ORDER BY (payload->>'flaggedRatio')::float)
FROM masking_events WHERE event = 'matteJobEnd' AND payload->>'status' = 'completed'
GROUP BY 1;

-- Where the time goes: p50/p95 per phase
SELECT phase, percentile_cont(ARRAY[0.5, 0.95]) WITHIN GROUP (ORDER BY ms::float)
FROM masking_events, jsonb_each_text(payload->'phasesMs') AS p(phase, ms)
WHERE event = 'matteJobEnd' GROUP BY phase;
```

**Gap: a failed job has no execution provider.** `executionProvider` comes from the finished
artifact, so it is set on completed jobs only, and the failures query above reports `ep = none`
for every failure. Failure-by-EP needs the worker's failure message to carry the provider it was
running on (a Smart Mask protocol field); until then, read failure codes by `packVersion` and the
machine class the capture records, and the completed jobs' EP mix beside them.

`matteJobEnd` fails with `status = 'failed'` only; `needs_prompt` and `pack_missing` are not
failures (the editor is asked for a point, or offered the pack) and belong on a separate
"asked the editor" panel.

### Pack health

| Event                  | Scope · level                                     | Fields                                                                                         | Feeds                                                                       |
| ---------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `workerWatchdogBreach` | `desktop:capability-packs:worker-watchdog` action | `breach` (`memory`, `stalled`, `disk`)                                                         | **Watchdog stops by cause**                                                 |
| `warmWorkerKilled`     | `capability-packs:warm-worker` warn               | `reason` (`timed out`, `cancel not answered`, `stdin failed`, `stdin error`, `protocol error`) | **Warm worker kills by reason** (hover and tracking run in the warm worker) |
| `workerComplete`       | `capability-packs:worker-client` action           | `capability`, `samples`                                                                        | **Worker requests by capability**; the denominator for the two rows above   |
| `jobCompleted`         | `desktop:capability-packs:job-scheduler` action   | `kind` (`matte`, `tracking`, `segment_frame`), `elapsedMs`                                     | **Queued job time by kind** (queue wait + run)                              |
| `jobEnded`             | same, action                                      | `kind`, `state` (`failed`, `cancelled`)                                                        | **Queued job failure and cancel rate by kind**                              |

```sql
-- Pack health: watchdog stops and warm-worker kills per 100 worker requests
SELECT date(ts),
  100.0 * count(*) FILTER (WHERE event IN ('workerWatchdogBreach', 'warmWorkerKilled'))
        / nullif(count(*) FILTER (WHERE event = 'workerComplete'), 0) AS stops_per_100
FROM masking_events GROUP BY 1;
```

Installed pack versions and their health state are not a log event: they are in the diagnostic
bundle's `packs` section (state, health, installed bytes). A "pack versions in the field" panel
reads bundles.

### Tracking and AI Object hover latency

| Event                | Scope · level                                  | Fields                                                                        | Feeds                                                                               |
| -------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `trackingComplete`   | `desktop:capability-packs:tracking` action     | `capability`, `pack` (version), `samples`, `detections`, `masks`, `elapsedMs` | **Tracking latency** by capability (and ms per sample)                              |
| `trackCommitted`     | `desktop:capability-packs:track-job` action    | `method`, `frames`, `flaggedRanges`, `worstResidualPx`                        | **Track quality**: flagged ranges per 100 frames, residual distribution (MK7 gates) |
| `segmentFrame`       | `desktop:capability-packs:segment-frame` debug | `ok` (bool), `elapsedMs`                                                      | **Hover latency** p50/p95 (budget: ≤ 100 ms p95, 06 "Production budgets")           |
| `segmentFrameFailed` | same, warn                                     | `code`                                                                        | **Hover failures by code**                                                          |

`segmentFrame` is a `debug` event because a hover fires on every settled pointer position (one in
flight at a time). The capture must keep `debug` for this one scope, or sample it; everything
else in this runbook is `action`/`warn`.

```sql
-- Hover latency (budget: <= 100 ms p95, 06 "Production budgets")
SELECT date(ts), percentile_cont(ARRAY[0.5, 0.95]) WITHIN GROUP (ORDER BY (payload->>'elapsedMs')::float)
FROM masking_events WHERE event = 'segmentFrame' AND (payload->>'ok')::bool GROUP BY 1;

-- Tracking: ms per sample by capability
SELECT payload->>'capability', percentile_cont(0.5) WITHIN GROUP (
  ORDER BY (payload->>'elapsedMs')::float / greatest((payload->>'samples')::int, 1))
FROM masking_events WHERE event = 'trackingComplete' GROUP BY 1;
```

### Export time with and without mattes

| Event          | Scope · level              | Fields                                                                                                                                                                                                                                 | Feeds                                                                        |
| -------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `exportJobEnd` | `web-editor:export` action | `status` (`completed`, `failed`, `cancelled`), `elapsedMs` (request to result), `frames`, `resolution` (`720p`…`2160p`), and the timeline's enabled masks: `maskedClips`, `mattes`, `keys`, `shapes`, `trackMattes`, `frameSpaceMasks` | **Export-time ratio** (P13 in the field), **export failure rate by masking** |

```sql
-- Export-time ratio at each resolution: ms per frame with a matte over ms per frame without masks
-- (budget: <= 1.5x, 06 "Production budgets"; CI's measurement is in PX5-BUDGETS.md)
WITH e AS (
  SELECT payload->>'resolution' AS res, (payload->>'elapsedMs')::float / greatest((payload->>'frames')::int, 1) AS ms_per_frame,
         (payload->>'mattes')::int > 0 AS with_matte, (payload->>'maskedClips')::int = 0 AS unmasked
  FROM masking_events WHERE event = 'exportJobEnd' AND payload->>'status' = 'completed')
SELECT res,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY ms_per_frame) FILTER (WHERE with_matte)
  / percentile_cont(0.5) WITHIN GROUP (ORDER BY ms_per_frame) FILTER (WHERE unmasked) AS export_time_ratio
FROM e GROUP BY res;
```

Read this ratio for what it is: different projects on different machines, not the same timeline
with and without its matte. It says whether mattes are expensive in the field, not by how much a
given edit is; the controlled number is `pnpm px5:export-ratio` and the PX5.11 CI workflow.

## Not in the catalogue

- **Engine and worker (Python) logs.** `framepilot_engine.render.*` and the Smart Mask worker log to
  the sidecar's own stream. Some lines name a matte by the first 12 characters of its artifact key
  (`matte tier 3fa2…`) or an asset id; they are local diagnostics, not dashboard input, and must not
  be forwarded as they are.
- **Editing events** in the web editor (`mask edit committed`, `matte committed`,
  `matte job started`, `matte fix applied`) carry clip and mask ids. They are for a developer
  reading a session, not for dashboards, and are not forwarded.
- The mask tool's pointer latency (MK4.6) is measured by `mask-tool-telemetry.ts` in the page and
  read by the perf specs; it is not logged.

## Maintainer steps (RD2.2)

The code side is done; these need the maintainer's telemetry account and are not in the repo:

1. **Pick the capture.** For the closed beta (RD2.4), collect the desktop main process's console
   output on consenting testers' machines (or ask for diagnostic bundles), and keep only lines
   whose event name is in the catalogue above. Do not forward any other line.
2. **Parse** each kept line into `ts`, level tag, `scope`, `event` and the JSON `payload`.
3. **Build the panels** named in the "Feeds" columns from the queries above, one dashboard with
   four rows: background removal, pack health, tracking and hover, export.
4. **Alerts worth having:** failed `matteJobEnd` over 5% of jobs in a day for one
   `executionProvider`; a rise in p95 `flaggedRatio` for one pack version (06 names review load as
   a metric, not a threshold); any `workerWatchdogBreach` with
   `breach = memory` on a machine class; `segmentFrame` p95 over the hover budget.
5. **Record** the dashboard's link and the retention period in
   `plan/background-removal-ai/MAINTAINER_ONLY_ACTIONS.md`.
