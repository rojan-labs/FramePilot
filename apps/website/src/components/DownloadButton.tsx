'use client';

import { useEffect, useState } from 'react';
import { Apple, Download, Monitor } from 'lucide-react';
import { site } from '@/lib/site';
import { Button } from './Button';

type OS = 'mac' | 'windows' | 'linux' | 'other';

function detectOS(): OS {
  if (typeof navigator === 'undefined') return 'other';
  const p = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (p.includes('mac')) return 'mac';
  if (p.includes('win')) return 'windows';
  if (p.includes('linux') || p.includes('x11')) return 'linux';
  return 'other';
}

const LABELS: Record<OS, string> = {
  mac: 'Download for macOS',
  windows: 'Download for Windows',
  linux: 'Download for Linux',
  other: 'Download FramePilot',
};

/** Primary download CTA that adapts its label/icon to the visitor's OS and
 *  resolves to the latest GitHub Release. */
export function DownloadButton({
  size = 'lg',
  variant = 'primary',
  className = '',
}: {
  size?: 'sm' | 'md' | 'lg';
  variant?: 'primary' | 'secondary';
  className?: string;
}) {
  const [os, setOs] = useState<OS>('other');
  useEffect(() => setOs(detectOS()), []);
  const Icon = os === 'mac' ? Apple : os === 'other' ? Download : Monitor;

  return (
    <Button href={site.releasesUrl} external size={size} variant={variant} className={className}>
      <Icon size={size === 'lg' ? 18 : 16} />
      {LABELS[os]}
    </Button>
  );
}
