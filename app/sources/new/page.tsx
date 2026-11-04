import Link from "next/link";
import { SOURCE_COLORS } from "@/lib/study-sources";
import { loadStudySources } from "@/lib/study-sources-db";
import { SourceForm } from "../source-form";

// Reads the catalog size per request to pick the starting colour; never prerendered.
export const dynamic = "force-dynamic";

/** The next palette colour after the ones in use, so successive additions don't all come out indigo. */
async function nextColor(): Promise<string> {
  try {
    const count = (await loadStudySources()).length;
    return SOURCE_COLORS[count % SOURCE_COLORS.length];
  } catch {
    return SOURCE_COLORS[0];
  }
}

export default async function NewSourcePage() {
  const initialColor = await nextColor();
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-5 py-10 font-sans">
      <Link href="/sources" className="w-fit text-sm text-neutral-400 transition hover:text-neutral-600 dark:hover:text-neutral-300">
        ← Sources
      </Link>
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-bold tracking-tight">Add a source</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          A book, question bank or app you study from. Once added it can be named when logging, and its picture set from the
          edit page.
        </p>
      </header>
      <SourceForm mode="new" initialColor={initialColor} />
    </div>
  );
}
