import type { CSSProperties } from 'react';
import { Section, SectionHeading } from '@/components/Section';
import { ClipRow, ClipTrack } from '@/components/motion/ClipReveal';
import { Ruler } from '@/components/timeline/Ruler';
import { FEATURES, FEATURE_TRACKS, type FeatureTrack } from '@/content/features';

/*
 * Three tracks, not eight cards. A capability's clip sits on the track that
 * actually performs it — the agent, your hands, or the machine underneath —
 * and its position and length place it in the sequence rather than in a grid.
 */
const CLIP_STYLES: Record<FeatureTrack, string> = {
  agent: 'bg-accent text-accent-ink',
  editor: 'bg-fg text-canvas',
  engine: 'border border-line-strong bg-elevated text-fg',
};

const CLIP_TEXT: Record<FeatureTrack, string> = {
  agent: 'text-accent-ink',
  editor: 'text-canvas',
  engine: 'text-fg',
};

export function Features() {
  return (
    <Section id="features" tone="shade">
      <SectionHeading
        tc="00:02"
        eyebrow="The product"
        title="AI where it saves time. An editor everywhere else."
        description="Asking for an edit is just another way to reach the timeline. The project, the media, and the render behave exactly as they would if you'd done all of it by hand."
      />

      <div className="mt-14 space-y-12 sm:mt-16 sm:space-y-14">
        {FEATURE_TRACKS.map((track) => {
          const clips = FEATURES.filter((feature) => feature.track === track.id);

          return (
            <div key={track.id}>
              <div className="flex items-baseline gap-3">
                <span className="tc tabular text-fg-muted">{track.slot}</span>
                <h3 className="font-display text-[19px] font-semibold tracking-[-0.03em] text-fg">
                  {track.label}
                </h3>
                <span className="tc text-fg-tertiary">{track.caption}</span>
              </div>

              <Ruler className="mt-3" />

              <ClipTrack as="ol" className="mt-4 space-y-6">
                {clips.map((feature) => (
                  <ClipRow key={feature.title} as="li">
                    <div className="lane group px-1.5 py-1.5">
                      {/*
                        The clip's offset and length place it in the sequence.
                        Narrow viewports have no room for a sequence, so the
                        clip falls back to the full width of its lane.
                      */}
                      <div
                        className={`flex min-h-[32px] items-center truncate rounded-[3px] px-3 text-[12.5px] font-medium leading-4 transition-transform duration-200 ease-[var(--ease-snap)] group-hover:-translate-y-px sm:ml-[var(--start)] sm:w-[var(--span)] sm:min-w-[210px] ${CLIP_STYLES[track.id]}`}
                        style={
                          {
                            '--start': `${feature.start}%`,
                            '--span': `${feature.span}%`,
                          } as CSSProperties
                        }
                      >
                        <span className={`truncate ${CLIP_TEXT[track.id]}`}>{feature.title}</span>
                      </div>
                    </div>
                    <p className="mt-2.5 max-w-2xl text-[13.5px] leading-6 text-fg-secondary">
                      {feature.description}
                    </p>
                  </ClipRow>
                ))}
              </ClipTrack>
            </div>
          );
        })}
      </div>
    </Section>
  );
}
