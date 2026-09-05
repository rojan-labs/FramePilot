import Link from 'next/link';
import { FOOTER_SECTIONS, site } from '@/lib/site';
import { LogoMark } from './Logo';
import { OutPoint } from './timeline/Ruler';

function isExternal(href: string) {
  return /^(https?:|mailto:)/.test(href);
}

/**
 * The out point. The ruler runs to the end of the page and stops against an
 * OUT marker; below it are the sitemap columns and the build year as timecode.
 */
export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="bg-app">
      <div className="container-x">
        <div className="flex items-center gap-3 pt-px">
          <div className="ruler grow" aria-hidden />
          <span className="flex shrink-0 items-center gap-2 pt-1">
            <OutPoint />
            <span className="tc text-accent">OUT</span>
          </span>
        </div>

        <div className="grid gap-10 py-12 lg:grid-cols-[1.5fr_repeat(3,minmax(0,1fr))] lg:py-14">
          <div className="max-w-xs">
            <Link href="/" className="inline-flex items-center gap-2.5 text-fg" aria-label={`${site.name} home`}>
              <LogoMark />
              <span className="font-display text-[16.5px] font-semibold tracking-[-0.025em]">{site.name}</span>
            </Link>
            <p className="mt-4 text-[13px] leading-6 text-fg-tertiary">
              A desktop video editor where the agent works on the same timeline you do.
            </p>
          </div>

          {FOOTER_SECTIONS.map((section) => (
            <nav key={section.title} aria-label={section.title}>
              <h2 className="tc text-fg-muted">{section.title}</h2>
              <ul className="mt-4 space-y-2.5">
                {section.links.map((link) => (
                  <li key={link.href}>
                    {isExternal(link.href) ? (
                      <a
                        href={link.href}
                        target={link.href.startsWith('mailto:') ? undefined : '_blank'}
                        rel="noopener noreferrer"
                        className="text-[13px] text-fg-secondary transition-colors hover:text-fg"
                      >
                        {link.label}
                      </a>
                    ) : (
                      <Link href={link.href} className="text-[13px] text-fg-secondary transition-colors hover:text-fg">
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="ruler ruler-flip" aria-hidden />
        <div className="flex flex-col gap-2 py-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="tc text-fg-muted">
            {`${year}:00:00:00`} · © {site.name}
          </p>
          <p className="tc text-fg-muted">Local-first · typed edits · validated export</p>
        </div>
      </div>
    </footer>
  );
}
