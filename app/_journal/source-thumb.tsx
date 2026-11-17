import type { FeedSource } from "@/lib/study-feed";
import { resolveSourceImage } from "@/app/sources/image";

const FALLBACK_COLOR = "#525252";

/**
 * A source's cover at thumbnail size: the same picture the Sources grid shows (image_url or
 * public/sources/<slug>.*), else a small swatch in the catalog colour with the title's first
 * character. Decorative: the source name is always printed next to it.
 */
export function SourceThumb({ source, size = "md" }: { source: FeedSource | null; size?: "sm" | "md" }) {
  const box = size === "sm" ? "h-7 w-[1.3rem] text-[10px]" : "h-11 w-8 text-xs";
  if (!source) {
    return <span aria-hidden className={`${box} shrink-0 rounded-md border border-dashed border-neutral-300 dark:border-neutral-700`} />;
  }
  const imageSrc = resolveSourceImage(source.slug, source.imageUrl);
  if (imageSrc) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- same unknown-host Blob/pasted URLs as SourceArt; not worth an Image loader allowlist
      <img src={imageSrc} alt="" aria-hidden className={`${box} shrink-0 rounded-md border border-neutral-200 object-cover dark:border-neutral-800`} />
    );
  }
  const glyph = [...(source.nameJa ?? source.name).trim()][0] ?? "?";
  return (
    <span
      aria-hidden
      className={`${box} flex shrink-0 items-center justify-center rounded-md font-bold text-white shadow-inner`}
      style={{ backgroundColor: source.color ?? FALLBACK_COLOR }}
    >
      {glyph}
    </span>
  );
}
