import { getDb } from "@/lib/db";
import { wkSnapshot } from "@/lib/db/schema";
import type { WkLevelSnapshot } from "@/lib/types";
import { ScheduleView, type ScheduleWk } from "./schedule-view";

export const dynamic = "force-dynamic";

async function loadWk(): Promise<ScheduleWk> {
  const configured = !!process.env.WANIKANI_TOKEN;
  let snapshot: WkLevelSnapshot | null = null;
  try {
    const [row] = await getDb().select().from(wkSnapshot);
    if (row) {
      snapshot = {
        level: row.level,
        kanjiPassed: row.kanjiPassed,
        kanjiTotal: row.kanjiTotal,
        kanjiRequired: row.kanjiRequired,
        syncedAt: row.syncedAt.toISOString(),
      };
    }
  } catch {
    // DB not configured or table missing — the schedule still renders, just without
    // WaniKani state (the view shows its own guidance for that case).
  }
  return { configured, snapshot };
}

export default async function Home() {
  const wk = await loadWk();
  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-8 font-sans">
      <ScheduleView wk={wk} />
    </div>
  );
}
