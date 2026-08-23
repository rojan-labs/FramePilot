import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/Button';

export default function NotFound() {
  return (
    <section className="container-x flex min-h-[68vh] items-center py-20">
      <div className="max-w-3xl">
        <p className="eyebrow-tc mb-5">404</p>
        <h1 className="font-display text-[clamp(3.6rem,8vw,7rem)] font-semibold leading-[0.9] tracking-[-0.06em]">
          This scene got cut.
        </h1>
        <p className="mt-5 max-w-lg text-[16px] leading-7 text-fg-secondary">
          This page moved, got deleted, or never made the final cut.
        </p>
        <div className="mt-7">
          <Button href="/" size="lg">
            <ArrowLeft size={14} />
            Back to FramePilot
          </Button>
        </div>
      </div>
    </section>
  );
}
