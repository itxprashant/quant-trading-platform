import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@qtp/shared"],
  reactStrictMode: true,
  experimental: {
    // Workspace root is the monorepo root.
    externalDir: true,
  },
};

export default nextConfig;
