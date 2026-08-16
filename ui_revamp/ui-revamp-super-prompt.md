# UI/UX Revamp Super-Prompt — Notion-style Dark Design System (Video Editor)

> Paste this into your AI coding agent at the **repo root**. Let it complete **Phase 0 (audit)** and stop for your review before it touches any styling. Approve the audit, then let it proceed phase by phase.

---

## ROLE

You are a **senior product designer + frontend engineer** performing a **presentation-layer-only** redesign of an existing AI-powered video editor. This is a React desktop app (likely Electron + Vite — confirm during discovery). You produce calm, dense, professional dark UI in the spirit of **Notion's dark mode**, adapted to the density and information load of a pro creative tool (think Notion's restraint × Descript/Linear's polish × a real NLE's compactness).

Your output must be **beautiful, consistent, and accessible** — and it must change **nothing** about how the app behaves.

---

## ⛔ PRIME DIRECTIVE — DO NOT CHANGE FUNCTIONALITY

This is non-negotiable and overrides every other instruction. You are repainting the house, not rewiring it.

**You MUST NOT change:**

- Business logic, state management, data flow, or reducer/store behavior
- Component **props/APIs**, function signatures, return values, or exported symbols
- Event handler logic (only the element it's attached to may change, never what it does)
- API calls, IPC/Electron main-process code, file I/O, the FFmpeg/Remotion/render pipeline, or any AI feature wiring (prompts, model calls, timeline-spec/JSON contracts)
- Keyboard shortcut bindings and their behavior
- Routing, data fetching, persistence, or undo/redo behavior
- `data-testid`, `id`, `aria-*`, `name`, or `ref` attributes that code or tests depend on (preserve them; you may add new ones)

**You MAY change:**

- JSX **structure** purely for presentation (wrapping, layout containers, reordering visual elements)
- `className` / inline styles / CSS / Tailwind classes
- Which presentational component renders a thing (e.g., swap a raw `<button>` for `<Button>` — same `onClick`, same behavior)
- Add **new presentational** components, tokens, icons, and styles

**Rule of thumb:** if a "fix" requires touching logic, _wrap and restyle_ instead of rewriting. When in doubt, preserve and ask. After every surface you restyle, confirm behavior is unchanged (run the app / dev build; click through the flow).

---

## PHASE 0 — DISCOVERY & AUDIT (do this first, then STOP for review)

Before writing any styling code:

1. **Detect the stack:** framework (React confirmed?), bundler (Vite?), desktop shell (Electron?), styling approach in use (CSS modules / styled-components / Tailwind / plain CSS / inline), existing component lib (if any), icon source, and how theming is currently handled.
2. **Inventory every UI surface.** Produce a `UI_AUDIT.md` listing all screens, panels, dialogs, and reusable components, grouped by:
   - **App shell:** window chrome / titlebar, sidebars, panel layout, resize handles
   - **Editor surfaces:** preview/canvas, **timeline** (tracks, clips, playhead, ruler), transport controls, media/asset library, **inspector/properties panel**
   - **AI feature surfaces:** generation panels, prompt inputs, progress/streaming states, result previews
   - **System UI:** dialogs/modals, dropdowns, context menus, tooltips, toasts, forms, inputs, selects, badges, tabs, sliders, switches, empty states, loading states, export/render dialog
3. **Flag the worst offenders** (inconsistent spacing, raw unstyled inputs, ad-hoc dialogs, emoji-as-icons, hardcoded colors).
4. **Map shared components** so you restyle each primitive once and propagate everywhere.

Output the audit and a proposed phase plan. **Do not restyle anything yet — wait for approval.**

---

## PHASE 1 — DESIGN FOUNDATION (tokens before pixels)

Establish a single source of truth for design tokens (CSS variables on `:root` / `[data-theme="dark"]`, and mirror into the Tailwind theme if Tailwind is present). **Every** later style must reference tokens — no hardcoded hex, no magic numbers.

### Color — surfaces (layered dark, not pure black)

```css
--bg-app: #191919; /* Notion's base dark */
--bg-canvas: #0d0d0d; /* preview/void behind the video — near-black so footage pops */
--bg-panel: #1e1e1e; /* sidebars, timeline, inspector */
--bg-surface: #232323; /* cards, list rows, input wells */
--bg-elevated: #2a2a2a; /* dialogs, dropdowns, popovers, menus */
--bg-hover: rgba(255, 255, 255, 0.055);
--bg-active: rgba(255, 255, 255, 0.09);
--bg-selected: rgba(35, 131, 226, 0.16); /* accent-tinted selection */
```

### Color — borders & dividers (low-opacity white, very Notion)

```css
--border-subtle: rgba(255, 255, 255, 0.06);
--border-default: rgba(255, 255, 255, 0.094);
--border-strong: rgba(255, 255, 255, 0.16);
```

### Color — text (hierarchy via OPACITY, not different hues)

```css
--text-primary: rgba(255, 255, 255, 0.9);
--text-secondary: rgba(255, 255, 255, 0.64);
--text-tertiary: rgba(255, 255, 255, 0.45);
--text-disabled: rgba(255, 255, 255, 0.28);
```

### Color — accent (used SPARINGLY: primary actions, focus, active state)

```css
--accent: #2383e2; /* Notion blue */
--accent-hover: #3a93ec;
--accent-text: #ffffff;
--accent-subtle: rgba(35, 131, 226, 0.14);
--focus-ring: rgba(35, 131, 226, 0.55);
```

> Single accent only. If a brand accent exists, swap the hue but keep the same restrained usage.

### Color — semantic (muted/desaturated, Notion-soft)

```css
--success: #4dab6d;
--success-subtle: rgba(77, 171, 109, 0.14);
--warning: #d9a23b;
--warning-subtle: rgba(217, 162, 59, 0.14);
--danger: #eb5757;
--danger-subtle: rgba(235, 87, 87, 0.14);
--info: var(--accent);
```

### Color — video-editor specifics

```css
--playhead: #eb5757; /* conventional, high-contrast against tracks */
--clip-video: rgba(35, 131, 226, 0.22);
--clip-video-border: rgba(35, 131, 226, 0.5);
--clip-audio: rgba(77, 171, 109, 0.22);
--clip-audio-border: rgba(77, 171, 109, 0.5);
--clip-text: rgba(217, 162, 59, 0.22);
--clip-text-border: rgba(217, 162, 59, 0.5);
--clip-ai: rgba(160, 120, 235, 0.22);
--clip-ai-border: rgba(160, 120, 235, 0.5);
--track-lane: rgba(255, 255, 255, 0.02); /* subtle lane striping */
--ruler-tick: rgba(255, 255, 255, 0.2);
```

### Spacing (4px base scale)

`2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64`. Controls and dense panels lean on `4–8`; section padding `16–24`. Be consistent — no off-scale values.

### Radius (modest, Notion-like)

`--radius-sm: 4px` (inputs, small buttons) · `--radius-md: 6px` (cards, dropdowns) · `--radius-lg: 8px` (dialogs, panels) · `--radius-xl: 12px` (large surfaces). Avoid pill/heavily-rounded shapes except small badges/avatars.

### Typography

- Font: **Inter** (or the system UI stack) for UI; a mono token for timecodes/durations (`SF Mono`/`JetBrains Mono`).
- Scale (px): `11, 12, 13, 14, 16, 20, 24, 30`. **13px is the workhorse** for dense controls; 14px for primary content; 11–12px for metadata/labels.
- Weights: `400` body, `500` emphasis/labels, `600` headings. Avoid 700+.
- Line-height: ~1.4 body, ~1.2 for dense UI rows. Letter-spacing: slightly negative on large headings only.

### Elevation (subtle — panels use borders, only floating layers get shadow)

```css
--shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
--shadow-md: 0 0 0 1px rgba(0, 0, 0, 0.2), 0 4px 12px rgba(0, 0, 0, 0.35); /* dropdowns */
--shadow-lg: 0 0 0 1px rgba(0, 0, 0, 0.2), 0 12px 32px rgba(0, 0, 0, 0.45); /* dialogs */
```

### Motion (fast, calm, never bouncy)

- Hovers/state: `120ms ease`. Popovers/dropdowns: `150ms ease-out`. Dialogs: `180–200ms cubic-bezier(0.16,1,0.3,1)`.
- Animate `opacity` and `transform` only (timeline can hold hundreds of nodes — never animate layout/`box-shadow` in bulk).
- Respect `@media (prefers-reduced-motion: reduce)`.

### Z-index scale

`base 0 · sticky 100 · dropdown 1000 · overlay 1100 · modal 1200 · popover 1300 · toast 1400 · tooltip 1500`.

---

## PHASE 2 — PRIMITIVE COMPONENT LIBRARY (build once, reuse everywhere)

Create a small, consistent primitive set. **Strongly prefer headless/accessible primitives** (Radix UI, or shadcn/ui if Tailwind is present) for anything with focus management or layering — they give you focus traps, keyboard nav, and ARIA for free, which is exactly what "proper dialogs/forms" requires. Ask before adding a major dependency; if approved, wire your tokens into it so it looks bespoke, not default-shadcn.

Each primitive must implement **all relevant states**: `default · hover · active/pressed · focus-visible · disabled · loading`.

- **Button** — variants: `primary` (accent), `secondary` (surface + border), `ghost` (transparent, hover bg), `danger`, `icon`. Sizes: `sm/md`. Loading spinner replaces label, width preserved.
- **Input / Textarea** — `--bg-surface` well, `--border-default`, focus → accent ring; sizes; error state; prefix/suffix slots; clear affordance.
- **Select / Combobox** — token-styled menu, keyboard nav, check on selected.
- **Dialog / Modal** — centered, `--shadow-lg`, dimmed overlay (`rgba(0,0,0,0.5)`), focus trap, `Esc` to close, header/body/footer slots.
- **Dropdown menu & Context menu** — `--bg-elevated`, items with icon + label + optional shortcut hint, separators, danger items.
- **Popover** — for inline pickers (color, position, effects).
- **Tooltip** — `--bg-elevated`, 12px, ~400ms delay, used on every icon-only control.
- **Tabs** — underline or segmented; active uses `--text-primary` + accent indicator.
- **Badge / Tag / Pill** — semantic + neutral variants (status, media type, AI label); 11–12px, subtle bg + matching text.
- **Switch / Checkbox / Radio** — accent when on, smooth thumb transition.
- **Slider** — token track + accent fill + draggable thumb; for volume, opacity, scrub-adjacent controls.
- **Toast** — bottom-corner stack, semantic accent stripe, auto-dismiss + manual close, action slot.
- **Tooltip/Spinner/Progress** — determinate bar (renders/exports) + indeterminate spinner; accent fill.
- **Card / Panel / Section** — consistent padding, `--border-subtle`, optional header.
- **Empty state** — icon + title + one-line helper + primary action.
- **Skeleton** — shimmer for loading media/AI results.
- **Icon system** — **Lucide React** only. Stroke 1.5–2px. Sizes: 16px in dense UI, 18–20px in toolbars. Never use emoji as UI icons.

---

## PHASE 3 — VIDEO-EDITOR SURFACES (apply the language at the right density)

Restyle domain surfaces using the primitives and tokens. Editor UI is **denser** than Notion — keep generous breathing room in dialogs/panels, but tight, scannable rows in the timeline and lists.

- **App shell / layout** — clean panel grid (sidebar · preview · inspector · timeline). Token-styled, draggable resize handles (subtle, brighten on hover). If Electron custom titlebar exists, restyle it to match (`--bg-app`, draggable region, themed traffic-light spacing).
- **Preview / canvas** — `--bg-canvas` void, thin `--border-subtle` frame, floating bottom transport. Aspect-ratio letterboxing should look intentional.
- **Transport controls** — icon buttons (play/pause/seek/split), monospace **timecode** display, zoom control. Compact, centered, tooltip on every control.
- **Timeline** — token ruler with `--ruler-tick`, lane striping via `--track-lane`, track headers (name + mute/lock/visibility toggles), **clips** colored by media type (use the `--clip-*` tokens: subtle fill + brighter border, label + thumbnail), selected clip → accent border + glow, **playhead** as a crisp `--playhead` line with a grabbable head. Hover/drag/trim handles must be obvious. Keep it performant (no per-clip shadows/blur).
- **Media / asset library** — grid or list of cards: thumbnail, name, duration badge, type tag. Hover reveals quick actions. Skeletons while loading; empty state when bin is empty.
- **Inspector / properties panel** — grouped, labeled sections (Transform, Audio, Effects, AI…). Label-left / control-right rows, sliders + numeric inputs, collapsible groups. This is where Notion's calm hierarchy shines.
- **AI feature panels** — first-class prompt **Textarea**, model/option **Selects**, a clear primary **Generate** button, **streaming/progress** state (skeleton or token progress + status text), result preview with apply/discard actions, and graceful **error** state with retry. Tag AI-generated items with the `--clip-ai`/AI badge.
- **Export / render dialog** — settings form (format, resolution, fps, quality) using the form primitives, then a determinate **progress** view (percent + phase label + cancel). Never block the UI with an unstyled spinner.
- **(Optional, high-value) Command palette** — `Cmd/Ctrl-K` styled to match, if a command system already exists. Do **not** invent new commands — only restyle existing ones.

---

## PHASE 4 — STATES, POLISH & ACCESSIBILITY

- Every interactive element gets `hover`, `active`, **`focus-visible`** (accent ring), and `disabled` styling.
- Loading → skeletons/spinners; empty → empty states; error → inline message + retry. No dead-ends.
- **Custom scrollbars** (thin, `--border-strong` thumb, transparent track) — applied consistently.
- Drag feedback: clear drag ghosts and valid/invalid drop affordances on timeline and media bin.
- Keyboard: dialogs trap focus, `Esc` closes overlays, `Tab` order is logical, menus are arrow-key navigable. Maintain visible focus everywhere.
- Contrast: body text meets WCAG AA against its surface. Don't drop primary text below 0.85 opacity.
- Micro-interactions: fast, subtle entrance on dialogs/popovers/toasts; nothing bouncy or slow.

---

## "NOTION-LIKE" — WHAT IT ACTUALLY MEANS

- **Restraint.** Mostly grayscale; color is information, not decoration. One accent.
- **Hierarchy via opacity + weight + size**, not via many hues.
- **Subtle low-opacity white borders** instead of heavy lines or shadows for structure.
- **Generous-but-tight** spacing — airy where it counts (dialogs, inspector), compact where density matters (timeline, lists).
- **Soft, layered dark surfaces** (never pure `#000`, never pure `#fff` text).
- **Quiet motion**, modest radii, simple line icons.
- **Adaptation for a pro editor:** tighter row heights and 13px controls in the timeline/lists; keep the Notion calm in panels and dialogs.

---

## RULES OF ENGAGEMENT (how to work)

1. **Incremental.** One surface per change set; keep commits scoped and descriptive (`style(timeline): tokenize clips`). Never one giant rewrite.
2. **Tokens first, components second, screens third.** Don't restyle screens before primitives exist.
3. **Verify after each surface** — run the build, click the real flow, confirm behavior is identical. Note what you checked.
4. **Ask before** adding any major dependency, renaming files/exports, or restructuring logic-bearing components.
5. **Preserve hooks into the code:** keep existing `data-testid`/`id`/`ref`/`aria` and event-handler wiring intact.
6. **No new features, copy changes, or behavior tweaks** unless they're purely presentational.
7. **Dark mode only** unless a theme system already exists (then keep it working and theme via tokens).

---

## DEFINITION OF DONE

- [ ] Single tokenized design system; **zero hardcoded colors/spacing** in components.
- [ ] All listed primitives exist, each with full state coverage, used consistently across the app.
- [ ] Every dialog, dropdown, menu, tooltip, and form is token-styled, accessible, and keyboard-navigable.
- [ ] All editor surfaces (shell, preview, transport, timeline, library, inspector, AI panels, export) restyled.
- [ ] Loading / empty / error / focus / disabled states handled everywhere.
- [ ] Lucide icons throughout; **no emoji icons**; no raw unstyled `<input>`/`<button>`/`<dialog>` left.
- [ ] App builds and runs; **every original flow works identically** (manually verified).
- [ ] `UI_AUDIT.md` + a short `DESIGN_SYSTEM.md` documenting tokens and components.

---

## ANTI-PATTERNS — DO NOT

- ❌ Touch logic, props, handlers, IPC, render/AI pipeline, or shortcuts.
- ❌ Pure-black backgrounds or pure-white text.
- ❌ Neon/multi-accent color, heavy gradients, glassmorphism everywhere, or drop shadows on every element.
- ❌ Emoji as icons; mixed icon sets; inconsistent stroke widths.
- ❌ Off-scale spacing, random radii, or hardcoded hex in components.
- ❌ Big-bang rewrite that can't be reviewed surface-by-surface.
- ❌ Animating layout/`box-shadow` across many timeline nodes (kills perf).
- ❌ Renaming or deleting anything tests/code depend on.

**Start with PHASE 0. Produce the audit and phase plan, then stop and wait for my approval.**
