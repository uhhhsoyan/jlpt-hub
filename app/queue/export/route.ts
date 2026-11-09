import { exportFilename, listVocabQueue, toAnkiTsv, type QueueFilter } from "@/lib/vocab-queue";
import { isVocabQueueStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

/** GET /queue/export?status=queued → an Anki-importable TSV of those rows. */
export async function GET(req: Request): Promise<Response> {
  const raw = new URL(req.url).searchParams.get("status") ?? "queued";
  const status: QueueFilter = raw === "all" || isVocabQueueStatus(raw) ? (raw as QueueFilter) : "queued";
  let rows;
  try {
    rows = await listVocabQueue({ status, limit: 500 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(`Queue unavailable: ${msg}\n`, { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return new Response(toAnkiTsv(rows), {
    status: 200,
    headers: {
      "content-type": "text/tab-separated-values; charset=utf-8",
      "content-disposition": `attachment; filename="${exportFilename(status)}"`,
      "cache-control": "no-store",
    },
  });
}
