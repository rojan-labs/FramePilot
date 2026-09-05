import {
  AudioLines,
  Captions,
  ChevronDown,
  CircleCheck,
  Download,
  FolderOpen,
  History,
  Keyboard,
  MessageSquareText,
  PanelRight,
  Play,
  Scissors,
  Search,
  Settings2,
  Sparkles,
  Type,
  Undo2,
  Video,
  WandSparkles,
  type LucideIcon,
} from 'lucide-react';

export type EditorStoryPhase = 'idle' | 'prompt' | 'working' | 'complete';

interface AppMockupProps {
  phase?: EditorStoryPhase;
}

const ASSETS = [
  ['1167630-hd...', '0:58', 'linear-gradient(165deg,#98bed1 0 48%,#d8e2dd 49% 60%,#7a865b 61% 100%)'],
  ['12146464_21...', '0:06', 'linear-gradient(165deg,#79b2d5 0 50%,#dce7df 51% 62%,#6b855e 63% 100%)'],
  ['19041636-uhd...', '0:22', 'linear-gradient(165deg,#79b7cc 0 54%,#d2e0d6 55% 65%,#526f57 66% 100%)'],
  ['10348654-hd...', '0:20', 'linear-gradient(150deg,#ef8b36 0 30%,#a34c34 31% 48%,#e4b166 49% 67%,#516440 68% 100%)'],
  ['12237398-hd...', '0:16', 'linear-gradient(165deg,#8ebddc 0 48%,#e0e7e1 49% 61%,#74826e 62% 100%)'],
  ['12204622-hd...', '0:07', 'linear-gradient(165deg,#8fb7d2 0 48%,#dae1d8 49% 61%,#5b795f 62% 100%)'],
  ['14693976_21...', '0:07', 'linear-gradient(165deg,#9ac5de 0 52%,#e0e7e1 53% 64%,#71836c 65% 100%)'],
  ['12196646-hd...', '0:12', 'linear-gradient(165deg,#86b8d8 0 50%,#edf0e8 51% 66%,#84957c 67% 100%)'],
  ['14813807_144...', '0:12', 'linear-gradient(165deg,#9ec0d2 0 52%,#d7ded9 53% 66%,#718171 67% 100%)'],
  ['16385008_14...', '0:21', 'linear-gradient(165deg,#7fa4bf 0 45%,#cfdad5 46% 61%,#647d62 62% 100%)'],
  ['19041636-uhd...', '0:22', 'linear-gradient(165deg,#83b5ce 0 54%,#dce5df 55% 66%,#5d775f 67% 100%)'],
  ['cropped-sear...', '0:20', 'linear-gradient(180deg,#090a0d,#151920)'],
] as const;

const COMPLETE_ACTIVITY = [
  'Map available footage and rank strongest visual moments',
  'Detect scene cuts in available footage',
  'Analyze placed audio for beat grid and transients',
  'Detect pauses in the placed audio',
  'Add montage video track',
  'Add clips to the montage',
  'Add transitions around beat changes',
  'Add keyframes to selected shots',
  'Verify final sequence and audio fixes',
] as const;

export function AppMockup({ phase = 'complete' }: AppMockupProps) {
  const label = {
    idle: 'FramePilot editor with imported assets, a program preview, an existing timeline, and the AI panel ready for a request',
    prompt: 'FramePilot editor after the user asks the agent for a beat-synced vertical edit',
    working: 'FramePilot editor while the agent analyzes footage and changes the real timeline',
    complete: 'FramePilot editor after a completed agent run with an updated multitrack timeline and activity receipt',
  }[phase];

  return (
    <div
      role="img"
      aria-label={label}
      className="overflow-hidden rounded-[14px] border border-[#34363b] bg-[#08090b] text-[#efeff1] shadow-[0_24px_60px_-18px_rgba(23,20,15,0.32)]"
    >
      <div aria-hidden>
        <WindowBar />
        <ProjectBar />
        <div className="grid grid-cols-1 bg-[#090a0c] md:grid-cols-[34px_minmax(0,1fr)_250px] xl:grid-cols-[38px_minmax(0,1fr)_350px]">
          <ToolRail />
          <div className="min-w-0">
            <div className="grid xl:grid-cols-[270px_minmax(0,1fr)]">
              <AssetPanel />
              <ProgramMonitor />
            </div>
            <Timeline phase={phase} />
          </div>
          <AgentPanel phase={phase} />
        </div>
      </div>
    </div>
  );
}

