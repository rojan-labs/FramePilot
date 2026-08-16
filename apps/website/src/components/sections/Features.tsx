import { Section } from '@/components/Section';

const CAPABILITIES = [
  {
    title: 'Agent editing',
    description: 'Describe the outcome. FramePilot resolves supported requests into typed operations on the active project.',
    meta: 'Cuts · reframes · captions · timeline operations',
  },
  {
    title: 'A real timeline',
    description: 'Keep trimming, splitting, moving, keyframing, mixing, and refining the result with normal editor controls.',
    meta: 'Multitrack · snapping · undo · keyboard workflows',
  },
  {
    title: 'Media intelligence',
    description: 'The agent can work from project context, transcripts, frames, scenes, beats, and the media already available to the edit.',
    meta: 'Transcripts · scene analysis · beat analysis · frame inspection',
  },
  {
    title: 'Local project authority',
    description: 'Original media stays untouched. Project state remains explicit, and final output goes through the deterministic render path.',
    meta: 'Local-first · non-destructive · validated export',
  },
] as const;

export function Features() {
  return (
    <Section id="features" className="bg-white">
      <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
        <div className="max-w-xl">
          <p className="eyebrow-tc mb-5">The product</p>
          <h2 className="text-[length:var(--text-h2)] leading-[var(--text-h2--line-height)] tracking-[var(--text-h2--letter-spacing)]">
            AI where it saves time. An editor everywhere else.
          </h2>
          <p className="mt-6 max-w-lg text-[15px] leading-7 text-fg-secondary sm:text-[16px]">
            FramePilot keeps the editing model simple. Language can accelerate work, but the project, timeline, media, and final render remain concrete editor systems.
          </p>
        </div>

        <ol className="border-t border-line">
          {CAPABILITIES.map((capability, index) => (
            <li key={capability.title} className="grid gap-3 border-b border-line py-6 sm:grid-cols-[44px_180px_minmax(0,1fr)] sm:gap-6 sm:py-7">
              <span className="font-mono text-[9px] text-fg-muted">0{index + 1}</span>
              <h3 className="text-[15px] font-semibold tracking-[-0.02em] text-fg">{capability.title}</h3>
              <div>
                <p className="max-w-xl text-[13.5px] leading-6 text-fg-secondary">{capability.description}</p>
                <p className="mt-2 font-mono text-[8.5px] leading-5 text-fg-muted">{capability.meta}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </Section>
  );
}
