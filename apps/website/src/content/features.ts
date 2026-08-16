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
      'Describe the result you want. FramePilot turns that request into typed timeline operations, validates them, applies them to the same project you edit by hand, and keeps the run inspectable and undoable.',
    wide: true,
  },
  {
    icon: Layers3,
    title: 'Professional controls stay within reach',
    description:
      'Trim, split, ripple, snap, keyframe, mix audio, style captions, apply transitions, and work across multiple tracks. Agent work and manual work share the same editing model.',
  },
  {
    icon: GitBranch,
    title: 'Undo a run, not your confidence',
    description:
      'Agent changes are concrete operations with diffs and grouped undo. You can inspect what changed and reverse the run without rebuilding the edit from scratch.',
  },
  {
    icon: ScanSearch,
    title: 'Understands the footage it is working on',
    description:
      'Media analysis, transcription, scene and beat analysis, frame inspection, and project memory give the editor evidence to work from instead of guessing from filenames.',
  },
  {
    icon: ShieldCheck,
    title: 'Export through a deterministic pipeline',
    description:
      'Final renders go through the Python and FFmpeg export engine and automated validation for expected duration, streams, black frames, and audio clipping.',
  },
  {
    icon: Captions,
    title: 'Captions are editable timeline data',
    description:
      'Generate word-level timing, edit cues, split or merge them, apply style templates and emphasis, then burn the result into export when you want it.',
  },
  {
    icon: LockKeyhole,
    title: 'Local-first by design',
    description:
      'Projects, originals, derived media, and renders stay on your machine. Optional hosted AI capabilities are explicit, while the editing and render stack remains local.',
  },
  {
    icon: PlugZap,
    title: 'The same safe tools can power external agents',
    description:
      'FramePilot exposes its typed editing surface through MCP so compatible clients can operate the editor through the same guarded project authority.',
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
      'Import recordings, camera files, voiceover, music, images, and captions. FramePilot builds the same multitrack project whether you plan to edit manually or with the agent.',
  },
  {
    title: 'Edit by hand or describe the outcome',
    description:
      'Ask for a tighter cut, a vertical short, captions, reframing, pacing changes, or another supported edit. The request resolves into concrete operations on your timeline.',
  },
  {
    title: 'Inspect, undo, and export',
    description:
      'Review the run and its timeline changes, undo it as a group when needed, then export through the deterministic render and validation pipeline.',
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
