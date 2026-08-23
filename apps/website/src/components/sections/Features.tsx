import { Section } from '@/components/Section';

const CAPABILITIES = [
  {
    title: 'Agent editing',
    description: 'Ask for the cut you want. FramePilot turns it into real operations on the open project, the same ones your toolbar produces.',
    meta: 'Cuts · reframes · captions · timeline operations',
  },
  {
    title: 'A real timeline',
    description: 'Whatever the agent does, you can still trim it, split it, move it, or keyframe it. Nothing it touches becomes read-only.',
    meta: 'Multitrack · snapping · undo · keyboard workflows',
  },
  {
    title: 'Media intelligence',
    description: 'The agent reads your transcript, looks at frames, and finds scene cuts and beats before it decides where to cut.',
    meta: 'Transcripts · scene analysis · beat analysis · frame inspection',
  },
  {
    title: 'Local project authority',
    description: 'Your originals are never overwritten. Exports run the same way every time, and the engine checks its own output before handing it over.',
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
            Asking for an edit is just another way to reach the timeline. The project, the media, and the render behave exactly as they would if you&rsquo;d done all of it by hand.
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
