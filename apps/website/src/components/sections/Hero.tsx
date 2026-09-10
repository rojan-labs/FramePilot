import { ArrowDown } from 'lucide-react';
import { Button } from '@/components/Button';
import { DownloadButton } from '@/components/DownloadButton';
import { ScrollEditorStory } from '@/components/ScrollEditorStory';
import { InPoint } from '@/components/timeline/Ruler';

export function Hero() {
  return (
    <>
      <section className="bg-canvas pb-16 pt-14 sm:pb-24 sm:pt-20">
        <div className="container-x">
          {/* One centred column. The hero says one thing, so nothing sits beside it. */}
          <div className="mx-auto flex max-w-[880px] flex-col items-center text-center">
            <p className="flex items-center gap-2.5">
              <InPoint />
              <span className="tc text-accent">00:00</span>
              <span className="tc">In point · AI-native desktop editor</span>
            </p>

            <h1 className="mt-6 font-display text-[length:var(--text-h1)] leading-[var(--text-h1--line-height)] tracking-[var(--text-h1--letter-spacing)]">
              Your timeline.
              <br />
              With an agent.
            </h1>

            <p className="mt-7 max-w-[660px] text-pretty text-[16px] leading-7 text-fg-secondary sm:text-[18px] sm:leading-8">
              Cut it by hand when that&rsquo;s faster. Ask for it in a sentence when that&rsquo;s
              faster. Either way you get a timeline you can keep editing, not a file you have to
              accept.
            </p>

            <div className="mt-9 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
              <DownloadButton size="lg" />
              <Button href="/#editor-story" variant="ghost" size="lg">
                See it edit
                <ArrowDown size={14} aria-hidden />
              </Button>
            </div>
          </div>
        </div>
      </section>

      <div id="editor-story" className="scroll-mt-[var(--nav-h)]">
        <ScrollEditorStory />
      </div>
    </>
  );
}
