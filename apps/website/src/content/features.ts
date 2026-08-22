import type { LucideIcon } from 'lucide-react';
import {
  Captions,
  GitBranch,
  Layers3,
  LockKeyhole,
  PlugZap,
  ScanSearch,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';

export interface Feature {
  icon: LucideIcon;
  title: string;
  description: string;
  wide?: boolean;
}

export const FEATURES: Feature[] = [
  {
    icon: Sparkles,
    title: 'An agent that edits the real timeline',
    description:
      'Describe the change you want. FramePilot turns it into typed timeline operations, checks them, and applies them to the project already open in front of you. You watch every step, and one undo takes back the whole run.',
    wide: true,
  },
  {
    icon: Layers3,
    title: 'The manual tools never go away',
    description:
      'Trim, split, ripple, snap, keyframe, mix audio, style captions, add transitions, work across tracks. Your mouse and the agent drive the same editing model.',
  },
  {
    icon: GitBranch,
    title: 'One undo for the entire run',
    description:
      'Every agent change is a concrete operation with a diff attached. Read what it did, disagree, and reverse the run without rebuilding your edit from scratch.',
  },
  {
    icon: ScanSearch,
    title: "It knows what's in your footage",
    description:
      'Transcription, scene detection, beat analysis, frame inspection, and project memory. The agent works from what the media actually contains instead of guessing from filenames.',
  },
  {
    icon: ShieldCheck,
    title: 'Exports that check themselves',
    description:
      'Final renders run through the Python and FFmpeg engine, then get inspected for wrong duration, missing streams, black frames, and clipped audio before the file ever reaches you.',
  },
  {
    icon: Captions,
    title: 'Captions are editable timeline data',
    description:
      "Word-level timing you can actually edit. Split cues, merge them, restyle them, emphasize a word, then burn them into the export when you're ready.",
  },
  {
    icon: LockKeyhole,
    title: 'Everything stays on your machine',
    description:
      'Projects, originals, derived media, renders. Hosted AI is opt-in and you choose the provider, while the editing and rendering never leave your computer.',
  },
  {
    icon: PlugZap,
    title: 'Your coding agent can drive it too',
    description:
      'FramePilot exposes its typed editing tools over MCP, so Claude, Cursor, or anything else that speaks the protocol can operate the editor behind the same guardrails.',
    wide: true,
  },
];

export interface Step {
  title: string;
  description: string;
}

export const STEPS: Step[] = [
  {
    title: 'Bring in real footage',
    description:
      'Import recordings, camera files, voiceover, music, images, captions. You get the same multitrack project whether you plan to edit it yourself or hand it to the agent.',
  },
  {
    title: 'Edit by hand or describe the outcome',
    description:
      'Ask for a tighter cut, a vertical short, captions, a reframe, better pacing. The request comes back as concrete operations sitting on your timeline.',
  },
  {
    title: 'Inspect, undo, and export',
    description:
      'Read what changed, undo the whole run in one step if you hate it, then export through the render engine that validates its own output.',
  },
];

export const MAKES = [
  'Product demos',
  'Screen recordings',
  'Talking head',
  'Podcast clips',
  'Course lessons',
  'Short-form video',
] as const;
