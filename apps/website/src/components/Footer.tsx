import Link from 'next/link';
import { FOOTER_SECTIONS, site } from '@/lib/site';
import { Logo } from './Logo';

function isExternal(href: string) {
  return /^(https?:|mailto:)/.test(href);
}

export function Footer() {
  return (
    <footer className="border-t border-line bg-white">
      <div className="container-x py-10 sm:py-12">
        <div className="grid gap-10 lg:grid-cols-[1.5fr_repeat(3,minmax(0,1fr))]">
          <div className="max-w-xs">
            <Logo />
            <p className="mt-4 text-[12.5px] leading-5 text-fg-tertiary">
              A desktop video editor where the agent works on the same timeline you do.
            </p>
          </div>

          {FOOTER_SECTIONS.map((section) => (
            <nav key={section.title} aria-label={section.title}>
              <h3 className="font-mono text-[8.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
                {section.title}
              </h3>
              <ul className="mt-4 space-y-2.5">
                {section.links.map((link) => (
                  <li key={link.href}>
                    {isExternal(link.href) ? (
                      <a
                        href={link.href}
                        target={link.href.startsWith('mailto:') ? undefined : '_blank'}
                        rel="noopener noreferrer"
                        className="text-[12.5px] text-fg-secondary transition-colors hover:text-fg"
                      >
                        {link.label}
                      </a>
                    ) : (
                      <Link href={link.href} className="text-[12.5px] text-fg-secondary transition-colors hover:text-fg">
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-10 flex flex-col gap-2 border-t border-line pt-5 text-[11px] text-fg-muted sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} {site.name}.</p>
          <p>Local-first · typed edits · validated export</p>
        </div>
      </div>
    </footer>
  );
}
