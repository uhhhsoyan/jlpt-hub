// Shared helper for scripts that upload local public/ files to Vercel Blob.
import { put } from "@vercel/blob";
import { readFile } from "node:fs/promises";

export function blobEnabled() {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

export async function uploadLocalFile(localPath, pathname, contentType) {
  const data = await readFile(localPath);
  const blob = await put(pathname, data, { access: "public", addRandomSuffix: false, contentType });
  return blob.url;
}