function WindowBar() {
  return (
    <div className="relative flex h-7 items-center border-b border-black bg-[#383838] px-2.5">
      <div className="flex gap-1.5">
        <span className="size-2.5 rounded-full bg-[#ff5f57]" />
        <span className="size-2.5 rounded-full bg-[#febc2e]" />
        <span className="size-2.5 rounded-full bg-[#28c840]" />
      </div>
      <span className="absolute left-1/2 -translate-x-1/2 text-[8.5px] font-semibold text-white/60">FramePilot</span>
    </div>
  );
}

function ProjectBar() {
  return (
    <div className="flex h-11 items-center gap-3 border-b border-white/[0.07] bg-[#0a0b0d] px-2.5 sm:px-3">
      <span className="grid size-6 place-items-center rounded-md bg-[#17191e] text-[#ff7b35]"><Video size={12} /></span>
      <span className="text-[9px] font-medium text-white/70">scenery</span>
      <span className="size-1.5 rounded-full bg-[#45c46d]" />
      <div className="ml-auto hidden items-center gap-1.5 text-white/42 sm:flex">
        <span className="grid size-7 place-items-center rounded"><PanelRight size={12} /></span>
        <span className="grid size-7 place-items-center rounded"><History size={12} /></span>
        <span className="grid size-7 place-items-center rounded"><Keyboard size={12} /></span>
        <span className="grid size-7 place-items-center rounded"><Settings2 size={12} /></span>
        <span className="ml-1 rounded-md border border-white/10 bg-[#1a1b20] px-2.5 py-1.5 text-[8px] font-medium text-white/65">Send feedback</span>
        <span className="inline-flex items-center gap-1 rounded-md bg-[#2f7df6] px-2.5 py-1.5 text-[8px] font-semibold text-white"><Download size={10} /> Export</span>
      </div>
    </div>
  );
}

function ToolRail() {
  const tools = [FolderOpen, Sparkles, WandSparkles, Type, Captions] as const;
  return (
    <div className="hidden border-r border-white/[0.07] bg-[#0b0c0f] py-2 md:flex md:flex-col md:items-center">
      {tools.map((Icon, index) => (
        <span key={index} className={`mb-1 grid size-7 place-items-center rounded-md ${index === 0 ? 'bg-[#2f7df6] text-white' : 'text-white/38'}`}>
          <Icon size={12} />
        </span>
      ))}
      <span className="mt-auto grid size-7 place-items-center text-white/32"><Settings2 size={12} /></span>
    </div>
  );
}

