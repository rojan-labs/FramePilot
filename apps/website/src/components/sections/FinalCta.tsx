import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/Button';

export function FinalCta() {
  return (
    <section className="bg-canvas py-20 sm:py-28 lg:py-32">
      <div className="container-x">
        <div className="max-w-4xl">
          <p className="eyebrow-tc mb-5">FramePilot · pre-release</p>
          <h2 className="font-display text-[clamp(3rem,7vw,7rem)] font-semibold leading-[0.9] tracking-[-0.06em]">
            Put the agent on your timeline.
          </h2>
          <p className="mt-6 max-w-xl text-[15px] leading-7 text-fg-secondary sm:text-[16px]">
            Download the desktop build, open something you&rsquo;re actually working on, and see how far a sentence gets you.
          </p>
          <div className="mt-8">
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
