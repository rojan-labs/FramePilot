/**
 * @framepilot/ai-sdk/tool-classification — the one place a tool's memory behaviour is
 * declared (ADR 0075 follow-up).
 *
 * ## Why this module exists
 *
 * Two questions decide whether the agent remembers what a tool told it:
 *
 * 1. **What did this call teach the run?** — {@link ToolRole}. `kernel/briefing.ts#distil`
 *    records a fact ONLY for `inspection`/`analysis`/`guidance` roles, so a tool typed
 *    `other` never reaches the briefing's "ESTABLISHED — do not gather again" section.
 *    `kernel/stage-policy.ts` also drives stage advance and the execution-stage tool
 *    withholding off this, so a misclassified tool stays callable after the plan locks.
 * 2. **Does an applied patch invalidate it?** — {@link ToolEvidenceScope}. A cut changes
 *    the ARRANGEMENT. It cannot change the beats in a music track, the words that were
 *    spoken, or which assets are in the bin.
 *
 * Both used to be hand-maintained opt-in `Set`s living next to their consumers, and both
 * had drifted from the 62-tool registry. Everything unlisted fell to the conservative
 * default — `other` / `timeline_dependent` — which reads as safe and is not: it silently
 * switches the run's memory OFF for that tool. `detect_beats` was unlisted in both. So a
 * beat-synced edit recorded no fact about the beat map AND evicted the payload on the
 * first applied cut, leaving the model no memory and no cache — and it re-ran
 * `detect_beats` after every cut. Same shape for `index_media`, `describe_footage` and
 * `list_assets`.
 *
 * ## The rule that keeps it fixed
 *
 * Classification is EXPLICIT for every registered tool, and `tool-classification.test.ts`
 * asserts the table and `TOOL_REGISTRY` name-for-name in both directions. A new tool
 * therefore fails CI until somebody decides what it means for the run's memory. The
 * kind-derived fallback below exists only for names the registry does not know (an MCP
 * client's tool, a test double) — it is a floor, never the answer for a real tool.
 */
import { createLogger } from '@framepilot/shared-types';
import type { ToolKind } from './tool-registry.js';

const log = createLogger('ai-sdk:tool-classification');

/** What a tool call tells us about where the run is in the task. */
export type ToolRole =
  /** Reads the ARRANGEMENT — timeline, clips, tracks, assets. */
  | 'inspection'
  /** Reads the CONTENT — transcript, footage, beats, silence, scenes. */
  | 'analysis'
  /** Loads craft guidance — playbooks and remembered preferences. */
  | 'guidance'
  /** Re-opens something already gathered. Never advances anything. */
  | 'recall'
  /** Changes the project. */
  | 'mutation'
  /** Anything else — asking the user, rendering, exporting. Stage-neutral. */
  | 'other';

/**
 * When a stored result stops being true.
 *
 * Wider than the binary `FactScope` that `kernel/working-state.ts` persists, because the
 * store can invalidate on the operation types that actually landed while a *fact* (a
 * one-line conclusion) only knows about the revision. `asset_dependent` and
 * `transcript_dependent` both narrow to `revision_independent` when projected onto a
 * fact — see {@link factScopeOf} — so this stays additive and needs no schema migration.
 */
export type ToolEvidenceScope =
  /** Describes the source material. No timeline edit can change it. */
  | 'revision_independent'
  /** Describes the arrangement. Any applied patch invalidates it. */
  | 'timeline_dependent'
  /** Describes the media bin. Survives cuts; invalidated by an asset operation. */
  | 'asset_dependent'
  /** Derived from the transcript. Survives cuts; invalidated by `set_transcript`. */
  | 'transcript_dependent';

export interface ToolClassification {
  readonly role: ToolRole;
  readonly scope: ToolEvidenceScope;
}

/**
 * Every registered tool, explicitly classified.
 *
 * Grouped by the registry's own constructor helpers so this table can be diffed against
 * `tool-registry.ts` by eye. Where a tool's classification is not what its `kind` would
 * suggest, the reason is stated — those are the cases a derived-only scheme gets wrong.
 */
