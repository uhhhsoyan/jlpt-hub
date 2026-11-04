const FALLBACK_COLOR = "#525252";

/**
 * A source's picture: the resolved image when there is one, else a typographic cover
 * card in the source's colour (Japanese title large, English name, level badge). The
 * 3:4 ratio reads as a book spine-on; apps get the same treatment for a uniform grid.
 */
export function SourceArt({
  name,
  nameJa,
  level,
  color,
  imageSrc,
  className = "",
}: {
  name: string;
  nameJa: string | null;
  level: string | null;
  color: string | null;
  imageSrc: string | null;
  className?: string;
}) {
  if (imageSrc) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- Blob/pasted URLs of unknown hosts and local public/ files; not worth an Image loader allowlist
      <img
        src={imageSrc}
        alt={name}
        className={`aspect-[3/4] w-full rounded-xl border border-neutral-200 bg-neutral-100 object-cover dark:border-neutral-800 dark:bg-neutral-800 ${className}`}
      />
    );
  }
  const title = nameJa ?? name;
  return (
    <div
      aria-label={name}
      role="img"
      className={`relative flex aspect-[3/4] w-full flex-col justify-between overflow-hidden rounded-xl p-3 text-white shadow-inner ${className}`}
      style={{ backgroundColor: color ?? FALLBACK_COLOR }}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="h-1.5 w-8 rounded-full bg-white/60" />
        {level && (
          <span className="rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-bold tracking-wide backdrop-blur">
            {level}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <p
          className={`font-bold leading-tight [overflow-wrap:anywhere] ${
            title.length > 14 ? "text-sm" : title.length > 8 ? "text-base" : "text-xl"
          }`}
        >
          {title}
        </p>
        {nameJa && <p className="line-clamp-2 text-[11px] leading-snug text-white/80">{name}</p>}
      </div>
    </div>
  );
}
