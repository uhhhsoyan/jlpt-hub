import { alignFurigana } from "@/lib/furigana";

interface FuriganaProps {
  japanese: string;
  reading: string;
  /** Classes for the sentence <p>; give multi-line text a roomy leading for the ruby. */
  className?: string;
}

/**
 * Renders a sentence with its reading as <ruby> furigana above each kanji run.
 * When the stored reading can't be aligned (or the sentence is pure kana with a
 * reading that adds nothing), falls back to the classic reading-below layout.
 */
export function Furigana({ japanese, reading, className }: FuriganaProps) {
  const segments = alignFurigana(japanese, reading);

  if (!segments) {
    return (
      <>
        <p className={className} lang="ja">
          {japanese}
        </p>
        <p className="text-sm text-neutral-500 dark:text-neutral-400" lang="ja">
          {reading}
        </p>
      </>
    );
  }

  return (
    <p className={className} lang="ja">
      {segments.map((seg, i) =>
        seg.ruby ? (
          <ruby key={i}>
            {seg.text}
            <rt className="select-none text-[0.5em] font-normal text-neutral-500 dark:text-neutral-400">
              {seg.ruby}
            </rt>
          </ruby>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </p>
  );
}