export const TOOL_CLASSIFICATION: Readonly<Record<string, ToolClassification>> = Object.freeze({
  professional_edit: { role: 'mutation', scope: 'timeline_dependent' },
  professional_motion: { role: 'mutation', scope: 'timeline_dependent' },
  professional_color: { role: 'mutation', scope: 'timeline_dependent' },
  professional_tracking_mask: { role: 'mutation', scope: 'timeline_dependent' },
  // Host-backed mutation in the transcribe mould (kind: analysis): the worker
  // measures media, and the orchestrator converts the validated measurement
  // into a track_object patch — so its outcome ages with the arrangement.
  track_subject_automatically: { role: 'analysis', scope: 'timeline_dependent' },
  detect_subjects: { role: 'analysis', scope: 'revision_independent' },
  professional_audio: { role: 'mutation', scope: 'timeline_dependent' },
  measure_color: { role: 'analysis', scope: 'timeline_dependent' },
  // --- analysisTool: sidecar/ffmpeg-backed reads of the SOURCE MEDIA -------------------
  // These analyze assets, not the arrangement, so a cut cannot invalidate them. This is
  // the group whose absence caused the re-analysis loop.
  analyze_silence: { role: 'analysis', scope: 'revision_independent' },
  describe_footage: { role: 'analysis', scope: 'revision_independent' },
  detect_beats: { role: 'analysis', scope: 'revision_independent' },
  detect_scenes: { role: 'analysis', scope: 'revision_independent' },
  find_similar: { role: 'analysis', scope: 'revision_independent' },
  index_media: { role: 'analysis', scope: 'revision_independent' },
  map_footage: { role: 'analysis', scope: 'revision_independent' },
  search_visual: { role: 'analysis', scope: 'revision_independent' },
  transcribe: { role: 'analysis', scope: 'transcript_dependent' },
  // A provider catalogue is not the project, so no edit can stale a result — and
  // caching matters more here than anywhere else in this group: the free tier
  // allows 20 searches a minute, and a re-query the run did not need is one the
  // user cannot spend on a query they did.
  search_music: { role: 'analysis', scope: 'revision_independent' },
  // `add_music` DOWNLOADS and PLACES. Replaying a memoized "already added" past a
  // later undo would report a bed the timeline does not have, so it ages with the
  // arrangement like any other edit-producing call.
  add_music: { role: 'analysis', scope: 'timeline_dependent' },
  search_stock: { role: 'analysis', scope: 'revision_independent' },
  // `add_stock` DOWNLOADS and PLACES, and its refusal depends on what already
  // occupies the timeline — a memoized "already added" replayed past an undo
  // would report a cutaway the project does not have.
  add_stock: { role: 'analysis', scope: 'timeline_dependent' },
  // A rendered frame is a picture of the ARRANGEMENT, not of the source media: it is the
  // one member of this group that any applied patch invalidates. Caching a frame past an
  // edit would show the model the timeline it had before its own change — the precise
  // failure the tool exists to prevent.
  get_frame: { role: 'analysis', scope: 'timeline_dependent' },
  // `search_media` returns TIMELINE seconds and clip placements for asset hits, so unlike
  // its sidecar siblings its result really does age with the arrangement.
  search_media: { role: 'analysis', scope: 'timeline_dependent' },
  // Remembered preferences, not media analysis — guidance, like `load_skill`.
  session_context: { role: 'guidance', scope: 'revision_independent' },

  // --- readTool: in-process reads of the PROJECT --------------------------------------
  get_clip: { role: 'inspection', scope: 'timeline_dependent' },
  get_clips: { role: 'inspection', scope: 'timeline_dependent' },
  get_project_state: { role: 'inspection', scope: 'timeline_dependent' },
  get_selected_range: { role: 'inspection', scope: 'timeline_dependent' },
  get_timeline: { role: 'inspection', scope: 'timeline_dependent' },
  get_timeline_summary: { role: 'inspection', scope: 'timeline_dependent' },
  // Source↔sequence time mapping and edit boundaries are functions OF the arrangement,
  // so they age with it even though they read like static reference data.
  get_timeline_map: { role: 'inspection', scope: 'timeline_dependent' },
  list_edit_boundaries: { role: 'inspection', scope: 'timeline_dependent' },
  map_time: { role: 'inspection', scope: 'timeline_dependent' },
  get_mapped_transcript: { role: 'analysis', scope: 'timeline_dependent' },
  // The words spoken are content, and only `set_transcript` rewrites them.
  get_transcript: { role: 'analysis', scope: 'transcript_dependent' },
  // The bin survives cutting. Adding a clip does not add an asset.
  list_assets: { role: 'inspection', scope: 'asset_dependent' },
  load_skill: { role: 'guidance', scope: 'revision_independent' },
  recall_evidence: { role: 'recall', scope: 'revision_independent' },
  // Candidate edits are proposed against the current arrangement.
  read_edit_signals: { role: 'analysis', scope: 'timeline_dependent' },
  // Verification reads: they establish whether the CURRENT timeline is correct, which is
  // a finding worth recording — but one that dies with the next patch.
  verify_captions: { role: 'inspection', scope: 'timeline_dependent' },
  verify_transitions: { role: 'inspection', scope: 'timeline_dependent' },
  discover_caption_styles: { role: 'guidance', scope: 'revision_independent' },

  // --- mutateTool / projectMutateTool -------------------------------------------------
  add_asset: { role: 'mutation', scope: 'timeline_dependent' },
  add_caption_layer: { role: 'mutation', scope: 'timeline_dependent' },
  add_clip: { role: 'mutation', scope: 'timeline_dependent' },
  add_keyframes: { role: 'mutation', scope: 'timeline_dependent' },
  add_marker: { role: 'mutation', scope: 'timeline_dependent' },
  add_mask: { role: 'mutation', scope: 'timeline_dependent' },
  add_text_layer: { role: 'mutation', scope: 'timeline_dependent' },
  add_track: { role: 'mutation', scope: 'timeline_dependent' },
  add_transition: { role: 'mutation', scope: 'timeline_dependent' },
  adjust_audio: { role: 'mutation', scope: 'timeline_dependent' },
  apply_color_grade: { role: 'mutation', scope: 'timeline_dependent' },
  delete_clip: { role: 'mutation', scope: 'timeline_dependent' },
  delete_clips: { role: 'mutation', scope: 'timeline_dependent' },
  delete_range: { role: 'mutation', scope: 'timeline_dependent' },
  manage_assets: { role: 'mutation', scope: 'timeline_dependent' },
  move_clip: { role: 'mutation', scope: 'timeline_dependent' },
  move_track: { role: 'mutation', scope: 'timeline_dependent' },
  punch_in: { role: 'mutation', scope: 'timeline_dependent' },
  remove_marker: { role: 'mutation', scope: 'timeline_dependent' },
  remove_track: { role: 'mutation', scope: 'timeline_dependent' },
  ripple_delete: { role: 'mutation', scope: 'timeline_dependent' },
  auto_emphasize_captions: { role: 'mutation', scope: 'timeline_dependent' },
  set_caption_style: { role: 'mutation', scope: 'timeline_dependent' },
  set_track_caption_style: { role: 'mutation', scope: 'timeline_dependent' },
  set_clip_blend_mode: { role: 'mutation', scope: 'timeline_dependent' },
  // Effect layers (schema v13, ADR 0088). `discover_effects` reads the shipped
  // catalog, which is static data — so it is revision-independent like
  // `load_skill`, and its result stays cacheable across edits. The six mutators
  // all resolve layer/track ids against the timeline.
  discover_effects: { role: 'guidance', scope: 'revision_independent' },
  // Same reasoning for the transition catalog: static shipped data, so its
  // result stays cacheable across edits.
  discover_transitions: { role: 'guidance', scope: 'revision_independent' },
  apply_effect: { role: 'mutation', scope: 'timeline_dependent' },
  move_effect: { role: 'mutation', scope: 'timeline_dependent' },
  resize_effect: { role: 'mutation', scope: 'timeline_dependent' },
  adjust_effect: { role: 'mutation', scope: 'timeline_dependent' },
  set_effect_enabled: { role: 'mutation', scope: 'timeline_dependent' },
  remove_effect: { role: 'mutation', scope: 'timeline_dependent' },
  set_clip_crop: { role: 'mutation', scope: 'timeline_dependent' },
  set_clip_speed: { role: 'mutation', scope: 'timeline_dependent' },
  set_track_flags: { role: 'mutation', scope: 'timeline_dependent' },
  split_clip: { role: 'mutation', scope: 'timeline_dependent' },
  track_object: { role: 'mutation', scope: 'timeline_dependent' },
  trim_clip: { role: 'mutation', scope: 'timeline_dependent' },

  // --- actionTool / askTool: stage-neutral side effects -------------------------------
  export_video: { role: 'other', scope: 'timeline_dependent' },
  render_preview: { role: 'other', scope: 'timeline_dependent' },
  ask_user: { role: 'other', scope: 'revision_independent' },

  // --- unavailableTool: registered for discoverability, engine not built yet -----------
  // Classified anyway, so turning one on is a one-line registry change and not a silent
  // regression back into the `other`/`timeline_dependent` default.
  generate_mask: { role: 'mutation', scope: 'timeline_dependent' },
});

