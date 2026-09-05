import { Plus } from 'lucide-react';
import { FAQ, type FaqItem } from '@/content/faq';
import { Section, SectionHeading } from '@/components/Section';
import { Ruler } from '@/components/timeline/Ruler';

export function Faq({ items = FAQ }: { items?: FaqItem[] }) {
  return (
    <Section id="faq" tone="shade">
      <div className="grid gap-12 lg:grid-cols-[0.72fr_1.28fr] lg:gap-20">
        <SectionHeading
          tc="00:05"
          eyebrow="FAQ"
          title="Before you install."
          className="max-w-md"
        />

        <div>
          {items.map((item, index) => (
            <details key={item.q} className="group">
              <Ruler />
              <summary className="flex cursor-pointer list-none items-start gap-4 py-5 text-left [&::-webkit-details-marker]:hidden">
                <span className="tc tabular mt-1 shrink-0 text-fg-muted">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="flex-1 text-[14px] font-medium leading-6 text-fg sm:text-[15px]">
                  {item.q}
                </span>
                <Plus
                  size={15}
                  className="mt-1 shrink-0 text-fg-muted transition-transform duration-200 group-open:rotate-45"
                  aria-hidden
                />
              </summary>
              <p className="max-w-2xl pb-6 pl-9 pr-8 text-[13.5px] leading-6 text-fg-secondary">
                {item.a}
              </p>
            </details>
          ))}
          <Ruler />
        </div>
      </div>
    </Section>
  );
}
