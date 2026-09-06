/**
 * @framepilot/ai-sdk/describe — human-readable descriptors for timeline operations
 * (Phase 11 M1, ADR 0033).
 *
 * Turns a typed {@link AnyOperation} into the `action`/`detail`/`refs` a
 * {@link TimelineActionEvent} carries, so the streaming sidebar can render an
 * "Added clip" / "Deleted range" card with clickable clip/track/asset chips. Pure
 * and deterministic. M5 layers richer cards on top of this same derivation.
 */
import type { AnyOperation } from '@framepilot/editor-core';
import type { Reference } from './events.js';
import type { ProjectNames } from './names.js';

/** Friendly labels for the operation types the AI produces. */
const ACTION_LABELS: Record<string, string> = {
  trim_clip: 'Trimmed clip',
  split_clip: 'Split clip',
  delete_range: 'Deleted range',
  move_clip: 'Moved clip',
  ripple_delete: 'Ripple-deleted range',
  add_clip: 'Added clip',
  add_text_overlay: 'Added text overlay',
  add_caption_layer: 'Added captions',
  add_keyframes: 'Added keyframes',
  remove_keyframes: 'Removed keyframes',
  apply_color_grade: 'Applied color grade',
  adjust_audio: 'Adjusted audio',
  add_transition: 'Added transition',
  add_mask: 'Added mask',
  track_object: 'Tracked object',
  add_asset: 'Added asset',
  move_asset: 'Moved asset',
  create_folder: 'Created folder',
  rename_folder: 'Renamed folder',
  move_folder: 'Moved folder',
  set_track_flags: 'Updated track',
  set_effect_params: 'Adjusted effect',
  set_caption_style: 'Styled captions',
  set_clip_speed: 'Changed clip speed',
  set_clip_crop: 'Reframed clip',
  set_clip_blend_mode: 'Changed blend mode',
  set_transcript: 'Updated transcript',
  add_marker: 'Added marker',
  remove_marker: 'Removed marker',
};

/**
 * Summarize which track flags a `set_track_flags` op sets, e.g. "muted, locked", or
 * "role: music". The role is the label `duck_roles` works by, and the success note was the
 * one place the model could have confirmed it took — "Updated track Audio 2" said nothing,
 * and run `cc907070` re-labelled the same track on twenty-two turns.
 */
function trackFlagDetail(record: Record<string, unknown>): string {
  const flags: string[] = [];
  for (const key of ['muted', 'locked', 'hidden'] as const) {
    const value = record[key];
    if (typeof value === 'boolean') flags.push(value ? key : `un${key}`);
  }
  if ('role' in record) {
    const role = record['role'];
    flags.push(typeof role === 'string' ? `role: ${role}` : 'role cleared');
  }
  return flags.join(', ');
}

const round = (n: number): string => (Math.round(n * 1000) / 1000).toString();

