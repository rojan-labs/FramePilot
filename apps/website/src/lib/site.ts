/**
 * Single source of truth for brand and site constants. Product claims in this
 * file must stay aligned with the repository README and current shipped state.
 */

export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://framepilot.app').replace(/\/$/, '');

export const GITHUB_REPO = 'rjach/FramePilot';
export const GITHUB_URL = `https://github.com/${GITHUB_REPO}`;

export const site = {
  name: 'FramePilot',
  tagline: 'Your timeline, with an agent.',
  description:
    'FramePilot is a desktop video editor with an AI agent that edits your actual timeline instead of handing back a finished file. Cut by hand or describe the change you want, see exactly what moved, undo any run, and export through a render engine that checks its own output.',
  url: SITE_URL,
  ogImage: `${SITE_URL}/og.png`,
  locale: 'en_US',
  twitter: '@framepilot',
  author: 'Rojan Acharya',
  authorUrl: 'https://rojanacharya.com',
  email: 'hello@framepilot.app',
  github: GITHUB_URL,
  githubRepo: GITHUB_REPO,
  discord: 'https://discord.gg/framepilot',
  x: 'https://x.com/framepilot',
  releasesUrl: `${GITHUB_URL}/releases/latest`,
} as const;

export const NAV_LINKS = [
  { label: 'Product', href: '/#features' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Docs', href: '/docs' },
  { label: 'Blog', href: '/blog' },
] as const;

export const FOOTER_SECTIONS = [
  {
    title: 'Product',
    links: [
      { label: 'Product', href: '/#features' },
      { label: 'Pricing', href: '/pricing' },
      { label: 'Download', href: '/download' },
      { label: 'Changelog', href: '/changelog' },
    ],
  },
  {
    title: 'Learn',
    links: [
      { label: 'Blog', href: '/blog' },
      { label: 'Docs', href: '/docs' },
      { label: 'Get started', href: '/docs/getting-started' },
      { label: 'Agent workflow', href: '/#editor-story' },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'GitHub', href: GITHUB_URL },
      { label: 'Contact', href: 'mailto:hello@framepilot.app' },
      { label: 'Privacy', href: '/legal/privacy' },
      { label: 'Terms', href: '/legal/terms' },
    ],
  },
] as const;
