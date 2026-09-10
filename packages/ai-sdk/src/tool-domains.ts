/**
 * Which tools a run advertises, and which it has to ask for (progressive disclosure).
 *
 * ## Why this exists
 *
 * Captured run `35746d4c` spent 62.6% of its entire context on tool schemas. Its final
 * request carried 12,823 tokens of tool definitions against 222 tokens of the transcript
 * it was captioning — 58x more about tools it *could* call than about the material it was
 * editing. Across all 21 of that run's requests: 347,108 tokens of tool schema, 25,740
 * tokens of evidence about the video. The model was asked to make editorial decisions
 * with 4.6% of its attention on the footage.
 *
 * Stage narrowing did not help. `stage-policy.ts` withholds only `analysis`-role tools,
 * and only during the three execution stages, which measured as 87 tools / 18,449 tokens
 * at every stage except `apply`/`enhance`/`repair`, where it is 75 / 15,994 — a 13% cut
 * on three stages out of eight.
 *
 * ## The shape
 *
 * A small {@link CORE} set is always advertised: everything needed to read the project and
 * make an ordinary cut. The rest is grouped into {@link ToolDomain}s that a run pins by
 * calling `load_tools`, after which they stay advertised for the remainder of the run —
 * the same lifetime as a skill loaded through `load_skill`.
 *
 * The domains are the module boundaries the registry is already assembled from
 * (`domain-tools/*.ts`), not a new taxonomy laid over them. A tool's domain is therefore
 * a fact about where it lives, which is much harder to get quietly wrong than 87
 * individual annotations would be — and a registry-shape test asserts every tool has one.
 *
 * ## What stops this from stranding a run
 *
 * A withheld tool is not an absent capability, and three things keep it reachable:
 *
 *  1. The `load_tools` description names every domain and what is in it, so the index is
 *     in front of the model on every turn at a cost of a few hundred tokens.
 *  2. Calling a tool from an unpinned domain pins that domain and says so, rather than
 *     failing as an unknown tool. A run that guesses right is not punished for it.
 *  3. Loading a skill pins the domains that skill's work needs (see `SKILL_DOMAINS`), so
 *     the caption playbook and the caption tools arrive together.
 */

/** A group of tools a run pins in one call. `core` is never pinned — it is always on. */
export type ToolDomain =
  | 'core'
  | 'captions'
  | 'audio'
  | 'color'
  | 'motion'
  | 'effects'
  | 'footage'
  | 'sourcing'
  | 'tracking'
  | 'media'
  | 'professional';

/**
 * What each domain holds, in the words the model reads when it decides whether to load it.
 *
 * These are the whole discovery surface — a domain the model cannot tell it needs is a
 * capability the product does not have. Written as outcomes ("cut to the beat"), never as
 * module names, because the model is choosing by what it is trying to do.
 */
export const DOMAIN_SUMMARY: Readonly<Record<Exclude<ToolDomain, 'core'>, string>> = {
  captions: 'write, restyle and emphasise captions; browse caption templates; check caption sync',
  audio:
    'transcribe; adjust levels; find and cut silence and filler words; detect beats to cut to; add music; professional audio moves',
  // Named for the words a REQUEST uses, not only the moves. A run asked to "build a
  // professional edit" never pinned this domain across 37 minutes and six `load_tools`
  // calls, so three shipped tools were unreachable in practice — the summary is the whole
  // discovery surface, and "match shots to each other" is not what that request sounds like.
  color:
    'grade the picture — the colour and look pass of a professional edit: match shots to each other, even out exposure, apply a cinematic look, grade directly; measure what is on screen now',
  motion: 'keyframes, punch-ins, camera moves and speed ramps',
  effects: 'effects, transitions and on-screen text; browse what is available; verify fit',
  footage:
    'understand the raw material: scenes, shots, what is visually in it, where each moment lives',
  sourcing: 'find and place stock footage and music from the libraries',
  tracking: 'track a subject or object over time; masks and rotoscoping',
  media: 'import media into the project and organise the bin',
  professional: 'resolver-gated professional editing intent (rolls, slips, slides, inserts)',
};

/**
 * The always-advertised set: read the project, and make the ordinary cut.
 *
 * The rule for membership is "a run doing ANY editing job needs this". Reading the
 * timeline and the transcript, placing and trimming and deleting clips, tracks, markers,
 * asking the editor a question, recalling what the run already found, loading a skill or
 * a tool domain, previewing and exporting. Anything specialised to one kind of work —
 * captions, colour, audio, motion, tracking — is a domain, however common that work is.
 */
