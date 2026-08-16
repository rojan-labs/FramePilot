import Link from 'next/link';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

const base =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium ' +
  'transition-[background,color,opacity,transform] duration-150 ' +
  'active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-3 ' +
  'disabled:pointer-events-none disabled:opacity-45 select-none';

const variants: Record<Variant, string> = {
  primary: 'rounded-lg bg-fg text-white hover:bg-[#2a2926]',
  secondary: 'rounded-lg bg-panel text-fg hover:bg-[#e8e7e2]',
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
type ButtonAsLink = CommonProps & { href: string; external?: boolean };

export function Button(props: ButtonAsButton | ButtonAsLink) {
  const { variant = 'primary', size = 'md', className = '', children } = props;
  const cls = `${base} ${variants[variant]} ${sizes[size]} ${className}`;

  if ('href' in props && props.href) {
    const { href, external } = props;
    const isExternal = external ?? /^(https?:|mailto:)/.test(href);

    if (isExternal) {
      return (
        <a
          href={href}
          className={cls}
          target={href.startsWith('mailto:') ? undefined : '_blank'}
          rel="noopener noreferrer"
        >
          {children}
        </a>
      );
    }

    return <Link href={href} className={cls}>{children}</Link>;
  }

  const { variant: _variant, size: _size, className: _className, children: _children, ...rest } = props as ButtonAsButton;
  return <button className={cls} {...rest}>{children}</button>;
}
