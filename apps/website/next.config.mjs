/**
 * FramePilot marketing site — statically exported Next.js App Router app.
 *
 * WHY `output: 'export'`: the site is 100% content/marketing with no server
 * runtime; a static export deploys anywhere (GitHub Pages, S3, Vercel static)
 * and keeps the attack surface at zero. All dynamic bits (OG images, sitemap,
 * RSS) are generated at build time.
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  reactStrictMode: true,
  // Static export cannot use the Next Image Optimization server.
  images: { unoptimized: true },
  // Emit `/pricing/index.html` etc. so any static host serves clean URLs.
  trailingSlash: true,
  eslint: {
    // Linting runs as its own `pnpm lint` step (flat config); don't double-run in build.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
