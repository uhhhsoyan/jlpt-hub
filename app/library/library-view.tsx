"use client";

import { useMemo, useState } from "react";
import type { LibraryItem } from "./types";
import { VocabTab } from "./vocab-tab";
import { KanjiTab } from "./kanji-tab";

type Tab = "vocab" | "kanji";

export function LibraryView({ items }: { items: LibraryItem[] }) {
  const [tab, setTab] = useState<Tab>("vocab");

  const vocab = useMemo(() => items.filter((item) => item.kind === "vocab"), [items]);
  const kanji = useMemo(() => items.filter((item) => item.kind === "kanji"), [items]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex gap-1 border-b border-neutral-200 dark:border-neutral-800">
        <TabButton active={tab === "vocab"} onClick={() => setTab("vocab")}>
          Vocab<Count n={vocab.length} />
        </TabButton>
        <TabButton active={tab === "kanji"} onClick={() => setTab("kanji")}>
          Kanji<Count n={kanji.length} />
        </TabButton>
      </div>

      {tab === "vocab" ? <VocabTab items={vocab} /> : <KanjiTab items={kanji} vocab={vocab} />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold transition ${
        active
          ? "border-neutral-900 text-neutral-900 dark:border-white dark:text-white"
          : "border-transparent text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
      }`}
    >
      {children}
    </button>
  );
}

function Count({ n }: { n: number }) {
  return <span className="ml-1 text-xs font-normal text-neutral-400">{n}</span>;
}
