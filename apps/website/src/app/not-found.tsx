import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/Button';
import { InPoint, Ruler } from '@/components/timeline/Ruler';

const IN_THE_BIN = ['a stale link', 'a renamed page', 'a cut that never made it'];

export default function NotFound() {
  return (
    <section className="container-x flex min-h-[68vh] items-center py-20">
      <div className="w-full max-w-3xl">
        <p className="flex items-center gap-2.5">
          <InPoint />
          <span className="tc text-accent">--:--</span>
          <span className="tc">404 · not on this timeline</span>
        </p>

        <h1 className="mt-6 font-display text-[clamp(3.2rem,7.4vw,6.6rem)] font-semibold leading-[0.9] tracking-[-0.055em]">
          This clip is off the timeline.
        </h1>

        <p className="mt-6 max-w-lg text-[16px] leading-7 text-fg-secondary">
          The page moved, got deleted, or never made the final cut. Whatever was here is in the
          bin now.
        </p>

        {/* The bin's contents, as a lane of struck-through clips. */}
        <div className="mt-9 max-w-lg">
          <Ruler />
          <ul className="lane mt-3 space-y-1.5 p-1.5">
            {IN_THE_BIN.map((item) => (
              <li
                key={item}
                className="flex items-center gap-2.5 rounded-[3px] border border-dashed border-line-strong px-3 py-2"
              >
                <span className="tc text-fg-muted">BIN</span>
                <span className="text-[13px] text-fg-tertiary line-through">{item}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-9">
          <Button href="/" size="lg">
            <ArrowLeft size={14} aria-hidden />
            Back to the start
          </Button>
        </div>
      </div>
    </section>
  );
}
