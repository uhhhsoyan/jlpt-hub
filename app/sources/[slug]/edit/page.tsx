import Link from "next/link";
import { notFound } from "next/navigation";
import { blobEnabled } from "@/lib/storage";
import { getStudySourceBySlug } from "@/lib/study-sources-db";
import { errChain, firstLine } from "@/app/workshop/db-error";
import { SourceForm } from "../../source-form";

export const dynamic = "force-dynamic";

export default async function EditSourcePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  let source;
  try {
    source = await getStudySourceBySlug(slug);
  } catch (e) {
    return (
      <div className="mx-auto w-full max-w-2xl px-5 py-10 font-sans">
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          Couldn&apos;t read the database: {firstLine(errChain(e))}
        </p>
      </div>
    );
  }
  if (!source) notFound();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-5 py-10 font-sans">
      <Link
        href={`/sources/${source.slug}`}
        className="w-fit text-sm text-neutral-400 transition hover:text-neutral-600 dark:hover:text-neutral-300"
      >
        ← {source.name}
      </Link>
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-bold tracking-tight">Edit source</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Sessions and study-log entries keep pointing at this source whatever changes here; untick Active to hide it
          instead of deleting.
        </p>
      </header>
      <SourceForm
        mode="edit"
        id={source.id}
        slug={source.slug}
        active={source.active}
        imageUrl={source.imageUrl}
        blobEnabled={blobEnabled()}
        values={{
          name: source.name,
          nameJa: source.nameJa,
          kind: source.kind,
          level: source.level,
          edition: source.edition,
          url: source.url,
          color: source.color,
          aliases: source.aliases,
          description: source.description,
          howUsed: source.howUsed,
        }}
      />
    </div>
  );
}
