import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Files read from disk at request time must travel with the serverless function on Vercel.
  outputFileTracingIncludes: {
    // /sources checks public/sources/<slug>.{jpg,png,webp} at request time (app/sources/image.ts),
    // not just through the CDN.
    // The journal (/) shows the same covers as thumbnails.
    "/": ["./public/sources/**/*"],
    "/sources": ["./public/sources/**/*"],
    "/sources/*": ["./public/sources/**/*"],
    // The MCP get_instructions tool serves this file (lib/served-instructions.ts, INSTRUCTIONS_DOC_PATH).
    // Turbopack's static trace finds it today too; this keeps it in the bundle if the read path
    // ever stops being statically analysable.
    "/mcp": ["./docs/claude-ai-project-instructions.md"],
  },
};

export default nextConfig;