function AssetPanel() {
  return (
    <div className="hidden border-r border-white/[0.07] bg-[#0d0e11] p-3 xl:block">
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-1.5"><span className="text-[10px] font-semibold text-white/82">Assets</span><span className="text-[8px] text-white/35">· 12</span></div>
        <span className="rounded border border-white/8 px-2 py-1 text-[7px] text-white/48">Import</span>
      </div>
      <div className="mt-2 flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-[#15161a] px-2 py-1.5 text-white/28"><Search size={9} /><span className="text-[7.5px]">Search media & transcript...</span></div>
      <div className="mt-2 flex items-center gap-1 text-[6.5px] text-white/36"><span className="rounded bg-white/[0.06] px-2 py-1 text-white/62">All</span><span className="px-1.5 py-1">Video</span><span className="px-1.5 py-1">Audio</span><span className="px-1.5 py-1">Images</span></div>
      <div className="mt-2 grid grid-cols-3 gap-1.5">
        {ASSETS.map(([name, duration, background], index) => (
          <div key={`${name}-${index}`} className="min-w-0">
            <div className="relative aspect-[1.35] overflow-hidden rounded border border-white/[0.07]" style={{ background }}>
              <span className="absolute left-1 top-1 size-1 rounded-full bg-[#2f7df6]" />
              <span className="absolute bottom-1 right-1 rounded bg-black/55 px-1 py-0.5 font-mono text-[5.5px] text-white/85">{duration}</span>
              {index === ASSETS.length - 1 && <AudioLines size={12} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-white/45" />}
            </div>
            <p className="mt-1 truncate text-[5.8px] text-white/36">{name}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProgramMonitor() {
  return (
    <div className="flex min-w-0 flex-col bg-black">
      <div className="flex h-8 items-center border-b border-white/[0.07] bg-[#0e0f12] px-3">
        <div className="flex items-center gap-1.5 text-[7px] text-white/42"><span>Source</span><span className="rounded bg-white/[0.06] px-2 py-1 text-white/70">Program</span></div>
        <div className="ml-auto flex items-center gap-2 font-mono text-[6px] text-white/30"><span className="rounded border border-white/[0.08] px-1.5 py-1">16:9</span><span>Fit</span></div>
      </div>
      <div className="relative flex min-h-[225px] flex-1 items-center justify-center overflow-hidden bg-black md:min-h-[300px] xl:min-h-[335px]">
        <div className="relative aspect-[9/16] h-[80%] max-h-[260px] overflow-hidden border border-white/[0.06] bg-[#9bc5d3] xl:max-h-[300px]">
          <div className="absolute inset-x-0 top-0 h-[57%] bg-[linear-gradient(180deg,#aad0dc_0%,#c6d9d6_74%,#899b79_75%,#61745d_100%)]" />
          <div className="absolute inset-x-0 bottom-0 h-[45%] bg-[linear-gradient(155deg,#7d8d69_0_24%,#c5b68f_25_38%,#806c4d_39_52%,#a8a17e_53_100%)]" />
          <div className="absolute bottom-[18%] left-[44%] h-[47%] w-[4%] rotate-[28deg] rounded-full bg-[#d9d0b2] opacity-80" />
          <div className="absolute left-[48%] top-[36%] h-[19%] w-px bg-white/45" />
        </div>
        <span className="absolute bottom-3 left-1/2 grid size-8 -translate-x-1/2 place-items-center rounded-full border border-white/10 bg-[#15161a] text-white/75"><Play size={11} fill="currentColor" /></span>
      </div>
      <div className="flex h-7 items-center border-t border-white/[0.07] bg-[#0e0f12] px-3">
        <span className="font-mono text-[7px] text-[#5ca3ff]">0.00s</span><span className="ml-2 font-mono text-[7px] text-white/35">/ 30.00s</span>
        <div className="ml-auto flex items-center gap-3 text-white/44"><span>◀</span><span>‹</span><Play size={9} /><span>›</span><span>▶</span></div>
      </div>
    </div>
  );
}

function AgentPanel({ phase }: { phase: EditorStoryPhase }) {
  return (
    <div className="flex min-h-[300px] flex-col border-t border-white/[0.07] bg-[#101115] md:border-l md:border-t-0">
      <div className="flex h-8 items-center border-b border-white/[0.07] px-3 text-[7.5px] text-white/40">
        <span className="inline-flex h-full items-center gap-1.5 border-b border-[#2f7df6] px-2 text-white/76"><Sparkles size={9} /> AI</span>
        <span className="ml-auto inline-flex items-center gap-1 px-2"><Settings2 size={9} /> Inspector</span>
      </div>
      <div className="flex h-8 items-center border-b border-white/[0.07] px-3">
        <span className="inline-flex items-center gap-1.5 text-[7.5px] font-medium text-white/72"><Sparkles size={9} /> Agent <ChevronDown size={8} /></span>
        <span className="ml-3 h-3.5 w-6 rounded-full bg-white/10 p-0.5"><span className="block size-2.5 rounded-full bg-white/35" /></span>
        <span className="ml-auto text-[10px] text-white/28">•••</span>
      </div>
      <div key={phase} className="animate-fade-up flex min-h-0 flex-1 flex-col">
        {phase === 'idle' && <IdleAgentState />}
        {phase === 'prompt' && <PromptAgentState />}
        {phase === 'working' && <WorkingAgentState />}
        {phase === 'complete' && <CompleteAgentState />}
      </div>
      <Composer />
    </div>
  );
}

function IdleAgentState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-5 text-center">
      <span className="grid size-9 place-items-center rounded-lg bg-[#17305d] text-[#63a1ff]"><Sparkles size={15} /></span>
      <p className="mt-3 text-[9px] font-semibold text-white/78">Edit your video with AI</p>
      <p className="mt-1 max-w-[205px] text-[6.8px] leading-[11px] text-white/34">Describe a change. FramePilot makes it on the timeline you&rsquo;re looking at, and you can undo it.</p>
      <div className="mt-4 w-full max-w-[225px] space-y-1.5 text-left">
        {['Remove the silent gaps', 'Add captions from the transcript', 'Punch in on the intro', 'Mute the music track'].map((item) => <div key={item} className="rounded border border-white/[0.07] bg-white/[0.035] px-2.5 py-1.5 text-[6.8px] text-white/48">{item}</div>)}
      </div>
    </div>
  );
}

function PromptAgentState() {
  return (
    <div className="flex-1 overflow-hidden p-3">
      <div className="rounded-lg border border-[#2f7df6]/20 bg-[#2f7df6]/8 p-2.5">
        <p className="flex items-center gap-1.5 font-mono text-[6px] uppercase tracking-[0.1em] text-[#76aafd]"><MessageSquareText size={8} /> Request</p>
        <p className="mt-1.5 text-[7px] leading-[11px] text-white/68">Create a 30-second beat-synced reel from the available footage. Use fast cuts, transitions, captions, and keep the final sequence ready for export.</p>
      </div>
      <div className="mt-3 flex items-center justify-between text-[6px] text-white/28"><span>Plan</span><span>2 / 10</span></div>
      <div className="mt-2 space-y-1.5">
        <ActivityRow label="Map available footage and timeline context" status="done" />
        <ActivityRow label="Analyze soundtrack for beat grid and drops" status="active" />
        <ActivityRow label="Detect scene cuts in source footage" status="idle" />
        <ActivityRow label="Build the first montage pass" status="idle" />
      </div>
    </div>
  );
}

function WorkingAgentState() {
  return (
    <div className="flex-1 overflow-hidden p-3">
      <div className="flex items-center justify-between text-[6px] text-white/28"><span>Plan</span><span>10 / 13</span></div>
      <div className="mt-2 rounded border border-[#2f7df6]/12 bg-[#2f7df6]/5 px-2 py-1.5 text-[6.3px] text-white/48">Recalling clip boundaries and beat changes...</div>
      <div className="mt-2 space-y-1.5">
        <ActivityRow label="Punching in on selected vertical shots" status="done" meta="instant" />
        <ActivityRow label="Added transitions around beat changes" status="done" />
        <ActivityRow label="Added keyframes to selected clips" status="done" />
        <ActivityRow label="Finding the strongest remaining cuts" status="active" />
        <ActivityRow label="Ripple-deleting a silent range" status="done" />
        <ActivityRow label="Generating captions from transcript" status="active" />
      </div>
    </div>
  );
}

function CompleteAgentState() {
  return (
    <div className="flex-1 overflow-hidden p-3">
      <div className="flex items-center justify-between text-[6px] text-white/28"><span>Activity</span><span>10 / 10</span></div>
      <div className="mt-2 rounded border border-[#55c47d]/12 bg-[#55c47d]/5 p-2">
        <p className="flex items-center gap-1.5 text-[6.5px] font-medium text-[#84d59f]"><CircleCheck size={8} /> Final sequence verified</p>
        <p className="mt-1 text-[5.8px] leading-[10px] text-white/36">Beat-synced cuts, captions, and audio are done, and all of it is still editable.</p>
      </div>
      <div className="mt-2 space-y-1">
        {COMPLETE_ACTIVITY.map((label) => <ActivityRow key={label} label={label} status="done" meta="instant" />)}
      </div>
      <div className="mt-2 flex items-center justify-between rounded border border-white/[0.07] bg-white/[0.025] px-2 py-1.5 text-[6px] text-white/42"><span>All checks passed</span><span className="inline-flex items-center gap-1 text-[#ff9462]"><Undo2 size={7} /> Undo run</span></div>
    </div>
  );
}

type ActivityStatus = 'done' | 'active' | 'idle';

function ActivityRow({ label, status, meta }: { label: string; status: ActivityStatus; meta?: string }) {
  const dot = status === 'done' ? 'bg-[#45c46d]' : status === 'active' ? 'border border-[#4d8ff6] border-t-transparent animate-spin' : 'bg-white/22';
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[5.9px] leading-[10px] text-white/46">
      <span className={`size-1.5 shrink-0 rounded-full ${dot}`} />
      <span className="truncate">{label}</span>
      {meta && <span className="ml-auto shrink-0 font-mono text-[5.2px] text-white/20">{meta}</span>}
    </div>
  );
}

function Composer() {
  return (
    <div className="border-t border-white/[0.07] p-2.5">
      <div className="flex flex-wrap gap-1">
        {['Current Timeline', 'Project: scenery', 'Transcript', 'Open Assets (12)'].map((chip) => <span key={chip} className="rounded-full border border-white/[0.08] bg-white/[0.025] px-1.5 py-1 text-[5.5px] text-white/35">{chip}</span>)}
      </div>
      <div className="mt-2 flex items-center rounded-lg border border-white/[0.08] bg-[#16171b] px-2 py-2 text-[6.4px] text-white/24"><span>Message FramePilot... / for commands</span><span className="ml-auto grid size-5 place-items-center rounded-full bg-white/[0.05] text-white/35">↗</span></div>
    </div>
  );
}

function Timeline({ phase }: { phase: EditorStoryPhase }) {
  const dense = phase === 'working' || phase === 'complete';
  const complete = phase === 'complete';
  const videoSegments: [number, number][] = dense
    ? [[1, 5], [7, 5], [13, 4], [18, 5], [24, 6], [31, 4], [36, 5], [42, 4], [47, 5], [53, 4], [58, 6], [65, 4], [70, 5], [76, 4], [81, 6], [88, 4], [93, 5]]
    : [[1, 18], [21, 17], [41, 20], [64, 14], [81, 17]];
  const captionSegments: [number, number][] = dense ? [[2, 6], [9, 5], [15, 7], [23, 5], [29, 6], [36, 5], [42, 6], [49, 5], [55, 7], [63, 5], [69, 6], [76, 5], [82, 6], [89, 8]] : [];
  const overlaySegments: [number, number][] = complete ? [[1, 37], [40, 56]] : dense ? [[1, 47], [50, 46]] : [[1, 96]];

  return (
    <div className="relative border-t border-white/[0.07] bg-[#08090b] px-2.5 pb-3 pt-2 sm:px-3.5">
      <div className="mb-2 flex items-center border-b border-white/[0.06] pb-2">
        <div className="flex items-center gap-2 text-[6px] text-white/30"><Scissors size={8} /> Timeline</div>
        <div className="ml-auto flex gap-4 font-mono text-[5.8px] text-white/22"><span>0.00s</span><span>5.00s</span><span>10.00s</span><span>15.00s</span><span>20.00s</span><span>25.00s</span><span>30.00s</span></div>
      </div>
      <div className="space-y-1">
        <Track label="V3" icon={Sparkles} tone="purple" segments={overlaySegments} />
        <Track label="CC" icon={Captions} tone="amber" segments={captionSegments} />
        <Track label="A1" icon={AudioLines} tone="audio" segments={[[1, 97]]} wave />
        <Track label="V1" icon={Video} tone="blue" segments={videoSegments} />
      </div>
      <div className="pointer-events-none absolute bottom-3 top-8 w-px bg-[#e2a623] shadow-[0_0_5px_rgba(226,166,35,.45)] transition-[left] duration-700" style={{ left: phase === 'idle' ? '18%' : phase === 'prompt' ? '28%' : phase === 'working' ? '46%' : '68%' }} />
    </div>
  );
}

type TrackTone = 'blue' | 'purple' | 'amber' | 'audio';

function Track({ label, icon: Icon, tone, segments, wave = false }: { label: string; icon: LucideIcon; tone: TrackTone; segments: [number, number][]; wave?: boolean }) {
  const tones: Record<TrackTone, [string, string]> = {
    blue: ['rgba(18,68,111,.82)', 'rgba(37,122,195,.9)'],
    purple: ['rgba(103,76,132,.66)', 'rgba(141,101,177,.78)'],
    amber: ['rgba(111,80,25,.9)', 'rgba(170,121,33,.9)'],
    audio: ['rgba(15,74,92,.86)', 'rgba(24,127,158,.86)'],
  };
  const [background, border] = tones[tone];

  return (
    <div className="grid grid-cols-[26px_1fr] items-center gap-1.5 sm:grid-cols-[34px_1fr]">
      <span className="font-mono text-[5.4px] text-white/24">{label}</span>
      <div className="relative h-[22px] rounded bg-white/[0.018]">
        {segments.map(([left, width], index) => (
          <div key={`${tone}-${index}`} className="absolute inset-y-0.5 flex items-center gap-1 overflow-hidden rounded px-1 transition-[left,width,opacity] duration-700" style={{ left: `${left}%`, width: `${width}%`, background, border: `1px solid ${border}` }}>
            <Icon size={6} className="shrink-0 text-white/55" />
            {wave && <svg viewBox="0 0 100 10" preserveAspectRatio="none" className="h-2 flex-1"><polyline points="0,5 4,2 8,8 12,3 16,7 20,1 24,8 28,4 32,6 36,2 40,8 44,3 48,7 52,2 56,8 60,4 64,6 68,1 72,8 76,3 80,7 84,2 88,8 92,4 96,6 100,5" fill="none" stroke="rgba(73,191,221,.78)" strokeWidth="1" /></svg>}
          </div>
        ))}
      </div>
    </div>
  );
}
