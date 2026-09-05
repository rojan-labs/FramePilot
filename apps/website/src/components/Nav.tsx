'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';
import { NAV_LINKS, site } from '@/lib/site';
import { LOGO_MARK_SIZE, LogoMark } from './Logo';
import { Button } from './Button';

const FOCUSABLE =
  'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function Nav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const close = useCallback(() => setOpen(false), []);

  // The menu is a route-level overlay: leaving the route must close it.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        toggleRef.current?.focus();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;

      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || !panelRef.current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  return (
    <header className="sticky top-0 z-50 bg-canvas/92 backdrop-blur-xl">
      <nav
        className="container-x flex h-[var(--nav-h)] items-center justify-between gap-6"
        aria-label="Primary"
      >
        <Link
          href="/"
          className="inline-flex items-center gap-2.5 text-fg"
          aria-label={`${site.name} home`}
        >
          {/* Fixed reserved box: the mark can arrive late without moving anything. */}
          <span
            className="nav-logo-mark grid shrink-0 place-items-center"
            style={{ width: LOGO_MARK_SIZE, height: LOGO_MARK_SIZE }}
          >
            <LogoMark />
          </span>
          <span className="font-display text-[16.5px] font-semibold tracking-[-0.025em]">
            {site.name}
          </span>
        </Link>

        <ul className="hidden items-center gap-7 md:flex">
          {NAV_LINKS.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                className="tc text-fg-tertiary transition-colors hover:text-fg"
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>

        <div className="hidden md:block">
          <Button href="/download" size="sm">
            Download
          </Button>
        </div>

        <button
          ref={toggleRef}
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="grid size-9 place-items-center text-fg md:hidden"
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          aria-controls={panelId}
        >
          {open ? <X size={19} /> : <Menu size={19} />}
        </button>
      </nav>

      <div className="container-x">
        <div className="ruler" aria-hidden />
      </div>

      <div
        id={panelId}
        ref={panelRef}
        hidden={!open}
        className="fixed inset-x-0 bottom-0 top-[var(--nav-h)] z-40 bg-canvas px-5 py-6 md:hidden"
      >
        <ul>
          {NAV_LINKS.map((link, index) => (
            <li key={link.href}>
              <div className="ruler" aria-hidden />
              <Link
                href={link.href}
                onClick={close}
                className="flex items-baseline gap-3 py-4 text-[19px] font-medium tracking-[-0.025em] text-fg"
              >
                <span className="tc text-fg-muted">{`0${index + 1}`}</span>
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="ruler" aria-hidden />
        <Button href="/download" size="lg" className="mt-6 w-full" onClick={close}>
          Download FramePilot
        </Button>
      </div>
    </header>
  );
}
