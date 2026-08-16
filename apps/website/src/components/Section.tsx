import type { ReactNode } from 'react';

export function Section({
  id,
  children,
  className = '',
}: {
  id?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`scroll-mt-24 py-20 sm:py-28 lg:py-32 ${className}`}>
      <div className="container-x">{children}</div>
    </section>
  );
}

export function SectionHeading({
  eyebrow,
  scene,
  title,
  description,
  align = 'left',
}: {
  eyebrow?: string;
  scene?: string;
  title: string;
  description?: string;
  align?: 'center' | 'left';
}) {
  const centered = align === 'center';

  return (
    <div className={`${centered ? 'mx-auto max-w-3xl text-center' : 'max-w-3xl'} mb-12 sm:mb-16`}>
      {eyebrow && (
        <p className={`eyebrow-tc mb-5 ${centered ? 'mx-auto' : ''}`}>
          {scene && <span className="text-accent">{scene}</span>}
          {eyebrow}
        </p>
      )}
      <h2 className="text-[length:var(--text-h2)] leading-[var(--text-h2--line-height)] tracking-[var(--text-h2--letter-spacing)]">
        {title}
      </h2>
      {description && (
        <p className={`mt-5 max-w-2xl text-[15px] leading-7 text-fg-secondary sm:text-[16px] ${centered ? 'mx-auto' : ''}`}>
          {description}
        </p>
      )}
    </div>
  );
}