/** Imperative verbs for a tool call, used in plan steps + reasoning summaries. */
const TOOL_VERBS: Record<string, string> = {
  get_project_state: 'Reading the project',
  get_timeline: 'Reading the timeline',
  get_transcript: 'Reading the transcript',
  get_selected_range: 'Checking the selection',
  // Named as looking, not rendering: the model is checking its own work, and "rendering"
  // reads to an editor as an export they did not ask for.
  get_frame: 'Looking at the frame at',
  list_assets: 'Browsing the media bin',
  trim_clip: 'Trimming',
  split_clip: 'Splitting',
  delete_range: 'Deleting a range on',
  ripple_delete: 'Ripple-deleting on',
  move_clip: 'Moving',
  add_clip: 'Adding a clip',
  add_text_layer: 'Adding a text layer to',
  add_caption_layer: 'Adding captions',
  add_keyframes: 'Animating',
  punch_in: 'Punching in on',
  apply_color_grade: 'Color-grading',
  adjust_audio: 'Adjusting audio on',
  add_transition: 'Adding a transition to',
  add_mask: 'Masking',
  track_object: 'Tracking an object in',
  add_asset: 'Adding an asset',
  manage_assets: 'Organizing assets',
  set_track_flags: 'Updating',
  set_caption_style: 'Styling captions on',
  set_clip_speed: 'Changing the speed of',
  set_clip_crop: 'Reframing',
  set_clip_blend_mode: 'Setting the blend mode on',
  transcribe: 'Transcribing',
  add_marker: 'Adding a marker',
  remove_marker: 'Removing a marker',
  render_preview: 'Rendering a preview',
  export_video: 'Exporting',
  analyze_silence: 'Finding silences in',
  detect_scenes: 'Detecting scene cuts in',
  detect_beats: 'Finding the beat in',
  // Verbs for the tools whose SUBJECT is an argument rather than a clip (see
  // SUBJECT_ARG_KEYS). Without these the row read as a bare, repeated tool name —
  // four "Load skill" rows in a run that loaded four different playbooks.
  load_skill: 'Reading the',
  search_media: 'Searching media for',
  find_similar: 'Finding footage like',
  search_visual: 'Looking through the footage for',
  // The sourcing pair was added after this table and never entered in it, so it hit the
  // bare-tool-name fallback and reproduced the exact failure the note above describes —
  // four rows reading "Search stock" for four different queries. That cost more than
  // legibility: the same string becomes the EVIDENCE DESCRIPTOR, so a run holding four
  // stock searches saw four handles all labelled "Search stock" and had to spend a call
  // opening each one to find out what it held. Run `f014f3ac` made 30 `recall_evidence`
  // calls out of 71 tool calls.
  search_stock: 'Searching stock footage for',
  search_music: 'Searching music for',
  describe_footage: 'Describing',
  map_footage: 'Mapping',
  index_media: 'Indexing',
  discover_caption_styles: 'Browsing caption styles for',
  discover_effects: 'Browsing effects for',
  discover_transitions: 'Browsing transitions for',
  recall_evidence: 'Recalling what it found about',
  apply_effect: 'Adding an effect to',
  set_track_caption_style: 'Styling the caption track as',
  ask_user: 'Asking you:',
  get_timeline_summary: 'Skimming the timeline',
  get_timeline_map: 'Checking the edit timing',
  map_time: 'Locating on the timeline',
  get_mapped_transcript: 'Reading the edited transcript',
  list_edit_boundaries: 'Finding the cuts',
  verify_captions: 'Checking caption sync',
  verify_transitions: 'Checking transitions',
  session_context: 'Recalling this project',
  auto_emphasize_captions: 'Emphasising key words in the captions',
};

/**
 * Some verbs end in a preposition, an article or a colon so a resolved subject reads
 * naturally ("Finding silences in Intro.mp4", "Asking you: should I keep the intro?").
 * When nothing resolves, that tail would dangle ("Finding silences in"), so it is
 * stripped back to a complete phrase ("Finding silences").
 */
const TRAILING_DANGLE = /(?:\s(?:in|on|of|to|for|at|like|the|as|about)|:)+$/;

/**
 * The argument that names WHAT a call is about, for tools whose subject is not an id.
 *
 * ## WHY this table exists
 *
 * The activity card is the only place a user sees what the agent is doing, and until this
 * existed a call was titled from its tool name alone unless it happened to carry a
 * `clipId`/`trackId`/`assetId`. So a run that loaded four different playbooks showed four
 * identical rows reading "Load skill", a caption restyle read "Style captions" whichever
 * of 45 templates it picked, and three searches in a row were three rows saying "Search
 * media". The information was in the arguments the whole time; it was simply never read.
 *
 * Keys are tried in order and the first present, non-empty STRING wins. A key that names
 * a person-facing thing (a skill, a query, a template, a transition kind) belongs here; an
 * id the user has never seen does not — those go through `names` below instead.
 *
 * An entry here OUTRANKS the generic id resolution: these tools all also carry a
 * clip/track id, and on a caption-heavy timeline "Styling captions on cue_37" is noise
 * where "Styling captions as neon pop" is the thing the user wanted to know. Tools whose
 * clip genuinely is the subject (`add_mask`, `trim_clip`, …) simply have no entry.
 *
 * Nested paths use dots: the caption tools carry the chosen look one level down.
 */
