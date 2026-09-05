import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/Button';
import { InPoint, Ruler } from '@/components/timeline/Ruler';

export function FinalCta() {
  return (
    <section className="bg-canvas">
      <div className="container-x">
        <Ruler />
        <div className="py-18 sm:py-24 lg:py-28">
          <p className="flex items-center gap-2.5">
            <InPoint />
            <span className="tc text-accent">00:06</span>
            <span className="tc">FramePilot · pre-release</span>
          </p>
          <h2 className="mt-6 font-display text-[clamp(2.8rem,6.6vw,6.4rem)] font-semibold leading-[0.9] tracking-[-0.055em]">
            Put the agent on your timeline.
          </h2>
          <p className="mt-6 max-w-xl text-[15px] leading-7 text-fg-secondary sm:text-[16px]">
            Download the desktop build, open something you&rsquo;re actually working on, and see
            how far a sentence gets you.
          </p>
          <div className="mt-9">
            <Button href="/download" size="lg">
              Download FramePilot
              <ArrowRight size={15} aria-hidden />
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
