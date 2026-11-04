import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // /sources checks public/sources/<slug>.{jpg,png,webp} at request time (app/sources/image.ts);
  // make sure those files travel with the serverless function, not just the CDN.
  outputFileTracingIncludes: {
    "/sources": ["./public/sources/**/*"],
    "/sources/*": ["./public/sources/**/*"],
  },
};

export default nextConfig;
