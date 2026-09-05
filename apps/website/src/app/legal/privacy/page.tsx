import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo';
import { site } from '@/lib/site';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = pageMetadata({
  title: 'Privacy Policy',
  path: '/legal/privacy',
  description: 'How FramePilot handles your data. Short version: your media stays on your machine.',
});

export default function PrivacyPage() {
  return (
    <article className="container-x max-w-[820px] py-14 sm:py-20">
      <PageHeader
        tc="LGL 00:01"
        eyebrow="Legal"
        size="md"
        title="Privacy Policy"
        meta={<span className="tc tabular text-fg-muted">Updated {new Date().getFullYear()}</span>}
      />

      <div className="prose-fp mt-9">
        <p>
          FramePilot is a local-first desktop application. Your creative work belongs to you and
          stays on your machine.
        </p>

        <h2>Your media &amp; projects</h2>
        <p>
          Video, audio, images, and project files you edit in FramePilot are stored and processed{' '}
          <strong>locally on your device</strong>. We do not upload, collect, or have access to your
          media or project contents.
        </p>

        <h2>AI features</h2>
        <p>
          AI-assisted editing uses an AI provider of your choice with your own API key. When you
          invoke an AI action, the relevant timeline context is sent to that provider under their
          terms. You can also run FramePilot fully offline with the built-in deterministic mock.
          FramePilot never sends your media to an AI provider without your action.
        </p>

        <h2>Music search</h2>
        <p>
          If you search for background music, only the words you type are sent to the music provider
          (
          <a href="https://openverse.org" target="_blank" rel="noopener noreferrer">
            Openverse
          </a>
          ) — no account, no identifier, and nothing from your project. Tracks you add are
          downloaded to your device and become ordinary project files, so the project keeps working
          offline. Your media is never sent anywhere as part of this.
        </p>

        <h2>Stock photos &amp; video</h2>
        <p>
          If you search for stock media, only the words you type are sent to{' '}
          <a href="https://www.pexels.com" target="_blank" rel="noopener noreferrer">
            Pexels
          </a>
          , using an API key you supply — nothing from your project, and no identifier we add.
          Files you add are downloaded to your device and become ordinary project files, so the
          project keeps working offline. Your own media is never sent anywhere as part of this.
        </p>

        <h2>Licensing &amp; payments</h2>
        <p>
          Purchases and license management are handled by our merchant of record,{' '}
          <a href="https://freemius.com" target="_blank" rel="noopener noreferrer">
            Freemius
          </a>
          , which processes your payment and contact details under its own privacy policy. To
          activate a license, FramePilot sends your license key and an anonymous device identifier
          to Freemius to verify validity. We do not receive your payment card details.
        </p>

        <h2>Website analytics</h2>
        <p>
          This website may use privacy-respecting, cookieless analytics to understand aggregate
          traffic. We do not sell personal data or use invasive third-party ad tracking.
        </p>

        <h2>Contact</h2>
        <p>
          Questions about privacy? Email <a href={`mailto:${site.email}`}>{site.email}</a>.
        </p>
      </div>
    </article>
  );
}
