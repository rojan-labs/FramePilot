import { ArrowDown } from 'lucide-react';
import { Button } from '@/components/Button';
import { DownloadButton } from '@/components/DownloadButton';
import { ScrollEditorStory } from '@/components/ScrollEditorStory';
import { IntroTrack } from '@/components/intro/IntroTrack';
import { InPoint, Ruler } from '@/components/timeline/Ruler';
import { MAKES } from '@/content/features';

const LEDGER = [
  ['Runs on', 'macOS · Windows · Linux'],
  ['Your footage', 'Stays on your machine'],
  ['Outside agents', 'MCP, same guardrails'],
] as const;

export function Hero() {
  return (
    <>
      <section className="bg-canvas pb-14 pt-10 sm:pb-18 sm:pt-14">
        <div className="container-x">
          {/* The intro plays here, then leaves this line behind as the ruler. */}
          <IntroTrack />

          <div className="mt-9 grid gap-12 lg:mt-12 lg:grid-cols-[minmax(0,1fr)_260px] lg:gap-16">
            <div>
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

              <p className="mt-7 max-w-[620px] text-[16px] leading-7 text-fg-secondary sm:text-[18px] sm:leading-8">
                Cut it by hand when that&rsquo;s faster. Ask for it in a sentence when
                that&rsquo;s faster. Either way you get a timeline you can keep editing, not a
                file you have to accept.
              </p>

              <div className="mt-9 flex flex-col gap-3 sm:flex-row">
                <DownloadButton size="lg" />
                <Button href="/#editor-story" variant="ghost" size="lg">
                  See it edit
                  <ArrowDown size={14} aria-hidden />
                </Button>
              </div>
            </div>

            {/* A ledger, not a feature card: three facts, set like a slate. */}
            <aside className="lg:pb-2">
              <dl>
                {LEDGER.map(([term, value]) => (
                  <div key={term}>
                    <Ruler />
                    <div className="pb-4 pt-2.5">
                      <dt className="tc text-fg-muted">{term}</dt>
                      <dd className="mt-1.5 text-[13.5px] leading-5 text-fg">{value}</dd>
                    </div>
                  </div>
                ))}
              </dl>
              <Ruler />
              <div className="pb-1 pt-2.5">
                <p className="tc text-fg-muted">Built for</p>
                <p className="mt-1.5 text-[13.5px] leading-6 text-fg-secondary">
                  {MAKES.join(' · ')}
                </p>
              </div>
            </aside>
          </div>
        </div>
      </section>

      <div id="editor-story" className="scroll-mt-[var(--nav-h)]">
        <ScrollEditorStory />
      </div>
    </>
  );
}
