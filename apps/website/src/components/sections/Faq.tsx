import { ChevronDown } from 'lucide-react';
import { FAQ, type FaqItem } from '@/content/faq';
import { Section } from '@/components/Section';

export function Faq({ items = FAQ }: { items?: FaqItem[] }) {
  return (
    <Section id="faq" className="bg-[#f7f7f5]">
      <div className="grid gap-12 lg:grid-cols-[0.7fr_1.3fr] lg:gap-20">
        <div className="max-w-md">
          <p className="eyebrow-tc mb-5">FAQ</p>
          <h2 className="text-[length:var(--text-h2)] leading-[var(--text-h2--line-height)] tracking-[var(--text-h2--letter-spacing)]">
            Before you install.
          </h2>
        </div>

        <div className="border-t border-line">
          {items.map((item) => (
            <details key={item.q} className="group border-b border-line">
              <summary className="flex cursor-pointer list-none items-start gap-4 py-5 text-left [&::-webkit-details-marker]:hidden sm:py-6">
                <span className="flex-1 text-[14px] font-medium leading-6 text-fg sm:text-[15px]">{item.q}</span>
                <ChevronDown size={15} className="mt-1 shrink-0 text-fg-muted transition-transform group-open:rotate-180" aria-hidden />
              </summary>
              <p className="max-w-2xl pb-6 pr-8 text-[13.5px] leading-6 text-fg-secondary">{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </Section>
  );
}
