import Link from 'next/link';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

/**
 * Controls are the one place the site is allowed to be a rounded surface, and
 * orange is the action colour — a primary button is the same signal as the
 * playhead.
 */
const base =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium ' +
  'transition-[background,color,border-color,opacity,transform] duration-150 ' +
  'active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-3 ' +
  'disabled:pointer-events-none disabled:opacity-45 select-none';

const variants: Record<Variant, string> = {
  primary: 'rounded-md bg-accent text-accent-ink hover:bg-accent-hover',
  secondary: 'rounded-md border border-line-strong bg-transparent text-fg hover:border-fg hover:bg-panel/60',
  ghost: 'rounded-md text-fg-secondary hover:text-fg',
};

const sizes: Record<Size, string> = {
  sm: 'h-9 px-3.5 text-[13px]',
  md: 'h-10 px-4 text-[13.5px]',
  lg: 'h-11 px-5 text-[14px]',
};

interface CommonProps {
  variant?: Variant;
  size?: Size;
  className?: string;
  children: ReactNode;
}

type ButtonAsButton = CommonProps & ComponentPropsWithoutRef<'button'> & { href?: undefined };
type ButtonAsLink = CommonProps & { href: string; external?: boolean; onClick?: () => void };

export function Button(props: ButtonAsButton | ButtonAsLink) {
  const { variant = 'primary', size = 'md', className = '', children } = props;
  const cls = `${base} ${variants[variant]} ${sizes[size]} ${className}`;

  if ('href' in props && props.href) {
    const { href, external, onClick } = props;
    const isExternal = external ?? /^(https?:|mailto:)/.test(href);

    if (isExternal) {
      return (
        <a
          href={href}
          className={cls}
          onClick={onClick}
          target={href.startsWith('mailto:') ? undefined : '_blank'}
          rel="noopener noreferrer"
        >
          {children}
        </a>
      );
    }

    return <Link href={href} className={cls} onClick={onClick}>{children}</Link>;
  }

  const { variant: _variant, size: _size, className: _className, children: _children, ...rest } = props as ButtonAsButton;
  return <button className={cls} {...rest}>{children}</button>;
}
