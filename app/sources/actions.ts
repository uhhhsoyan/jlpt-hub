"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { studySources } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { deleteStoredFiles, storeFile } from "@/lib/storage";
import { isHexColor, parseAliases, slugify, SOURCE_COLORS } from "@/lib/study-sources";
import { createStudySource, updateStudySource, type StudySourceFields } from "@/lib/study-sources-db";
import { STUDY_SOURCE_KINDS, type StudySourceKind } from "@/lib/types";
import { errChain, firstLine } from "@/app/workshop/db-error";

export type SourceActionResult = { ok: true; slug: string } | { ok: false; error: string };

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function str(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

function optional(formData: FormData, name: string): string | null {
  return str(formData, name) || null;
}

function isKind(v: string): v is StudySourceKind {
  return (STUDY_SOURCE_KINDS as readonly string[]).includes(v);
}

/** Everything but the image, validated. Returns an error string for the form when a field is off. */
function readFields(formData: FormData): { ok: true; fields: StudySourceFields } | { ok: false; error: string } {
  const name = str(formData, "name");
  if (!name) return { ok: false, error: "Give the source a name." };
  const kind = str(formData, "kind");
  if (!isKind(kind)) return { ok: false, error: "Pick a kind." };
  const url = optional(formData, "url");
  if (url && !/^https?:\/\//i.test(url)) return { ok: false, error: "The URL should start with http:// or https://." };
  const colorRaw = str(formData, "color");
  const color = colorRaw ? (isHexColor(colorRaw) ? colorRaw.toLowerCase() : null) : null;
  if (colorRaw && !color) return { ok: false, error: "Colour should be a hex value like #4f46e5." };
  return {
    ok: true,
    fields: {
      name,
      nameJa: optional(formData, "nameJa"),
      kind,
      level: optional(formData, "level"),
      edition: optional(formData, "edition"),
      url,
      color: color ?? SOURCE_COLORS[Math.floor(Math.random() * SOURCE_COLORS.length)],
      aliases: parseAliases(str(formData, "aliases")),
      description: optional(formData, "description"),
      howUsed: optional(formData, "howUsed"),
    },
  };
}

function humanize(e: unknown): string {
  const msg = errChain(e);
  if (/DATABASE_URL/i.test(msg)) return "Database not configured — set DATABASE_URL in .env.local.";
  if (/relation .* does not exist|does not exist|42P01|undefined_table/i.test(msg)) {
    return "The study_sources table doesn't exist yet — run `npm run db:push`.";
  }
  if (/duplicate key|23505|unique/i.test(msg)) return "That slug is already taken — change the name.";
  return firstLine(msg);
}

function revalidateSources(slug: string): void {
  revalidatePath("/sources");
  revalidatePath(`/sources/${slug}`);
  revalidatePath(`/sources/${slug}/edit`);
  revalidatePath("/practice"); // the new-session form lists active sources
}

/**
 * Add a catalog entry from the Hub. The slug is derived from the name (ASCII, hyphenated);
 * an all-Japanese name falls back to a short random id. Slugs are permanent — the MCP
 * tools and URLs use them — so a collision is reported rather than suffixed silently.
 */
export async function createSource(formData: FormData): Promise<SourceActionResult> {
  const parsed = readFields(formData);
  if (!parsed.ok) return parsed;
  const slug = slugify(parsed.fields.name, `source-${randomUUID().slice(0, 8)}`);
  try {
    const db = getDb();
    const [existing] = await db.select({ id: studySources.id }).from(studySources).where(eq(studySources.slug, slug));
    if (existing) {
      return { ok: false, error: `A source with the slug "${slug}" already exists — change the name so it derives a different slug.` };
    }
    await createStudySource(slug, parsed.fields);
    revalidateSources(slug);
    return { ok: true, slug };
  } catch (e) {
    return { ok: false, error: humanize(e) };
  }
}

/** Our own stored pictures live under sources/; anything else in image_url was pasted and is not ours to delete. */
function isOwnStoredImage(url: string): boolean {
  return /\/sources\/[a-z0-9-]+-[a-z0-9]+\.(jpg|jpeg|png|webp)(\?|$)/i.test(url);
}

/**
 * Edit every field plus `active` and the picture. Picture precedence: an uploaded file,
 * else a pasted URL (when it differs from the current one), else "remove". Uploads go to
 * Vercel Blob when BLOB_READ_WRITE_TOKEN is set (public/sources/ locally otherwise, via
 * lib/storage.ts) under a unique sources/<slug>-<stamp>.<ext> pathname, so the URL changes
 * on every upload and no CDN cache serves the old photo; the previous upload is deleted.
 */
export async function updateSource(id: string, formData: FormData): Promise<SourceActionResult> {
  const parsed = readFields(formData);
  if (!parsed.ok) return parsed;
  try {
    const db = getDb();
    const [current] = await db.select().from(studySources).where(eq(studySources.id, id));
    if (!current) return { ok: false, error: "Source not found." };

    const patch: Partial<StudySourceFields> & { imageUrl?: string | null } = {
      ...parsed.fields,
      active: formData.get("active") === "on",
    };

    const file = formData.get("image");
    const pastedUrl = optional(formData, "imageUrl");
    const remove = formData.get("removeImage") === "on";
    let previous: string | null = null;

    if (file instanceof File && file.size > 0) {
      const ext = EXT_BY_MIME[file.type];
      if (!ext) return { ok: false, error: `Unsupported image type: ${file.type || "unknown"}. Use JPEG, PNG, or WebP.` };
      if (file.size > MAX_IMAGE_BYTES) return { ok: false, error: "That image is over 5 MB — resize it first." };
      const buf = Buffer.from(await file.arrayBuffer());
      const stamp = Date.now().toString(36);
      patch.imageUrl = await storeFile(`sources/${current.slug}-${stamp}.${ext}`, buf, file.type);
      previous = current.imageUrl;
    } else if (pastedUrl && pastedUrl !== current.imageUrl) {
      if (!/^(https?:\/\/|\/)/i.test(pastedUrl)) return { ok: false, error: "The image URL should start with http(s):// or /." };
      patch.imageUrl = pastedUrl;
      previous = current.imageUrl;
    } else if (remove && current.imageUrl) {
      patch.imageUrl = null;
      previous = current.imageUrl;
    }

    await updateStudySource(id, patch);
    if (previous && isOwnStoredImage(previous)) await deleteStoredFiles([previous]);
    revalidateSources(current.slug);
    return { ok: true, slug: current.slug };
  } catch (e) {
    return { ok: false, error: humanize(e) };
  }
}
