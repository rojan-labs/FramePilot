/**
 * Ambient module declaration for CSS side-effect imports (e.g. `Button.tsx`
 * importing `./tokens.css`). `packages/ui` deliberately has no `vite`/bundler
 * dependency of its own (it's a plain component package consumed by whichever
 * host bundles it), so this small local declaration stands in for the
 * `vite/client` types apps/web-editor already gets from its own `vite`
 * devDependency — no new dependency needed here.
 */
declare module '*.css';
