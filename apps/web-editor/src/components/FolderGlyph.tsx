/**
 * FolderGlyph — a rich, filled, dimensional folder icon (master-prompt §3.2).
 *
 * The thin Lucide line folder reads as a placeholder; the bin wants a polished
 * macOS-style filled folder (tab + front face + subtle depth). Drawn with
 * `currentColor` in two opacities so a single `color` on the parent tints it
 * consistently to the app palette — no extra hues, no gradients.
 */
export interface FolderGlyphProps {
  readonly size?: number;
  /** True when the folder is expanded — nudges the tab for a subtle "open" feel. */
  readonly open?: boolean;
  readonly className?: string;
}

export function FolderGlyph({ size = 18, open = false, className }: FolderGlyphProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      {/* Back tab — the darker rear panel that peeks above the front face. */}
      <path
        d="M3 6.2a2 2 0 0 1 2-2h4.1a2 2 0 0 1 1.5.7l1.2 1.4H19a2 2 0 0 1 2 2v2H3z"
        fill="currentColor"
        opacity={0.55}
      />
      {/* Front face — the main body. */}
      <path
        d="M3 8.6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8.2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
        fill="currentColor"
        opacity={open ? 0.82 : 0.92}
      />
      {/* Top highlight — a 1px lighter lip for depth. */}
      <path d="M5 6.6h14a2 2 0 0 1 2 2v.4H3v-.4a2 2 0 0 1 2-2z" fill="#fff" opacity={0.16} />
    </svg>
  );
}
