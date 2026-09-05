/**
 * Landing-page capability copy. Every claim here must match shipped behaviour
 * in the repository README and architecture.
 *
 * Capabilities are grouped onto three tracks, the way the product itself is
 * layered: what the agent does, what you do by hand, and what the machine
 * guarantees underneath both. `start` and `span` place each capability's clip
 * on its track so the section reads as a sequence rather than a card wall.
 */

export type FeatureTrack = 'agent' | 'editor' | 'engine';

export interface Feature {
  title: string;
  description: string;
  track: FeatureTrack;
  /** Left edge of the clip on its track, in percent. */
  start: number;
  /** Clip length, in percent. */
  span: number;
}

export const FEATURE_TRACKS: { id: FeatureTrack; slot: string; label: string; caption: string }[] = [
  { id: 'agent', slot: 'V2', label: 'The agent', caption: 'What a sentence gets you' },
  { id: 'editor', slot: 'V1', label: 'You', caption: 'What your hands still do' },
  { id: 'engine', slot: 'A1', label: 'The machine', caption: 'What holds underneath both' },
];

export const FEATURES: Feature[] = [
  {
    track: 'agent',
    start: 0,
    span: 44,
    title: 'An agent that edits the real timeline',
    description:
      'Describe the change you want. FramePilot turns it into typed timeline operations, checks them, and applies them to the project already open in front of you. You watch every step, and one undo takes back the whole run.',
  },
  {
    track: 'agent',
    start: 46,
    span: 30,
    title: 'It looks at the actual frames',
    description:
      'Transcription, scene detection, beat analysis, and a searchable index of your footage. Before claiming a shot looks right, a vision-capable model can render that frame through the export compiler and check. When a key or analysis is missing it says so rather than inventing an answer.',
  },
  {
    track: 'agent',
    start: 78,
    span: 22,
    title: 'Your coding agent can drive it too',
    description:
      'FramePilot exposes its typed editing tools over MCP, so Claude, Cursor, or anything else that speaks the protocol can operate the editor behind the same guardrails.',
  },
  {
    track: 'editor',
    start: 0,
    span: 38,
    title: 'The manual tools never go away',
    description:
      'Trim, split, ripple, snap, keyframe, mix audio, style captions, add transitions, work across tracks. Your mouse and the agent drive the same editing model.',
  },
  {
    track: 'editor',
    start: 40,
    span: 28,
    title: 'Captions are editable timeline data',
    description:
      "Word-level timing you can actually edit. Split cues, merge them, restyle them, emphasize a word, then burn them into the export when you're ready.",
  },
  {
    track: 'editor',
    start: 70,
    span: 30,
    title: 'One undo for the entire run',
    description:
      'Every agent change is a concrete operation with a diff attached. Read what it did, disagree, and reverse the run without rebuilding your edit. You can also stop a run mid-flight, and it survives a crash.',
  },
  {
    track: 'engine',
    start: 0,
    span: 52,
    title: 'Everything stays on your machine',
    description:
      'Projects, originals, derived media, renders. Hosted AI is opt-in and you choose the provider, while the editing and rendering never leave your computer.',
  },
  {
    track: 'engine',
    start: 54,
    span: 46,
    title: 'Exports that check themselves',
    description:
      'Final renders run through the Python and FFmpeg engine, then get inspected for wrong duration, missing streams, black frames, and clipped audio before the file ever reaches you.',
  },
];

/** The work FramePilot is built for. Used as the hero's ledger. */
export const MAKES = [
  'Product demos',
  'Screen recordings',
  'Talking head',
  'Podcast clips',
  'Course lessons',
  'Short-form video',
] as const;
