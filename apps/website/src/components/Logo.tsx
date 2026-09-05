import Link from 'next/link';
import { site } from '@/lib/site';

/** The logo mark's fixed footprint. The navbar always reserves this box, even
 *  while the intro still owns the mark, so nothing shifts when it lands. */
export const LOGO_MARK_SIZE = 26;

export function LogoMark({ size = LOGO_MARK_SIZE, className = '' }: { size?: number; className?: string }) {
  return (
    <img
      src="/logo.png"
      alt=""
      aria-hidden
      width={size}
      height={size}
      className={`shrink-0 rounded-[6px] ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

export function Logo({ className = '' }: { className?: string }) {
  return (
    <Link
      href="/"
      className={`inline-flex items-center gap-2.5 text-fg ${className}`}
      aria-label={`${site.name} home`}
    >
      <span
        className="nav-logo-mark grid shrink-0 place-items-center"
        style={{ width: LOGO_MARK_SIZE, height: LOGO_MARK_SIZE }}
      >
        <LogoMark />
      </span>
      <span className="font-display text-[17px] font-semibold tracking-[-0.025em] text-current">
        {site.name}
      </span>
    </Link>
  );
}
