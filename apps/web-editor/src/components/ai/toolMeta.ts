/**
 * Tool → icon + label mapping for the AI activity cards (Phase 11 M5, ADR 0033).
 *
 * Covers both the internal TOOL_REGISTRY and the compact autonomous manifest, so
 * a canonical tool never falls back to a raw identifier. Availability comes from
 * the matching contract and planned capabilities remain visibly gated.
 */
import { getAutonomousTool, getTool } from '@framepilot/ai-sdk';
import {
  ArrowLeftRight,
  AudioLines,
  Ban,
  BookOpen,
  Bookmark,
  Captions,
  Check,
  Crop,
  Download,
  Eye,
  FileText,
  Film,
  Flag,
  Folder,
  Frame,
  Gauge,
  Image,
  ImagePlus,
  Layers,
  Lightbulb,
  ListX,
  Map,
  MessageCircleQuestion,
  type LucideIcon,
  Music,
  Palette,
  Plus,
  Scan,
  Scissors,
  Search,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  Type,
  Volume2,
  Wand2,
  ZoomIn,
} from '../icons.js';

export interface ToolMeta {
  readonly label: string;
  readonly Icon: LucideIcon;
}

/** Display metadata keyed by registry or canonical autonomous tool name. */
const TOOL_META: Record<string, ToolMeta> = {
  // Compact autonomous surface
  inspect_project: { label: 'Inspect project', Icon: FileText },
  inspect_timeline: { label: 'Inspect timeline', Icon: Film },
  inspect_transcript: { label: 'Inspect transcript', Icon: Captions },
  probe_media: { label: 'Probe media', Icon: Scan },
  resolve_time: { label: 'Resolve exact time', Icon: Map },
  understand_timestamp: { label: 'Understand timestamp', Icon: Eye },
  plan_edit_candidates: { label: 'Plan edit candidates', Icon: Lightbulb },
  propose_timeline_patch: { label: 'Propose timeline edit', Icon: Scissors },
  propose_project_patch: { label: 'Propose project edit', Icon: Folder },
  verify_result: { label: 'Verify result', Icon: Check },
  discover_styles: { label: 'Discover styles', Icon: Search },
  inspect_session: { label: 'Inspect session memory', Icon: BookOpen },
  cancel_operation: { label: 'Cancel operation', Icon: Ban },
  undo_edit: { label: 'Undo edit', Icon: ArrowLeftRight },
  // Canonical names shared with internal routes
  search_media: { label: 'Search media', Icon: Search },
  analyze_media: { label: 'Analyze media', Icon: AudioLines },
  get_frame: { label: 'See the frame', Icon: Image },
  render_preview: { label: 'Render preview', Icon: Eye },
  ask_user: { label: 'A question for you', Icon: MessageCircleQuestion },
  load_skill: { label: 'Load skill', Icon: BookOpen },
  recall_evidence: { label: 'Recall earlier finding', Icon: BookOpen },
  manage_assets: { label: 'Organize media', Icon: Folder },

  // Internal reads
  get_project_state: { label: 'Read project', Icon: FileText },
  get_timeline: { label: 'Read timeline', Icon: FileText },
  get_timeline_summary: { label: 'Skim timeline', Icon: FileText },
  get_clips: { label: 'List clips', Icon: Film },
  get_clip: { label: 'Read clip', Icon: Film },
  get_transcript: { label: 'Read transcript', Icon: Captions },
  get_selected_range: { label: 'Read selection', Icon: Frame },
  get_timeline_map: { label: 'Read edit timing', Icon: Map },
  map_time: { label: 'Locate on timeline', Icon: Map },
  get_mapped_transcript: { label: 'Read edited transcript', Icon: Captions },
  list_edit_boundaries: { label: 'Find the cuts', Icon: Scissors },
  verify_captions: { label: 'Check caption sync', Icon: Captions },
  verify_transitions: { label: 'Check transitions', Icon: ArrowLeftRight },
  analyze_silence: { label: 'Analyze silence', Icon: AudioLines },
  detect_scenes: { label: 'Detect scenes', Icon: Film },
  detect_beats: { label: 'Detect beats', Icon: Music },
  // Editor-facing labels, not tool names: the card says what the agent is doing,
  // in the words the person watching would use.
  search_music: { label: 'Search for music', Icon: Music },
  add_music: { label: 'Add background music', Icon: Music },
  search_stock: { label: 'Search stock media', Icon: ImagePlus },
  add_stock: { label: 'Add a stock shot', Icon: ImagePlus },
  find_similar: { label: 'Find similar', Icon: Sparkles },
  search_visual: { label: 'Search visual evidence', Icon: Search },
  describe_footage: { label: 'Describe footage', Icon: Film },
  map_footage: { label: 'Map footage', Icon: Map },
  read_edit_signals: { label: 'Read the edit signals', Icon: Lightbulb },
  index_media: { label: 'Index visual media', Icon: Scan },
  session_context: { label: 'Recall project memory', Icon: BookOpen },
  detect_faces: { label: 'Detect faces', Icon: Scan },
  measure_color: { label: 'Measure shot color', Icon: Palette },

  // Resolver-backed professional editor commands
  professional_edit: { label: 'Perform professional edit', Icon: Scissors },
  professional_motion: { label: 'Animate clip properties', Icon: SlidersHorizontal },
  professional_color: { label: 'Correct shot color', Icon: Palette },
  professional_tracking_mask: { label: 'Track mask', Icon: Scan },
  track_subject_automatically: { label: 'Track subject automatically', Icon: Scan },
  detect_subjects: { label: 'Detect subjects', Icon: Scan },
  professional_audio: { label: 'Mix audio', Icon: AudioLines },

  // Timeline edits
  trim_clip: { label: 'Trim clip', Icon: Scissors },
  split_clip: { label: 'Split clip', Icon: Scissors },
  delete_range: { label: 'Delete range', Icon: Trash2 },
  ripple_delete: { label: 'Ripple delete', Icon: ListX },
  delete_clip: { label: 'Delete clip', Icon: Trash2 },
  delete_clips: { label: 'Delete clips', Icon: ListX },
  move_clip: { label: 'Move clip', Icon: ArrowLeftRight },
  add_clip: { label: 'Add clip', Icon: Plus },
  add_clips: { label: 'Add clips', Icon: Plus },
  add_track: { label: 'Add track', Icon: Plus },
  remove_track: { label: 'Remove track', Icon: Trash2 },
  move_track: { label: 'Reorder track', Icon: ArrowLeftRight },
  add_text_layer: { label: 'Add text', Icon: Type },
  add_caption_layer: { label: 'Add captions', Icon: Captions },
  add_keyframes: { label: 'Add keyframes', Icon: SlidersHorizontal },
  punch_in: { label: 'Punch in', Icon: ZoomIn },
  apply_color_grade: { label: 'Color grade', Icon: Palette },
  adjust_audio: { label: 'Adjust audio', Icon: Volume2 },
  add_transition: { label: 'Add transition', Icon: ArrowLeftRight },
  add_mask: { label: 'Add mask', Icon: Square },
  track_object: { label: 'Track object', Icon: Scan },
  set_track_flags: { label: 'Track settings', Icon: SlidersHorizontal },
  generate_mask: { label: 'Generate mask', Icon: Wand2 },
  set_caption_style: { label: 'Style captions', Icon: Captions },
  set_track_caption_style: { label: 'Style caption track', Icon: Captions },
  discover_caption_styles: { label: 'Browse caption styles', Icon: Search },
  auto_emphasize_captions: { label: 'Auto-emphasize captions', Icon: Sparkles },
  set_clip_speed: { label: 'Set clip speed', Icon: Gauge },
  set_clip_crop: { label: 'Crop/reframe clip', Icon: Crop },
  set_clip_blend_mode: { label: 'Set blend mode', Icon: Layers },
  discover_effects: { label: 'Browse effects', Icon: Search },
  discover_transitions: { label: 'Browse transitions', Icon: Search },
  apply_effect: { label: 'Add effect', Icon: Sparkles },
  move_effect: { label: 'Move effect', Icon: ArrowLeftRight },
  resize_effect: { label: 'Retime effect', Icon: Gauge },
  adjust_effect: { label: 'Adjust effect', Icon: SlidersHorizontal },
  set_effect_enabled: { label: 'Toggle effect', Icon: Eye },
  remove_effect: { label: 'Remove effect', Icon: Trash2 },
  add_marker: { label: 'Add marker', Icon: Flag },
  remove_marker: { label: 'Remove marker', Icon: Flag },
  remember_preference: { label: 'Remember preference', Icon: Bookmark },

  // Asset bin and actions
  list_assets: { label: 'List assets', Icon: Folder },
  add_asset: { label: 'Add asset', Icon: ImagePlus },
  transcribe: { label: 'Transcribe', Icon: Captions },
  export_video: { label: 'Export video', Icon: Download },
};

/** Friendly fallback label for an unmapped/custom tool. */
const humanize = (name: string): string =>
  name.replace(/_/g, ' ').replace(/^./, (character) => character.toUpperCase());

/** Display metadata for a tool name (falls back gracefully for extensions). */
export function toolMeta(name: string): ToolMeta {
  return TOOL_META[name] ?? { label: humanize(name), Icon: Wand2 };
}

/** Whether a registry or canonical tool has a complete implementation. */
export function isToolAvailable(name: string): boolean {
  const autonomous = getAutonomousTool(name);
  if (autonomous) return autonomous.status === 'ready';
  return getTool(name)?.available ?? true;
}

export { TOOL_META };
