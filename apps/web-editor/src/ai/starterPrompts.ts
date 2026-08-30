/**
 * The starter prompts in the AI sidebar's empty state (UX-02).
 *
 * They used to be four hard-coded strings, and the walkthrough caught them saying
 * exactly the wrong thing: "Add captions from the transcript" on a project with no
 * transcript, and "Mute the music track" on a project with no music. A suggestion
 * that cannot work is worse than no suggestion — it is the panel's first
 * impression, and it is teaching the user that the AI does not know what is in
 * front of it.
 *
 * So each candidate carries the precondition that makes it real, in the order an
 * edit usually happens, and the empty state shows the first few whose
 * precondition holds. The last two are unconditional so the list is never empty —
 * on a project with nothing in it, "What's in my footage?" is still a question the
 * agent can answer, and asking for a plan is always available.
 */
import type { Project } from '@framepilot/timeline-schema';

/** How many suggestions the empty state has room for. */
const VISIBLE_PROMPTS = 4;

interface StarterCandidate {
  readonly prompt: string;
  /** True when this project can actually act on the prompt. */
  readonly applies: (project: Project) => boolean;
}

const hasPictureClips = (project: Project): boolean =>
  project.timeline.tracks.some((track) => track.type !== 'audio' && track.clips.length > 0);

const hasAudioClips = (project: Project): boolean =>
  project.timeline.tracks.some((track) => track.type === 'audio' && track.clips.length > 0);

const hasCaptions = (project: Project): boolean =>
  project.timeline.tracks.some((track) => track.type === 'caption' && track.clips.length > 0);

const CANDIDATES: readonly StarterCandidate[] = [
  { prompt: 'Remove the silent gaps', applies: hasPictureClips },
  {
    // Only once there IS a transcript. Without one this was the panel promising
    // something the project cannot supply.
    prompt: 'Add captions from the transcript',
    applies: (project) => project.transcript.length > 0 && !hasCaptions(project),
  },
  {
    prompt: 'Restyle the captions',
    applies: hasCaptions,
  },
  { prompt: 'Punch in on the intro', applies: hasPictureClips },
  { prompt: 'Mute the music track', applies: hasAudioClips },
  {
    prompt: 'Find the strongest moment for a hook',
    applies: (project) => project.transcript.length > 0,
  },
  {
    prompt: 'Import my footage and build a rough cut',
    applies: (project) => !hasPictureClips(project),
  },
  { prompt: 'What’s in my footage?', applies: () => true },
  { prompt: 'Plan an edit for this project', applies: () => true },
];

/**
 * The suggestions to offer for `project`.
 *
 * @param project - The document the sidebar is looking at.
 * @returns Up to four prompts, every one of which this project can act on.
 */
export function starterPrompts(project: Project): readonly string[] {
  return CANDIDATES.filter((candidate) => candidate.applies(project))
    .slice(0, VISIBLE_PROMPTS)
    .map((candidate) => candidate.prompt);
}