const SUBJECT_ARG_KEYS: Record<string, readonly string[]> = {
  load_skill: ['name'],
  // The moment being inspected is the subject — "Looking at the frame at 12.4s".
  get_frame: ['timeSeconds'],
  // Browsing tools: the filter IS the subject. Blank means "show me everything", which
  // the generic no-subject phrasing already says correctly.
  search_media: ['query'],
  find_similar: ['query'],
  search_visual: ['query'],
  // The query is the whole identity of a catalogue search — there is no clip and no asset
  // to fall back on, and `remoteId` is not something a person has ever seen.
  search_stock: ['query'],
  search_music: ['query'],
  discover_caption_styles: ['query', 'category'],
  discover_effects: ['query', 'category', 'shelf'],
  discover_transitions: ['query', 'category'],
  recall_evidence: ['query'],
  // The catalog entry chosen, not the clip it lands on — "Adding a whip pan" tells the
  // user what they are getting; "Adding a transition" does not.
  add_transition: ['kind'],
  apply_effect: ['effectId'],
  // The text being placed reads better than the track it goes on.
  add_text_layer: ['text'],
  add_asset: ['path'],
  ask_user: ['question'],
  manage_assets: ['strategy'],
  // The look chosen, not which of a hundred cues it lands on.
  set_caption_style: ['captionStyle.template'],
  set_track_caption_style: ['captionStyle.template'],
};

/** Subject text longer than this is truncated — the card is one row, not a paragraph. */
const SUBJECT_MAX_CHARS = 44;

/** Ids the `names` resolver can turn into something a person recognises, in priority order. */
const ID_ARG_KEYS = [
  ['clipId', 'clip'],
  ['fromClipId', 'clip'],
  ['toClipId', 'clip'],
  ['trackId', 'track'],
  ['toTrackId', 'track'],
  ['assetId', 'asset'],
] as const;