const CORE: readonly string[] = [
  // Reading the project.
  'get_timeline',
  'get_timeline_summary',
  'get_timeline_map',
  'get_transcript',
  'get_mapped_transcript',
  'get_clip',
  'get_clips',
  'get_selected_range',
  'get_project_state',
  'list_assets',
  'list_edit_boundaries',
  'map_time',
  'read_edit_signals',
  'recall_evidence',
  'session_context',
  // The ordinary cut.
  'add_clip',
  'add_clips',
  'trim_clip',
  'split_clip',
  'delete_clip',
  'delete_clips',
  'delete_range',
  'ripple_delete',
  'move_clip',
  'reorder_clips',
  'tighten_clips',
  'add_track',
  'remove_track',
  'move_track',
  'set_track_flags',
  'add_marker',
  'remove_marker',
  // Seeing what the run has DONE, and the two tools a runtime rail names by hand.
  //
  // These three are not core because they are common — they are core because
  // `kernel/stage-policy.ts` already exempts each of them from every stage narrowing,
  // each after a run died without it: `get_frame` is how the agent looks at its own edit
  // (`VERIFICATION_LOOK_TOOL_NAMES`), `detect_beats` measures the music the run places
  // while it edits (`EXECUTION_MEASUREMENT_TOOL_NAMES`, run `ea8e46ec` was refused it
  // twice and died), and `transcribe` is what a mutation's own precondition tells the model to
  // run (`PRECONDITION_TOOL_NAMES`). A tool the runtime has decided must always be
  // reachable must not then need asking for; `tool-domains.test.ts` asserts that both
  // ways round, so a future exemption cannot be added without landing here too.
  'get_frame',
  'detect_beats',
  'transcribe',
  // The picture look in numbers — the same exemption as `get_frame`, for the same reason,
  // and it landed here for the same reason too: run `137d8fd0` was asked to "measure what's
  // actually on screen", called this twice in `apply`, and was refused both times as an
  // analysis tool. A colour self-check the model cannot see is an opt-in.
  'measure_color',
  // Talking to the editor, and to the run's own memory.
  'ask_user',
  'remember_preference',
  'load_skill',
  'load_tools',
  // Seeing the result.
  'render_preview',
  'export_video',
];

/** Every tool that is not core, by the domain that pins it. */
const DOMAIN_MEMBERS: Readonly<Record<Exclude<ToolDomain, 'core'>, readonly string[]>> = {
  captions: [
    'caption_the_edit',
    'add_caption_layer',
    'set_caption_style',
    'set_track_caption_style',
    'auto_emphasize_captions',
    'verify_captions',
    'discover_caption_styles',
  ],
  audio: [
    'adjust_audio',
    'analyze_silence',
    'remove_silences',
    'remove_filler_words',
    'professional_audio',
  ],
  color: [
    'apply_color_grade',
    'match_color',
    'normalize_exposure',
    'apply_look',
    'professional_color',
  ],
  motion: [
    'add_keyframes',
    'remove_keyframes',
    'punch_in',
    'set_clip_speed',
    'set_clip_speed_ramp',
    'set_clip_crop',
    'professional_motion',
  ],
  effects: [
    'add_text_layer',
    'add_transition',
    'add_transitions',
    'apply_effect',
    'adjust_effect',
    'move_effect',
    'resize_effect',
    'remove_effect',
    'set_effect_enabled',
    'set_clip_blend_mode',
    'discover_effects',
    'discover_transitions',
    'verify_transitions',
  ],
  footage: [
    'detect_scenes',
    'search_media',
    'find_similar',
    'search_visual',
    'describe_footage',
    'map_footage',
    'index_media',
  ],
  sourcing: ['search_stock', 'add_stock', 'search_music', 'add_music'],
  tracking: [
    'add_mask',
    'generate_mask',
    'track_object',
    'professional_tracking_mask',
    'track_subject_automatically',
    'detect_subjects',
  ],
  media: ['add_asset', 'manage_assets'],
  professional: ['professional_edit'],
};

const BY_NAME: ReadonlyMap<string, ToolDomain> = new Map<string, ToolDomain>([
  ...CORE.map((name) => [name, 'core'] as const),
  ...Object.entries(DOMAIN_MEMBERS).flatMap(([domain, names]) =>
    names.map((name) => [name, domain as ToolDomain] as const),
  ),
]);

/** Every loadable domain, in the order the `load_tools` index lists them. */
export const LOADABLE_DOMAINS = Object.keys(DOMAIN_SUMMARY) as Exclude<ToolDomain, 'core'>[];

/**
 * The domain that pins a tool, or `undefined` for a name the registry does not hold.
 *
 * A registered tool missing from the map would be advertised nowhere and reachable by
 * nothing, so `tool-registry.test.ts` asserts the map covers the registry exactly.
 */
export function toolDomain(name: string): ToolDomain | undefined {
  return BY_NAME.get(name);
}

/** Is this tool advertised to a run that has pinned `loaded`? */
export function toolIsAdvertised(name: string, loaded: ReadonlySet<ToolDomain>): boolean {
  const domain = toolDomain(name);
  // An unmapped tool is advertised rather than hidden. The shape test makes this
  // unreachable, but failing OPEN is the right direction for a registry mistake: a tool
  // that costs tokens it should not is a worse product than one no run can reach.
  if (domain === undefined) return true;
  return domain === 'core' || loaded.has(domain);
}

/** Every tool name in a domain (used by `load_tools` to report what it just pinned). */
export function domainMembers(domain: Exclude<ToolDomain, 'core'>): readonly string[] {
  return DOMAIN_MEMBERS[domain];
}

