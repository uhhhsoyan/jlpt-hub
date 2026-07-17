"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { getDb } from "@/lib/db";
import { clips } from "@/lib/db/schema";
import { mineVideo, MineError, type MinedSegment } from "@/lib/mine";
import { errChain, firstLine } from "@/app/workshop/db-error";

export type MineResponse =
  | { ok: true; videoId: string; title: string; url: string; segments: MinedSegment[] }
  | { ok: false; error: string };

export async function mine(url: string): Promise<MineResponse> {
  try {
    const r = await mineVideo(url.trim());
    return { ok: true, ...r };
  } catch (e) {
    if (e instanceof MineError) return { ok: false, error: e.message };
    return { ok: false, error: firstLine(errChain(e)) };
  }
}

export interface ClipToSave {
  japanese: string;
  audioUrl: string;
  startSec: number;
  endSec: number;
}
export type SaveResponse = { ok: true; count: number } | { ok: false; error: string };

export async function saveClips(
  sourceUrl: string,
  sourceLabel: string,
  items: ClipToSave[],
): Promise<SaveResponse> {
  const clean = items.filter((c) => c.japanese.trim().length > 0);
  if (clean.length === 0) return { ok: false, error: "No clips selected." };
  try {
    await getDb()
      .insert(clips)
      .values(
        clean.map((c) => ({
          japanese: c.japanese.trim(),
          audioUrl: c.audioUrl,
          sourceUrl: `${sourceUrl}&t=${Math.floor(c.startSec)}`,
          sourceLabel,
          startSec: c.startSec,
          endSec: c.endSec,
        })),
      );
    revalidatePath("/mine");
    return { ok: true, count: clean.length };
  } catch (e) {
    const s = errChain(e);
    if (/relation .* does not exist|does not exist|42P01/i.test(s)) {
      return { ok: false, error: "Table missing — run `npm run db:push`." };
    }
    if (/DATABASE_URL/i.test(s)) return { ok: false, error: "Set DATABASE_URL in .env.local." };
    return { ok: false, error: firstLine(s) };
  }
}

export async function removeClip(id: string, audioUrl: string): Promise<void> {
  try {
    await getDb().delete(clips).where(eq(clips.id, id));
    revalidatePath("/mine");
    // Best-effort: also remove the on-disk clip (audioUrl is like /mined/<id>/clip.mp3).
    if (audioUrl.startsWith("/mined/")) {
      await unlink(path.join(process.cwd(), "public", audioUrl)).catch(() => {});
    }
  } catch {
    /* leave the row if delete fails */
  }
}
