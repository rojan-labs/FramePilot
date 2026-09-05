'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';
import { motion } from 'framer-motion';
import { NAV_LINKS, site } from '@/lib/site';
import { LOGO_MARK_SIZE, LogoMark } from './Logo';
import { Button } from './Button';
import { useIntro } from './intro/IntroProvider';
import { INTRO_TIMING } from '@/lib/intro-machine';

const FOCUSABLE =
  'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function Nav() {
  const pathname = usePathname();
  const { state, isLanding, mounted } = useIntro();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const close = useCallback(() => setOpen(false), []);

  /* The intro owns the mark until it settles; then the navbar receives it. */
  const markHidden = isLanding && state !== 'settled';
  const handedOver = mounted && state === 'settled';

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
    /*
     * Solid paper, no backdrop-filter. A `backdrop-filter` makes its element
     * the containing block for `position: fixed` descendants, which collapsed
     * the mobile menu panel below to the header's own 64px height and left its
     * links painting straight onto the page with no panel behind them. The
     * design rules ban glassmorphism anyway, so the header is simply opaque.
     */
    <header className="sticky top-0 z-50 bg-canvas">
      <nav
        className="container-x flex h-[var(--nav-h)] items-center justify-between gap-6"
        aria-label="Primary"
      >
        <Link
          href="/"
          className="inline-flex items-center gap-2.5 text-fg"
          aria-label={`${site.name} home`}
        >
          {/*
            The slot is always rendered at a fixed size, so the mark can arrive
            late from the intro without moving a pixel of the navbar.

            Before hydration the inline head script and its CSS rule own the
            mark's visibility; after hydration this inline style does, which
            keeps the hand-off free of any ordering dependency between React
            and the attribute being removed. With JavaScript off neither
            applies and the mark is simply visible.
          */}
          <span
            className="nav-logo-mark grid shrink-0 place-items-center"
            style={{
              width: LOGO_MARK_SIZE,
              height: LOGO_MARK_SIZE,
              visibility: !mounted ? undefined : markHidden ? 'hidden' : 'visible',
            }}
          >
            {handedOver ? (
              <motion.span
                layoutId="fp-logo-mark"
                className="block overflow-hidden rounded-[6px]"
                style={{ width: LOGO_MARK_SIZE, height: LOGO_MARK_SIZE }}
                transition={{ duration: INTRO_TIMING.logoFlightMs / 1000, ease: [0.22, 1, 0.36, 1] }}
              >
                <LogoMark size={LOGO_MARK_SIZE} />
              </motion.span>
            ) : (
              <LogoMark />
            )}
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
        className="fixed inset-x-0 bottom-0 top-[var(--nav-h)] z-40 overflow-y-auto bg-canvas px-5 py-6 md:hidden"
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
