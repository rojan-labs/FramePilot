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
