import Link from 'next/link';
import { site } from '@/lib/site';

export function LogoMark({ size = 24 }: { size?: number }) {
  return (
    <img
      src="/logo.png"
      alt=""
      aria-hidden
      width={size}
      height={size}
      className="shrink-0 rounded-[7px]"
      style={{ width: size, height: size }}
    />
  );
}

export function Logo({ className = '' }: { className?: string }) {
  return (
    <Link
      href="/"
      className={`group inline-flex items-center gap-2.5 text-fg ${className}`}
      aria-label={`${site.name} home`}
    >
      <LogoMark />
      <span className="font-display text-[17px] font-semibold tracking-tight text-current">
        {site.name}
      </span>
    </Link>
  );
}