/**
 * Classification for a name the table does not carry, derived from the registry's own
 * `kind`. A floor for unknown tools (an MCP client's, a test double) — never the answer
 * for a registered one, which is why it warns.
 */
function derivedFallback(
  name: string,
  kind: ToolKind | undefined,
  mutates: boolean,
): ToolClassification {
  if (mutates) return { role: 'mutation', scope: 'timeline_dependent' };
  if (kind === 'analysis') return { role: 'analysis', scope: 'revision_independent' };
  if (kind === 'read') return { role: 'inspection', scope: 'timeline_dependent' };
  log.warn('tool has no declared classification — defaulting to stage-neutral', { name, kind });
  return { role: 'other', scope: 'timeline_dependent' };
}

/** The declared classification for a tool, or a kind-derived floor for an unknown name. */
export function classifyTool(name: string, kind?: ToolKind, mutates = false): ToolClassification {
  return TOOL_CLASSIFICATION[name] ?? derivedFallback(name, kind, mutates);
}

/**
 * Project an evidence scope onto the binary `FactScope` that working state persists.
 *
 * A fact is a one-line conclusion carrying no payload, and it is only ever invalidated by
 * a revision change — which is exactly what `asset_dependent` and `transcript_dependent`
 * are defined to survive. So both narrow to `revision_independent` here. The cost of that
 * projection is a stale-but-cheap conclusion ("the bin holds 12 assets") after an asset
 * is added mid-run; the payload it cites is invalidated correctly by the store either way.
 */
export function factScopeOf(
  scope: ToolEvidenceScope,
): 'revision_independent' | 'timeline_dependent' {
  return scope === 'timeline_dependent' ? 'timeline_dependent' : 'revision_independent';
}