/** Trim a free-text subject to one row's worth, ellipsizing rather than hard-cutting. */
function clampSubject(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= SUBJECT_MAX_CHARS
    ? collapsed
    : `${collapsed.slice(0, SUBJECT_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * Turn a snake_case/kebab-case IDENTIFIER into words ("short-form-pacing" → "short form
 * pacing"). Values that already contain whitespace are free text the user or model wrote
 * and are left exactly as typed — un-hyphenating a search query turns "b-roll" into
 * "b roll", which is a different search.
 */
const readableId = (value: string): string =>
  /\s/.test(value.trim()) ? value : value.replace(/[-_]/g, ' ');

/**
 * A noun appended after the subject so the phrase names what KIND of thing it is.
 *
 * "Reading the short form pacing" is a sentence about nothing in particular; "Reading the
 * short form pacing playbook" tells the user a skill was loaded, which is the whole point
 * of putting the skill's name on the row.
 */
const SUBJECT_SUFFIX: Record<string, string> = {
  load_skill: 'playbook',
  apply_effect: 'effect',
  add_transition: 'transition',
};

/**
 * The verb to use when the subject came from a NAMED ARGUMENT rather than from a clip or
 * track id — because the two need different grammar.
 *
 * `set_caption_style` is the clearest case: it reads "Styling captions **as** neon pop"
 * when the call names a template, and "Styling captions **on** Intro.mp4" when it does
 * not. One verb cannot serve both, and picking either alone produces the nonsense a
 * shared table quietly generates ("Styling captions as Intro.mp4").
 *
 * {@link TOOL_VERBS} stays the id-subject (and no-subject) form; this overrides it only
 * for the argument-subject case.
 */
const SUBJECT_ARG_VERBS: Record<string, string> = {
  set_caption_style: 'Styling captions as',
  add_transition: 'Adding a',
  apply_effect: 'Adding',
  add_text_layer: 'Adding the text',
};

/**
 * What a tool call is ABOUT, in words the user recognises — or `undefined` when the call
 * genuinely has no subject (`get_timeline` is about the timeline, and saying so twice
 * reads worse than saying it once).
 *
 * Resolution order:
 *  1. The tool's own {@link SUBJECT_ARG_KEYS} entry, when it has one.
 *  2. A project id the {@link ProjectNames} resolver can turn into a real name.
 */
function toolCallSubject(
  toolName: string,
  args: Record<string, unknown>,
  names?: ProjectNames,
): { readonly text: string; readonly fromArg: boolean } | undefined {
  for (const path of SUBJECT_ARG_KEYS[toolName] ?? []) {
    const value = readPath(args, path);
    if (typeof value === 'string' && value.trim() !== '') {
      return { text: clampSubject(readableId(value)), fromArg: true };
    }
    // A `…Seconds` argument is a timecode, and a timecode IS the subject for a tool that
    // asks about one moment ("Looking at the frame at 12.40s").
    if (typeof value === 'number' && Number.isFinite(value) && path.endsWith('Seconds')) {
      return { text: `${value.toFixed(2)}s`, fromArg: true };
    }
  }
  for (const [key, kind] of ID_ARG_KEYS) {
    const value = args[key];
    if (typeof value !== 'string' || value === '') continue;
    const text =
      kind === 'clip'
        ? (names?.clip(value) ?? value)
        : kind === 'track'
          ? (names?.track(value) ?? value)
          : (names?.asset(value) ?? value);
    return { text, fromArg: false };
  }
  return undefined;
}

/** Read a dotted path out of untrusted tool arguments, without throwing on any shape. */
function readPath(args: Record<string, unknown>, path: string): unknown {
  let current: unknown = args;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * A short imperative summary of a tool call for plan/reasoning cards and the activity
 * log's row titles, e.g. "Trimming Intro.mp4", "Loading skill short form pacing",
 * "Searching media for b-roll of the harbour", "Reading the timeline".
 *
 * Always names the call's SUBJECT when it has one — see {@link toolCallSubject} for what
 * counts and why. A tool with no subject falls back to the bare verb with any dangling
 * preposition stripped, so it still reads as a sentence.
 *
 * @param call - The tool call (name + raw arguments).
 * @param names - Optional id→name resolver, so ids read as "Intro.mp4" not "clip_7f2".
 * @returns A concise, human-readable action phrase.
 */
export function describeToolCall(
  call: { readonly name: string; readonly arguments: unknown },
  names?: ProjectNames,
): string {
  const verb = TOOL_VERBS[call.name] ?? humanize(call.name);
  const args =
    call.arguments !== null && typeof call.arguments === 'object'
      ? (call.arguments as Record<string, unknown>)
      : {};
  const subject = toolCallSubject(call.name, args, names);
  if (subject === undefined) return verb.replace(TRAILING_DANGLE, '');
  const phrase = subject.fromArg ? (SUBJECT_ARG_VERBS[call.name] ?? verb) : verb;
  const suffix = subject.fromArg ? SUBJECT_SUFFIX[call.name] : undefined;
  return suffix ? `${phrase} ${subject.text} ${suffix}` : `${phrase} ${subject.text}`;
}

/** Title-case a snake_case op type as a fallback label (e.g. set_track_flags → "Set track flags"). */
const humanize = (type: string): string =>
  type.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** A descriptor for one operation: the action label, a compact detail, and chips. */
export interface OperationDescriptor {
  readonly action: string;
  readonly detail: string;
  readonly refs: readonly Reference[];
}

/**
 * Describe one operation for a {@link TimelineActionEvent}.
 *
 * @param op - The typed operation to describe.
 * @param names - Optional id→name resolver so chips read "Intro.mp4" / "Video 1"
 *   instead of raw ids. When omitted, labels fall back to the id (backward-compatible).
 * @returns The action label, a compact detail string, and clickable clip/track/asset
 *   references pulled from the op's id fields.
 */
/**
 * The subject of an operation that keeps it somewhere other than a top-level
 * `clipId`/`trackId`/`assetId` or a `start`/`end` pair.
 *
 * ## WHY this exists
 *
 * Without it those operations render as an action label and *nothing else* — a row that
 * says "Added marker" and stops. In run `137d8fd0`, **52 of 416 edit cards were blank**
 * that way: `add_layer` ×24, `add_asset` ×13, `add_marker` ×9, `remove_layer` ×4,
 * `move_layer`, `set_ai_memory`. The user's prompt had asked, in as many words, to "drop
 * markers on your candidates before you cut anything **so I can see what you picked**",
 * and the nine markers the agent dropped appeared with no time and no label on any of
 * them. The single thing that request was for was the thing the account could not show.
 *
 * Each entry answers "what is this row about?" in the terms the row is for. Anything not
 * listed still falls through to the generic range/id path, which is right for the
 * operations whose subject really is a clip and a span.
 */
function operationSubject(op: AnyOperation, record: Record<string, unknown>, names?: ProjectNames): string {
  switch (op.type) {
    case 'add_asset': {
      const asset = record['asset'];
      const id = typeof asset === 'object' && asset ? (asset as { id?: unknown }).id : undefined;
      const path = typeof asset === 'object' && asset ? (asset as { path?: unknown }).path : undefined;
      // The op's OWN path wins. `add_asset` is the operation that puts the asset in the
      // project, so at the moment it is described the resolver has never heard of it —
      // and `ProjectNames.asset` answers an unknown id with the id, not with `undefined`,
      // so a `??` chain starting there never reaches the file name at all.
      const name = basename(path);
      if (name !== undefined) return name;
      return typeof id === 'string' ? (names?.asset(id) ?? id) : '';
    }
    case 'remove_asset':
    case 'move_asset': {
      const id = record['assetId'];
      return typeof id === 'string' ? (names?.asset(id) ?? id) : '';
    }
    case 'add_marker': {
      const time = record['time'];
      const label = record['label'];
      const at = typeof time === 'number' ? `${round(time)}s` : '';
      const text = typeof label === 'string' && label.trim() !== '' ? clampSubject(label) : '';
      // Both when both exist: a marker with no time cannot be found and a marker with no
      // label cannot be told apart from the eight others the run just dropped.
      return text && at ? `${text} · ${at}` : text || at;
    }
    case 'remove_marker': {
      const id = record['id'];
      return typeof id === 'string' ? id : '';
    }
    case 'create_folder':
    case 'rename_folder': {
      const name = record['name'];
      return typeof name === 'string' ? clampSubject(name) : '';
    }
    case 'move_folder':
    case 'delete_folder': {
      const id = record['folderId'];
      return typeof id === 'string' ? id : '';
    }
    case 'set_ai_memory': {
      const memory = record['memory'];
      const keys = typeof memory === 'object' && memory ? Object.keys(memory).length : 0;
      return keys === 1 ? '1 note' : `${String(keys)} notes`;
    }
    case 'restore_assets':
    case 'restore_folders':
    case 'restore_clips': {
      const list = record['assets'] ?? record['folders'] ?? record['clips'];
      const count = Array.isArray(list) ? list.length : 0;
      return count === 1 ? '1 item' : `${String(count)} items`;
    }
    case 'set_transcript': {
      const words = record['words'];
      const count = Array.isArray(words) ? words.length : 0;
      return count === 1 ? '1 word' : `${String(count)} words`;
    }
    case 'move_layer': {
      const index = record['toIndex'];
      return typeof index === 'number' ? `to slot ${String(index)}` : '';
    }
    default:
      return '';
  }
}

/** File name of a media path, for an asset the names resolver does not know yet. */
function basename(path: unknown): string | undefined {
  if (typeof path !== 'string' || path.trim() === '') return undefined;
  return path.split('/').pop() || undefined;
}

export function describeOperation(op: AnyOperation, names?: ProjectNames): OperationDescriptor {
  const record = op as unknown as Record<string, unknown>;
  const action = ACTION_LABELS[op.type] ?? humanize(op.type);

  const refs: Reference[] = [];
  const clipId = record['clipId'];
  if (typeof clipId === 'string') {
    refs.push({ kind: 'clip', id: clipId, label: names?.clip(clipId) ?? clipId });
  }
  const trackId = record['trackId'];
  if (typeof trackId === 'string') {
    refs.push({ kind: 'track', id: trackId, label: names?.track(trackId) ?? trackId });
  }
  // A LAYER IS A TRACK. `add_layer`/`remove_layer`/`move_layer` name it `layerId`, and
  // because nothing here read that field, all 29 of run `137d8fd0`'s layer operations
  // rendered with no chip at all — the user could not tell which lane had been created.
  const layerId = record['layerId'];
  if (typeof layerId === 'string') {
    refs.push({ kind: 'track', id: layerId, label: names?.track(layerId) ?? layerId });
  }
  const assetId = record['assetId'];
  if (typeof assetId === 'string') {
    refs.push({ kind: 'asset', id: assetId, label: names?.asset(assetId) ?? assetId });
  }
  const nestedAsset = record['asset'];
  if (refs.length === 0 && typeof nestedAsset === 'object' && nestedAsset) {
    const id = (nestedAsset as { id?: unknown }).id;
    if (typeof id === 'string') refs.push({ kind: 'asset', id, label: names?.asset(id) ?? id });
  }

  const start = record['start'];
  const end = record['end'];
  const detail =
    op.type === 'set_track_flags'
      ? trackFlagDetail(record)
      : typeof start === 'number' && typeof end === 'number'
        ? `${round(start)}s–${round(end)}s`
        : operationSubject(op, record, names);

  return { action, detail, refs };
}
