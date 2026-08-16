# @framepilot/website

The FramePilot marketing site. A statically exported Next.js App Router application for the landing page, pricing and Freemius checkout, markdown blog, downloads, docs, changelog, and legal pages.

The website uses a deliberately minimal visual system. The actual FramePilot editor is the dense product artifact. The marketing shell around it should stay calm, spacious, typographic, and quiet enough that the product carries the page.

See **[docs/guides/website-and-licensing.md](../../docs/guides/website-and-licensing.md)** for setup, environment variables, and the license flow, and **ADR 0036** for the original website architecture rationale.

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

- **Minimal is the default.** Prefer typography, whitespace, alignment, and one subtle divider over cards, pills, gradients, shadows, nested containers, or decorative UI.
- Do not add a border because an element needs visual interest. Borders are for structure, controls, tables, code, or real editor chrome. Marketing sections should usually separate through whitespace or a single horizontal rule.
- Do not build card walls. If several ideas share equal importance, prefer a list, ledger, table-like row system, or editorial composition.
- Avoid rounded containers around whole sections. Rounded surfaces are acceptable for real controls and the FramePilot application window.
- Orange is a state/action signal. Use it sparingly for primary actions, active editing state, small labels, and timeline cues. Do not use large orange fills or decorative gradients.
- The product is the visual proof. Marketing editor mockups must mirror the current FramePilot desktop UI structure, density, terminology, timeline behavior, and agent states closely enough that a user recognizes the real application.
- The desktop editor geometry is important: tool rail at far left, assets/program workspace in the middle, AI/Inspector rail spanning the right side, and the timeline below the assets/program workspace rather than underneath the AI rail.
- The landing-page scroll demo owns the primary product story. Do not repeat the same prompt → operations → timeline demo in later sections.
- Interactive product demos must communicate real state progression: footage/project ready → user request → agent activity/plan → timeline mutation → completed, inspectable result.
- Scroll-driven motion must follow user progress, use `requestAnimationFrame` or an equivalent non-blocking path, avoid per-frame React state updates, and provide a useful `prefers-reduced-motion` fallback.
- Keep animation focused on product state and hierarchy. Do not animate ordinary marketing copy for decoration.
- Product claims must match the current README, architecture, and shipped behavior. Do not describe retired approval flows or future capabilities as shipped.
- Keep layouts useful from small laptops and mobile widths through large desktop displays. Product mockups must reflow intentionally rather than reserve width for hidden panels.
- Reading routes such as blog, docs, changelog, and legal pages should prioritize typography, rails, dividers, and navigation over marketing decoration.
- Every route should feel like the same product without reusing the homepage composition mechanically.
- All interactive controls require keyboard access, visible focus, intentional hover/active/disabled states, and reduced-motion support.
- Pricing remains driven by the typed pricing layer and Freemius integration. Do not hardcode a second pricing source of truth.
- Before merging a visual change, review the landing page plus pricing, download, blog index/article, docs index/article, changelog, legal pages, mobile navigation, footer, and 404 route for regressions and inconsistent legacy styling.

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