/**
 * Domains a loaded skill needs beyond the ones its own `tools:` list implies.
 *
 * Hand-written entries are for a playbook whose work needs a domain it does not name a
 * tool from. Everything a skill DOES name is derived instead ({@link domainsForSkill}),
 * because a hand-kept table drifts the moment a skill is edited — and it had: one entry
 * for twenty-one skills, so `color-grading` pinned nothing and the colour domain went
 * unpinned across a whole 37-minute "professional edit" run.
 */
export const SKILL_DOMAINS: Readonly<Record<string, readonly Exclude<ToolDomain, 'core'>[]>> = {
  'caption-design': ['captions', 'audio'],
};

/**
 * Every domain a skill's work needs — the domains of the tools it names, plus any extra
 * this module records for it.
 *
 * A playbook and the tools it tells the run to use must arrive together: loading the
 * colour playbook and then discovering `match_color` is not advertised is a round trip
 * the run should never spend, and in practice does not spend — it edits without ever
 * reaching the tool. This is a fact about the skill, not a judgement the model makes.
 *
 * @param skillName - The skill's `name` frontmatter.
 * @param toolNames - The tools the skill's `tools:` frontmatter names.
 * @returns The domains to pin, `core` never among them.
 */
export function domainsForSkill(
  skillName: string,
  toolNames: readonly string[],
): readonly Exclude<ToolDomain, 'core'>[] {
  const domains = new Set<Exclude<ToolDomain, 'core'>>(SKILL_DOMAINS[skillName] ?? []);
  for (const toolName of toolNames) {
    const domain = toolDomain(toolName);
    if (domain !== undefined && domain !== 'core') domains.add(domain);
  }
  return [...domains];
}

/** The domain index the `load_tools` description carries, built once. */
/**
 * The words a REQUEST uses for each domain's outcome — the same vocabulary
 * {@link DOMAIN_SUMMARY} is written in, read back the other way.
 */
const DOMAIN_REQUEST_WORDS: Readonly<Record<Exclude<ToolDomain, 'core'>, RegExp>> = {
  sourcing: /\b(stock(?: footages?| clips?| plates?| videos?)?|b-?roll|cutaways?|music|soundtrack|score|sound ?bed)\b/gi,
  color: /\b(colou?r(?: grade| pass| correct\w*)?|grade|graded|grading|look|exposure|lut)\b/gi,
  captions: /\b(captions?|subtitles?)\b/gi,
  audio: /\b(silences?|dead air|fillers?|filler words|duck\w*|loudness|beats?)\b/gi,
  motion: /\b(punch[- ]?ins?|keyframes?|zooms?|speed ramps?|reframe\w*|crops?)\b/gi,
  effects: /\b(transitions?|effects?|titles?|text layers?|graphics?|callouts?)\b/gi,
  footage: /\b(index(?:ed|ing)?|index_media|map_footage|describe_footage|search_visual|detect_scenes|footage map|scene detection|shot list)\b/gi,
  tracking: /\b(track(?:ing)? (?:the )?subject|masks?|rotoscop\w*)\b/gi,
  media: /\b(import\w*|media bin|organi[sz]e the bin)\b/gi,
  professional: /\b(roll edits?|slip|slide edits?|insert edits?)\b/gi,
};

/** A domain the request named and the run never loaded. */
export interface NeverLoadedDomain {
  readonly domain: Exclude<ToolDomain, 'core'>;
  /** The request's own words that named it, first three, as written. */
  readonly mentions: readonly string[];
  /** The tools that were therefore never offered. */
  readonly tools: readonly string[];
}

/**
 * Which domains the request asked for by name that the run never loaded.
 *
 * Run `df81d58e` (2026-09-08) was briefed for stock, b-roll and music, loaded five domains
 * across two `load_tools` calls, and never `sourcing`: `search_stock` and `add_stock` were
 * never on its list, no cutaway was ever attempted, and the closing report said nothing
 * about it. The summary is the discovery surface (see {@link DOMAIN_SUMMARY}), so a domain
 * the model did not think to load is one the editor has to be told about.
 *
 * Pure: the request text and the loaded set in, a list out. Empty for a run that loaded
 * everything it was asked for, so an ordinary report is unchanged.
 */
export function requestedDomainsNeverLoaded(
  request: string,
  loaded: ReadonlySet<ToolDomain>,
): NeverLoadedDomain[] {
  const out: NeverLoadedDomain[] = [];
  for (const domain of LOADABLE_DOMAINS) {
    if (loaded.has(domain)) continue;
    const pattern = new RegExp(DOMAIN_REQUEST_WORDS[domain].source, 'gi');
    const seen = new Set<string>();
    const mentions: string[] = [];
    for (const match of request.matchAll(pattern)) {
      const word = match[0].toLowerCase();
      if (seen.has(word)) continue;
      seen.add(word);
      mentions.push(match[0]);
      if (mentions.length === 3) break;
    }
    if (mentions.length === 0) continue;
    out.push({ domain, mentions, tools: domainMembers(domain) });
  }
  return out;
}

export const DOMAIN_INDEX = LOADABLE_DOMAINS.map(
  (domain) => `${domain}: ${DOMAIN_SUMMARY[domain]}`,
).join(' | ');
