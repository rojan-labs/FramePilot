# @framepilot/website

The FramePilot marketing site. A statically exported Next.js App Router application for the landing page, pricing and Freemius checkout, markdown blog, downloads, docs, changelog, and legal pages.

The site is built on one idea: **it behaves like a timeline**. Editing vocabulary — cut, ripple, in and out points, playhead, bin, tracks, timecode — is the visual and copy metaphor, so the marketing shell argues for the product by being made of the same material. See **ADR 0172** for the direction and the intro, **ADR 0054** for the orange brand, **ADR 0036** for the original architecture, and **[docs/guides/website-and-licensing.md](../../docs/guides/website-and-licensing.md)** for setup, environment variables, and the license flow.

## Commands

```bash
pnpm --filter @framepilot/website dev
pnpm --filter @framepilot/website build
pnpm --filter @framepilot/website generate:og
pnpm --filter @framepilot/website fetch:pricing
pnpm --filter @framepilot/website test
pnpm --filter @framepilot/website lint
pnpm --filter @framepilot/website typecheck
```

The development server uses port `4321`. The production build is statically exported to `./out`.

## Structure

```text
src/app/          App Router routes and global marketing design system
src/components/   Shared navigation, footer, product artifacts, pricing, downloads, sections
src/content/      Product capability and FAQ copy kept aligned with current repository behavior
src/lib/          Site config, SEO, pricing, Freemius checkout, blog and markdown utilities
content/blog/     Frontmatter-driven Markdown posts
scripts/          OG/icon generation and live pricing refresh
public/           Generated OG assets, icons, manifest, and public brand assets
```

## Design rules

### The material

- **Paper, ink, one orange.** Warm paper canvas, warm-black ink, and the `#f26522` family as the single action and state colour. A primary button is the same signal as a playhead. Tokens live in one place, the `@theme` block in `src/app/globals.css`.
- **Bricolage Grotesque for display, Geist for text, Geist Mono for timecode.** Mono is reserved for labels that behave like timecode, track slots, and small metadata — never for body copy.
- **Rulers, not borders.** Horizontal divisions are pieces of a timeline ruler: a hairline with tick marks (`.ruler`), punctuated by in and out point wedges. Reach for `Ruler`, `InPoint`, `OutPoint`, `Timecode`, and `Eyebrow` in `src/components/timeline/Ruler.tsx` before writing a `border-b`.
- **Section eyebrows are timecode.** `▸ 00:02 · THE PRODUCT`, running in order down the landing page. The footer is the out point; the 404 is the bin.
- **Lanes and clips carry meaning.** When several things share importance, put them on tracks as clips whose position, length, and colour say something true about them — never in a wall of cards.

### What not to do

- No gradients as decoration, no glassmorphism, no card walls, no rounded containers around whole sections, no generic centred SaaS hero.
- Rounded surfaces are for real controls and the application window only.
- Do not add a border because an element needs visual interest. Structure, controls, tables, code, and editor chrome earn borders; marketing sections separate with whitespace or a ruler.
- No large orange fills or orange used decoratively.

### Motion

- **Sections enter like clips snapping to a track**: a short horizontal translate plus a clip-path wipe, via `ClipReveal` / `ClipTrack` / `ClipRow` in `src/components/motion/`. `whileInView` with `once: true`.
- Do not animate ordinary marketing copy for decoration. Motion is for structure and product state.
- Every animated component honours `useReducedMotion` by rendering the final state with the same DOM shape, so there is no hydration difference.
- framer-motion serialises its `initial` styles into the export, so anything revealed on scroll carries `data-clip-reveal` and the root layout's `<noscript>` rule forces it visible without JavaScript.
- Scroll-driven motion follows user progress, uses `requestAnimationFrame` or equivalent, avoids per-frame React state, and has a real reduced-motion fallback.

### The landing intro

- The intro is a ripple delete of the other editors, ending with FramePilot promoted to the navbar logo. Its **states** are a pure reducer in `src/lib/intro-machine.ts` with unit tests; its **timers, listeners, and measurement** are in `src/components/intro/`. Change the choreography's clock in `INTRO_TIMING`, not in scattered literals.
- The navbar always reserves a fixed box for the logo mark and mounts the `layoutId` target only once the intro settles: never zero logos, never two, never a layout shift.
- The stage renders only on the client. The hero's headline and download CTA are the page's real first paint and stay usable throughout.
- Competitor tiles are drawn stand-ins — a coloured tile, two-letter shorthand, and the tool's printed name. The repository has no licence to ship those marks (ADR 0172).
- The intro plays once per session, skips on any scroll, key, pointer press, or resize, and settles immediately under reduced motion. Every `sessionStorage` access is wrapped: unavailable storage means the intro replays, never that the page fails.

### Content and structure

- **The landing-page scroll demo owns the primary product story.** Do not repeat the same prompt → operations → timeline demo in later sections.
- The product is the visual proof. Marketing editor mockups must mirror the current FramePilot desktop UI structure, density, terminology, timeline behaviour, and agent states closely enough that a user recognises the real application.
- The desktop editor geometry is important: tool rail at far left, assets/program workspace in the middle, AI/Inspector rail spanning the right side, and the timeline below the assets/program workspace rather than underneath the AI rail.
- Interactive product demos must communicate real state progression: footage/project ready → user request → agent activity/plan → timeline mutation → completed, inspectable result.
- Product claims must match the current README, architecture, and shipped behaviour, and must come from `src/content/*.ts`, `src/lib/site.ts`, the FAQ, `content/docs/*.mdx`, or the repository README. Copy may be rewritten freely in voice and structure, never in facts. No invented metrics, testimonials, or customer logos.
- Pricing remains driven by the typed pricing layer and Freemius integration. Do not hardcode a second pricing source of truth.
- Reading routes such as blog, docs, changelog, and legal should prioritise typography, rails, dividers, and navigation over marketing decoration.
- Every route should feel like the same product without reusing the homepage composition mechanically.
- Keep layouts useful from mobile widths through large desktop displays. Product mockups must reflow intentionally rather than reserve width for hidden panels.
- All interactive controls require keyboard access, visible focus, intentional hover/active/disabled states, and reduced-motion support.
- **Delete what you replace.** No parallel old and new components.
- Before merging a visual change, review the landing page plus pricing, download, blog index/article, docs index/article, changelog, legal pages, mobile navigation, footer, and 404 route for regressions and inconsistent legacy styling.

### Route furniture

- Every route outside the landing page opens on `PageHeader`: an in-point wedge, the route's timecode, and its name. Do not hand-roll a page header.
- `pageMetadata` returns an **absolute** title. The root layout carries a `%s · FramePilot` template, so a non-absolute title ending in the brand name gets it appended twice.
- The Open Graph card is generated by `scripts/generate-og.ts` and must stay on the same material as the pages: paper, ink, one orange, in point, ruler. Regenerate and commit `public/og.png` whenever the brand or that direction changes.

## Adding a blog post

Create `content/blog/<slug>.mdx` with frontmatter:

```md
---
title: '…'
description: '…'
date: '2026-07-01'
author: 'Your Name'
tags: ['editing']
keywords: ['…']
---

Markdown body…
```

The post is picked up by `/blog`, the sitemap, and the RSS feed.

## Verification

Before merging website changes, run at minimum:

```bash
pnpm --filter @framepilot/website typecheck
pnpm --filter @framepilot/website lint
pnpm --filter @framepilot/website test
pnpm --filter @framepilot/website build
```

Use the repository-level verification and CI gates when the change is part of a pull request.
