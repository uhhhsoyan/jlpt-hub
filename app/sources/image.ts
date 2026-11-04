import { existsSync } from "node:fs";
import path from "node:path";

const LOCAL_EXTS = ["jpg", "jpeg", "png", "webp"] as const;

/**
 * Where a source's picture comes from, in order: `image_url` (set in the Hub, pasted, or
 * uploaded to Blob); a file dropped into public/sources/<slug>.{jpg,jpeg,png,webp}; or null,
 * meaning render the typographic placeholder. Server-only (reads the filesystem); the
 * public/sources check runs per request so a new file shows up without a rebuild
 * (next.config.ts traces the folder into the /sources functions on Vercel).
 */
export function resolveSourceImage(slug: string, imageUrl: string | null): string | null {
  if (imageUrl) return imageUrl;
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  for (const ext of LOCAL_EXTS) {
    if (existsSync(path.join(process.cwd(), "public", "sources", `${slug}.${ext}`))) return `/sources/${slug}.${ext}`;
  }
  return null;
}
