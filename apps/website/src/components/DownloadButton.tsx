'use client';

import { useEffect, useState } from 'react';
import { Apple, Download, Monitor } from 'lucide-react';
import { site } from '@/lib/site';
import { detectCurrentPlatform, type DesktopPlatform } from '@/lib/platform';
import { Button } from './Button';

const LABELS: Record<DesktopPlatform, string> = {
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
  const [os, setOs] = useState<DesktopPlatform>('other');
  useEffect(() => setOs(detectCurrentPlatform()), []);
  const Icon = os === 'mac' ? Apple : os === 'other' ? Download : Monitor;

  return (
    <Button href={site.releasesUrl} external size={size} variant={variant} className={className}>
      <Icon size={size === 'lg' ? 18 : 16} />
      {LABELS[os]}
    </Button>
  );
}
