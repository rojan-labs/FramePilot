import { ArrowDown } from 'lucide-react';
import { Button } from '@/components/Button';
import { DownloadButton } from '@/components/DownloadButton';
import { ScrollEditorStory } from '@/components/ScrollEditorStory';
import { IntroTrack } from '@/components/intro/IntroTrack';

export function Hero() {
  return (
    <>
      <section className="bg-canvas pb-14 pt-20 sm:pb-20 sm:pt-28 lg:pt-32">
        <div className="container-x">
          <IntroTrack />
          <div className="mt-10 max-w-[1050px]">
            <p className="tc mb-7">AI-native desktop video editor</p>
            <h1 className="font-display text-[length:var(--text-h1)] leading-[var(--text-h1--line-height)] tracking-[var(--text-h1--letter-spacing)]">
              Your timeline.
              <br />
              With an agent.
            </h1>
            <p className="mt-7 max-w-[650px] text-[16px] leading-7 text-fg-secondary sm:text-[18px] sm:leading-8">
              Cut it by hand when that&rsquo;s faster. Ask for it in a sentence when that&rsquo;s faster. Either way you get a timeline you can keep editing, not a file you have to accept.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
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
