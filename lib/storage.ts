import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { del, put } from "@vercel/blob";

/**
 * Media storage abstraction used by server actions: uploads to Vercel Blob when a
 * read/write token is configured, otherwise falls back to writing under public/ (the
 * original local-only behavior). Blob writes survive a Vercel deploy (public/ does not —
 * that filesystem is read-only/ephemeral there); local writes are fine for `npm run dev`.
 */
export function blobEnabled(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

function assertSafePathname(pathname: string): void {
  if (pathname.startsWith("/") || pathname.split("/").includes("..")) {
    throw new Error(`Unsafe storage pathname: ${pathname}`);
  }
}

/**
 * Stores a file and returns the URL/path to persist in the DB: an absolute
 * `https://…` Blob URL when BLOB_READ_WRITE_TOKEN is set, or a leading-slash local path
 * (e.g. `/practice/<id>/page-1.jpg`) resolved against public/ otherwise.
 */
export async function storeFile(pathname: string, data: Buffer, contentType: string): Promise<string> {
  assertSafePathname(pathname);

  if (blobEnabled()) {
    const blob = await put(pathname, data, { access: "public", addRandomSuffix: false, contentType });
    return blob.url;
  }

  const dest = path.join(process.cwd(), "public", pathname);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, data);
  return `/${pathname}`;
}

/**
 * Best-effort cleanup of previously-stored files — never throws. Blob URLs (http/https)
 * are deleted via the Blob API in one batched call (only possible when blobEnabled; if
 * the token has since been removed, those are silently skipped — nothing else can delete
 * them). Local `/`-prefixed paths are unlinked under public/, ignoring missing files.
 */
export async function deleteStoredFiles(paths: string[]): Promise<void> {
  const blobUrls = paths.filter((p) => /^https?:\/\//i.test(p));
  const localPaths = paths.filter((p) => p.startsWith("/") && !p.includes(".."));

  if (blobUrls.length > 0 && blobEnabled()) {
    try {
      await del(blobUrls);
    } catch {
      // best-effort only
    }
  }

  for (const p of localPaths) {
    await unlink(path.join(process.cwd(), "public", p)).catch(() => {});
  }
}
