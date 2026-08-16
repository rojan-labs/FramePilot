'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Menu, X } from 'lucide-react';
import { NAV_LINKS } from '@/lib/site';
import { Logo } from './Logo';
import { Button } from './Button';

export function Nav() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  return (
    <header className="sticky top-0 z-50 h-[var(--nav-h)] border-b border-line-subtle bg-white/92 backdrop-blur-xl">
      <nav className="container-x flex h-full items-center justify-between gap-6" aria-label="Primary">
        <Logo />

        <ul className="hidden items-center gap-7 md:flex">
          {NAV_LINKS.map((link) => (
            <li key={link.href}>
              <Link href={link.href} className="text-[12.5px] text-fg-secondary transition-colors hover:text-fg">
                {link.label}
              </Link>
            </li>
          ))}
        </ul>

        <div className="hidden md:block">
          <Button href="/download" size="sm">Download</Button>
        </div>

        <button
          onClick={() => setOpen((value) => !value)}
          className="grid size-9 place-items-center text-fg md:hidden"
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
        >
          {open ? <X size={19} /> : <Menu size={19} />}
        </button>
      </nav>

      {open && (
        <div className="fixed inset-x-0 bottom-0 top-[var(--nav-h)] bg-white px-5 py-6 md:hidden">
          <ul className="border-t border-line">
            {NAV_LINKS.map((link) => (
              <li key={link.href} className="border-b border-line">
                <Link
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="block py-4 text-[18px] font-medium tracking-[-0.02em] text-fg"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
          <Button href="/download" size="lg" className="mt-6 w-full">Download FramePilot</Button>
        </div>
      )}
    </header>
  );
}
