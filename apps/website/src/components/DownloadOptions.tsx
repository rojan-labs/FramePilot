'use client';

import { useEffect, useState } from 'react';
import { Apple, ArrowDownToLine, Monitor, Terminal, type LucideIcon } from 'lucide-react';
import { site } from '@/lib/site';

type OS = 'mac' | 'windows' | 'linux' | 'other';

function detectOS(): OS {
  if (typeof navigator === 'undefined') return 'other';
  const platform = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (platform.includes('mac')) return 'mac';
  if (platform.includes('win')) return 'windows';
  if (platform.includes('linux') || platform.includes('x11')) return 'linux';
  return 'other';
}

const PLATFORMS = [
  { id: 'mac', name: 'macOS', icon: Apple, note: 'Apple Silicon & Intel', file: '.dmg' },
  { id: 'windows', name: 'Windows', icon: Monitor, note: 'Windows 10 & 11 · x64', file: '.exe' },
  { id: 'linux', name: 'Linux', icon: Terminal, note: 'AppImage · x64', file: '.AppImage' },
] as const;

export function DownloadOptions() {
  const [os, setOs] = useState<OS>('other');
  useEffect(() => setOs(detectOS()), []);

  return (
    <div className="border-t border-line">
      {PLATFORMS.map((platform) => (
        <PlatformRow
          key={platform.id}
          name={platform.name}
          icon={platform.icon}
          note={platform.note}
          file={platform.file}
          recommended={platform.id === os}
        />
      ))}
    </div>
  );
}

function PlatformRow({
  name,
  icon: Icon,
  note,
  file,
  recommended,
}: {
  name: string;
  icon: LucideIcon;
  note: string;
  file: string;
  recommended: boolean;
}) {
  return (
    <a
      href={site.releasesUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="group grid gap-4 border-b border-line py-6 sm:grid-cols-[42px_180px_minmax(0,1fr)_auto] sm:items-center sm:gap-6"
    >
      <Icon size={19} className="text-fg" aria-hidden />
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-[15px] font-medium text-fg">{name}</h2>
          {recommended && <span className="font-mono text-[8px] uppercase tracking-[0.12em] text-accent">Your OS</span>}
        </div>
        <p className="mt-1 text-[11.5px] text-fg-tertiary">{note}</p>
      </div>
      <p className="text-[12px] text-fg-muted">Latest pre-release build</p>
      <span className="inline-flex items-center gap-2 text-[12.5px] font-medium text-fg">
        Download {file}
        <ArrowDownToLine size={14} className="transition-transform group-hover:translate-y-0.5" aria-hidden />
      </span>
    </a>
  );
}
