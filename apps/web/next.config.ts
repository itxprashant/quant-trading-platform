import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@qtp/shared"],
  reactStrictMode: true,
  // Hide the Next.js dev badge. The site is public through the tunnel.
  devIndicators: false,
  // pnpm dev is served publicly through the Cloudflare tunnel.
  allowedDevOrigins: ["quantstorm-2026.site"],
  experimental: {
    // Workspace root is the monorepo root.
    externalDir: true,
  },
};

export default nextConfig;
