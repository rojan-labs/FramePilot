import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo';
import { site } from '@/lib/site';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = pageMetadata({
  title: 'Terms of Service',
  path: '/legal/terms',
  description: 'The terms that govern your use of FramePilot.',
});

export default function TermsPage() {
  return (
    <article className="container-x max-w-[820px] py-14 sm:py-20">
      <PageHeader
        tc="LGL 00:02"
        eyebrow="Legal"
        size="md"
        title="Terms of Service"
        meta={<span className="tc tabular text-fg-muted">Updated {new Date().getFullYear()}</span>}
      />

      <div className="prose-fp mt-9">
        <p>These terms govern your use of FramePilot (the &ldquo;Software&rdquo;) and this website. By purchasing, downloading, or using FramePilot, you agree to them.</p>

        <h2>License</h2>
        <p>FramePilot is a paid application. A valid license key grants you a non-exclusive, non-transferable right to install and use the Software on the number of devices permitted by your plan. You may move a license between your own machines by deactivating and re-activating it. You may not resell, sublicense, or share your license key.</p>

        <h2>Payments &amp; refunds</h2>
        <p>Payments are processed by <strong>Freemius</strong>, our merchant of record. If a subscription applies, it renews automatically until cancelled. If FramePilot isn&rsquo;t the right fit, contact us within <strong>14 days</strong> of purchase for a full refund.</p>

        <h2>Acceptable use</h2>
        <p>You are responsible for the content you create and for holding the rights to any media you edit. Do not use FramePilot to produce unlawful content or to infringe others&rsquo; rights.</p>

        <h2>Warranty &amp; liability</h2>
        <p>The Software is provided &ldquo;as is&rdquo; without warranties of any kind. To the maximum extent permitted by law, we are not liable for any indirect or consequential damages arising from your use of the Software. Always keep backups of your source media and project files.</p>

        <h2>Changes</h2>
        <p>We may update these terms as the product evolves. Material changes will be reflected on this page with an updated date.</p>

        <h2>Contact</h2>
        <p>Questions? Email <a href={`mailto:${site.email}`}>{site.email}</a>.</p>
      </div>
    </article>
  );
}
