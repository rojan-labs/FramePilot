'use client';

import { useEffect, useState } from 'react';
import { Apple, ArrowDownToLine, Monitor, Terminal, type LucideIcon } from 'lucide-react';
import { site } from '@/lib/site';
import { detectCurrentPlatform, type DesktopPlatform } from '@/lib/platform';
import { Ruler } from './timeline/Ruler';

const PLATFORMS = [
  { id: 'mac', name: 'macOS', icon: Apple, note: 'Apple Silicon & Intel', file: '.dmg', slot: 'M1' },
  { id: 'windows', name: 'Windows', icon: Monitor, note: 'Windows 10 & 11 · x64', file: '.exe', slot: 'W1' },
  { id: 'linux', name: 'Linux', icon: Terminal, note: 'AppImage · x64', file: '.AppImage', slot: 'L1' },
] as const;

/**
 * Each platform is a clip on its own track. The visitor's own platform is the
 * one the playhead is parked on — and phones and tablets match nothing here,
 * because there is no build for them.
 */
export function DownloadOptions() {
  const [os, setOs] = useState<DesktopPlatform>('other');
  useEffect(() => setOs(detectCurrentPlatform()), []);

  return (
    <div className="space-y-5">
      {PLATFORMS.map((platform) => (
        <PlatformTrack key={platform.id} {...platform} recommended={platform.id === os} />
      ))}
    </div>
  );
}

function PlatformTrack({
  name,
  icon: Icon,
  note,
  file,
  slot,
  recommended,
}: {
  name: string;
  icon: LucideIcon;
  note: string;
  file: string;
  slot: string;
  recommended: boolean;
}) {
  return (
    <div>
      <Ruler />
      <div className="lane mt-2.5 p-1.5">
        <a
          href={site.releasesUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={`group grid gap-3 rounded-[3px] px-4 py-4 transition-colors sm:grid-cols-[22px_190px_minmax(0,1fr)_auto] sm:items-center sm:gap-6 ${
            recommended
              ? 'bg-accent/10 ring-1 ring-inset ring-accent/35 hover:bg-accent/15'
              : 'hover:bg-panel/70'
          }`}
        >
          <Icon size={18} className="text-fg" aria-hidden />
          <div>
            <div className="flex items-center gap-2.5">
              <span className="tc text-fg-muted">{slot}</span>
              <h2 className="text-[15px] font-medium text-fg">{name}</h2>
              {recommended && <span className="tc text-accent">Your OS</span>}
            </div>
            <p className="mt-1 text-[11.5px] text-fg-tertiary">{note}</p>
          </div>
          <p className="text-[12px] text-fg-muted">Latest pre-release build</p>
          <span className="inline-flex items-center gap-2 text-[12.5px] font-medium text-fg">
            Download {file}
            <ArrowDownToLine
              size={14}
              className="transition-transform group-hover:translate-y-0.5"
              aria-hidden
            />
          </span>
        </a>
      </div>
    </div>
  );
}
