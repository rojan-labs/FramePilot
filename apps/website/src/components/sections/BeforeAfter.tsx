import { ArrowRight } from 'lucide-react';

export function BeforeAfter() {
  return (
    <section className="bg-[#111214] py-20 text-white sm:py-28 lg:py-32">
      <div className="container-x">
        <div className="grid gap-12 lg:grid-cols-[1fr_0.8fr] lg:items-end lg:gap-20">
          <div className="max-w-4xl">
            <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-white/35">The difference</p>
            <h2 className="mt-5 font-display text-[clamp(2.8rem,6vw,6.2rem)] font-semibold leading-[0.9] tracking-[-0.055em] text-white">
              Most AI video tools hand you a file. This one hands you the timeline.
            </h2>
          </div>
          <p className="max-w-lg text-[15px] leading-7 text-white/50">
            A finished MP4 is a dead end the moment someone asks for one more change. Here the cuts, captions, timing, and audio are all still sitting in the project where you can reach them.
          </p>
        </div>

        <div className="mt-14 grid gap-6 border-t border-white/10 pt-7 sm:grid-cols-[1fr_auto_1fr] sm:items-center sm:gap-10">
          <div>
            <p className="font-mono text-[8.5px] uppercase tracking-[0.12em] text-white/30">Black-box generator</p>
            <p className="mt-2 text-[16px] text-white/65">Prompt → final file</p>
          </div>
          <ArrowRight size={17} className="hidden text-white/20 sm:block" aria-hidden />
          <div>
            <p className="font-mono text-[8.5px] uppercase tracking-[0.12em] text-[#ff8b54]">FramePilot</p>
            <p className="mt-2 text-[16px] text-white">Prompt → operations → editable timeline</p>
          </div>
        </div>
      </div>
    </section>
  );
}
