# Phase 1 leads (collected during Phase 0; input to P1.1)

Measured on `mission-montage` run 1 (35 calls, 1.07M prompt tokens, $1.29, 924 s, rubric 1.0):

1. **Tool schemas ride on every call.** `agentTools('agent', stage)` returns all 85 tools in
   every `RunStage` because `stageAllowsRole` only withholds the `analysis` role during
   execution stages. 18,469 tokens × 35 calls ≈ 646k of the 1.07M prompt tokens (60%).
   The autonomous stage mapping already exists and is 12–25× smaller: inspect 6 tools/471
   tokens, understand 19/903, edit 19/1,321, verify 13/739 — it has no live consumer.
2. **Prompt per call is flat ~30–37k** and fully cache-read on the bridge (cache works);
   the cost is the *number* of calls, not cache misses. Calls with fresh frames
   (`get_frame`) are the cache misses (3–4k uncached).
3. **Two calls hit the 8,192 output cap (~90 s each)** with no tool call — the model wrote
   prose. Every such call is retried once (`MAX_UNUSABLE_TURN_RETRIES = 1`) → the smoke run
   spent 2 × 90 s and $0.15 producing nothing.
4. **Tool call volume:** 138 calls for 34 operations. `set_clip_crop` 28, `get_frame` 18,
   `recall_evidence` 18, `get_clips` 12, `describe_footage` 10, `trim_clip` 10. The
   repeat metric (80) is inflated for tools whose `argsSummary` is a constant label; the
   fixed key (tool + actual input) lands with the dumped runs.
5. **Manifest under-reports:** sections listed are system/skill/tool_schemas/
   retrieved_evidence/latest_user_message only (≈22k); the other ~8–15k per request sit in
   messages (history, tool results) and are not attributed. P1.3 needs the manifest to
   account for those before/after.
6. **`usage` USD** is priced by tier tables, not provider-reported; report tokens as the
   primary metric.
7. **Root cause of the failed montage runs (2 of 3) and the failed smoke run:** the agent
   loop sends `AiCompletionRequest` without `maxTokens` (no caller sets it on the agent
   path; only `caption-emphasis` 512 and `vision-judge` 300 do). The openai-compatible
   bridge fills `max_tokens || 8192`; `reservedOutputFor()` meanwhile reserves 128k of
   window for output that is never requested. A long tool-call batch (`add_clips` /
   `set_clip_crop` over many clips) is cut at 8,192 output tokens → no parseable tool
   call → classified `truncated`/`empty` → one retry (same cap) → run `failed` after
   ~3 minutes and $0.15–0.30 of output. Fix: request `maxTokens = min(reservedOutputTokens,
   capabilities.maxOutputTokens)` on every agent request; treat provider `length` as a
   distinct failure with a "split the step" continuation instead of a blind retry.
   Evidence: `baseline-orchestration.json` montage r2/r3 calls 9–10 end in
   `→8192 ~90 s` pairs; smoke.json likewise.
