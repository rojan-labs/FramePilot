'use client';

import { useEffect, useRef, useState } from 'react';
import { AppMockup, type EditorStoryPhase } from './AppMockup';
import { InPoint, Ruler } from './timeline/Ruler';

const STEPS: ReadonlyArray<{ phase: EditorStoryPhase; label: string }> = [
  { phase: 'idle', label: 'Footage imported. Timeline untouched.' },
  { phase: 'prompt', label: 'Ask for what you want, in a sentence.' },
  { phase: 'working', label: 'The agent edits the real project.' },
  { phase: 'complete', label: "You're left with a timeline you can still edit." },
] as const;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function phaseForProgress(progress: number) {
  if (progress < 0.24) return 0;
  if (progress < 0.49) return 1;
  if (progress < 0.76) return 2;
  return 3;
}

export function ScrollEditorStory() {
  const sectionRef = useRef<HTMLElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const phaseRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const [phaseIndex, setPhaseIndex] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reduceMotion = media.matches;

    const applyPreference = (value: boolean) => {
      reduceMotion = value;
      setReducedMotion(value);
      if (value) {
        phaseRef.current = STEPS.length - 1;
        setPhaseIndex(STEPS.length - 1);
        if (editorRef.current) editorRef.current.style.transform = 'none';
      }
    };

    applyPreference(media.matches);
    const onPreferenceChange = (event: MediaQueryListEvent) => applyPreference(event.matches);
    media.addEventListener('change', onPreferenceChange);

    const update = () => {
      frameRef.current = null;
      if (reduceMotion) return;

      const section = sectionRef.current;
      if (!section) return;

      const rect = section.getBoundingClientRect();
      const range = Math.max(section.offsetHeight - window.innerHeight, 1);
      const progress = clamp(-rect.top / range, 0, 1);
      const nextPhase = phaseForProgress(progress);

      if (nextPhase !== phaseRef.current) {
        phaseRef.current = nextPhase;
        setPhaseIndex(nextPhase);
      }

      if (editorRef.current) {
        const settle = clamp(progress / 0.18, 0, 1);
        const scale = 0.975 + settle * 0.025;
        const translateY = (1 - settle) * 18;
        editorRef.current.style.transform = `translate3d(0, ${translateY}px, 0) scale(${scale})`;
      }
    };

    const requestUpdate = () => {
      if (frameRef.current != null) return;
      frameRef.current = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener('scroll', requestUpdate, { passive: true });
    window.addEventListener('resize', requestUpdate);

    return () => {
      media.removeEventListener('change', onPreferenceChange);
      window.removeEventListener('scroll', requestUpdate);
      window.removeEventListener('resize', requestUpdate);
      if (frameRef.current != null) window.cancelAnimationFrame(frameRef.current);
    };
  }, []);

  const active = STEPS[phaseIndex];

  return (
    <section
      ref={sectionRef}
      aria-label="FramePilot editor workflow"
      className={reducedMotion ? 'bg-canvas pb-20' : 'relative h-[300svh] bg-canvas md:h-[320svh]'}
    >
      <div
        className={
          reducedMotion
            ? 'container-x'
            : 'sticky top-[var(--nav-h)] flex min-h-[calc(100svh_-_var(--nav-h))] items-center py-5 sm:py-8'
        }
      >
        <div className={reducedMotion ? 'w-full' : 'container-x w-full'}>
          <div className="mx-auto max-w-[1180px]">
            <div className="mb-4 flex items-center gap-2.5">
              <InPoint />
              <span className="tc text-accent">00:01</span>
              <span className="tc">The product · one run, start to finish</span>
            </div>

            <div ref={editorRef} className="will-change-transform" style={{ transformOrigin: '50% 50%' }}>
              <div className="max-md:h-[540px]">
                <div className="max-md:w-[128.205%] max-md:origin-top-left max-md:scale-[0.78]">
                  <AppMockup phase={active.phase} />
                </div>
              </div>
            </div>

            <Ruler className="mt-4" />
            <div className="flex items-center gap-4 pt-2.5">
              <span className="tc tabular shrink-0 text-accent">{`00:0${phaseIndex + 1}`}</span>
              <p
                key={active.phase}
                className="animate-fade-up min-w-0 flex-1 truncate text-[12px] text-fg-secondary sm:text-[13px]"
              >
                {active.label}
              </p>
              {/* Four clips on a lane: how far through the run you have scrubbed. */}
              <span className="hidden w-[150px] shrink-0 items-center gap-1 sm:flex" aria-hidden>
                {STEPS.map((step, index) => (
                  <span
                    key={step.phase}
                    className={`h-[3px] flex-1 rounded-[1px] transition-colors duration-300 ${
                      index <= phaseIndex ? 'bg-accent' : 'bg-line'
                    }`}
                  />
                ))}
              </span>
              <span className="tc tabular shrink-0 text-fg-muted">0{phaseIndex + 1} / 04</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
