import { Lock } from 'lucide-react';
import { Section, SectionHeading } from '@/components/Section';
import { ClipReveal } from '@/components/motion/ClipReveal';

/*
 * The difference, drawn rather than argued: a generator's output is one sealed
 * clip with nothing under it, and FramePilot's output is a sequence you can
 * still open. Two timelines side by side make the point faster than prose.
 */

type Clip = [start: number, span: number];

const PICTURE: Clip[] = [
  [0, 13],
  [15, 9],
  [26, 17],
  [45, 11],
  [58, 15],
  [75, 10],
  [87, 13],
];
const OVERLAY: Clip[] = [
  [6, 18],
  [30, 12],
  [58, 21],
];
const CAPTIONS: Clip[] = [
  [1, 8],
  [11, 6],
  [19, 9],
  [30, 7],
  [39, 10],
  [51, 6],
  [59, 9],
  [70, 7],
  [79, 11],
  [92, 7],
];
const AUDIO: Clip[] = [[0, 100]];

export function BeforeAfter() {
  return (
    <Section id="difference" tone="ink">
      <SectionHeading
        tc="00:03"
        eyebrow="The difference"
        tone="ink"
        title={
          <span className="text-white">
            Most AI video tools hand you a file. This one hands you the timeline.
          </span>
        }
        description="A finished MP4 is a dead end the moment someone asks for one more change. Here the cuts, captions, timing, and audio are all still sitting in the project where you can reach them."
      />

      <div className="mt-14 grid gap-10 lg:mt-16 lg:grid-cols-2 lg:gap-14">
        <ClipReveal wipe={false}>
          <Panel
            label="Black-box generator"
            headline="Prompt → final file"
            note="One sealed clip. The next change starts the whole thing over."
            muted
          >
            <Lane slot="V1" clips={[[0, 100]]} tone="dead" label="final.mp4" locked />
            <Lane slot="CC" clips={[]} tone="dead" empty="no caption data" />
            <Lane slot="A1" clips={[]} tone="dead" empty="no audio track" />
          </Panel>
        </ClipReveal>

        <ClipReveal wipe={false} from="right" delay={0.08}>
          <Panel
            label="FramePilot"
            headline="Prompt → operations → editable timeline"
            note="Every cut the agent made is a clip you can still trim, move, or undo."
          >
            <Lane slot="V2" clips={OVERLAY} tone="overlay" />
            <Lane slot="CC" clips={CAPTIONS} tone="caption" />
            <Lane slot="A1" clips={AUDIO} tone="audio" />
            <Lane slot="V1" clips={PICTURE} tone="picture" />
          </Panel>
        </ClipReveal>
      </div>
    </Section>
  );
}

function Panel({
  label,
  headline,
  note,
  muted = false,
  children,
}: {
  label: string;
  headline: string;
  note: string;
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className={`tc ${muted ? 'text-white/30' : 'text-accent'}`}>{label}</p>
      <p
        className={`mt-2.5 text-[16px] leading-6 sm:text-[17px] ${muted ? 'text-white/45' : 'text-white'}`}
      >
        {headline}
      </p>
      <div className="ruler ruler-ink mt-5" aria-hidden />
      <div className="mt-3 space-y-1.5">{children}</div>
      <p className="mt-4 text-[13px] leading-6 text-white/40">{note}</p>
    </div>
  );
}

const TONES = {
  dead: 'bg-white/[0.07] border border-dashed border-white/15',
  picture: 'bg-[#2a5c86] border border-[#3d7fb0]',
  overlay: 'bg-[#5b4a76] border border-[#7c66a0]',
  caption: 'bg-[#7a5720] border border-[#a8792a]',
  audio: 'bg-[#1a5666] border border-[#2b7f97]',
} as const;

function Lane({
  slot,
  clips,
  tone,
  label,
  locked = false,
  empty,
}: {
  slot: string;
  clips: Clip[];
  tone: keyof typeof TONES;
  label?: string;
  locked?: boolean;
  empty?: string;
}) {
  return (
    <div className="grid grid-cols-[26px_minmax(0,1fr)] items-center gap-2">
      <span className="tc text-white/25">{slot}</span>
      <div className="relative h-[26px] rounded-[2px] bg-white/[0.035]">
        {clips.map(([start, span]) => (
          <div
            key={`${slot}-${start}`}
            className={`absolute inset-y-[2px] flex items-center gap-1.5 overflow-hidden rounded-[2px] px-2 ${TONES[tone]}`}
            style={{ left: `${start}%`, width: `calc(${span}% - 2px)` }}
          >
            {locked && <Lock size={9} className="shrink-0 text-white/55" aria-hidden />}
            {label && <span className="tc truncate text-white/60">{label}</span>}
          </div>
        ))}
        {empty && (
          <span className="tc absolute inset-y-0 left-2.5 flex items-center text-white/18">
            {empty}
          </span>
        )}
      </div>
    </div>
  );
}
