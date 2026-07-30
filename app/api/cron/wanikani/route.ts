import { revalidatePath } from "next/cache";
import { syncWanikani } from "@/lib/wanikani";
import { syncBunpro } from "@/lib/bunpro";

/**
 * Scheduled sync of all external integrations, invoked by Vercel Cron (see
 * vercel.json; the path keeps its historical /wanikani name so the existing cron
 * entry and CRON_SECRET setup stay valid). Vercel sends
 * `Authorization: Bearer <CRON_SECRET>` when the env var is set; with no secret
 * configured the endpoint refuses everything rather than running unauthenticated.
 *
 * Disabled or unconfigured integrations report their state without failing the
 * run — the response is 200 as long as every *enabled and configured* sync worked.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const results = {
    wanikani: process.env.WANIKANI_TOKEN
      ? await syncWanikani()
      : { ok: false as const, error: "not configured" },
    bunpro: process.env.BUNPRO_API_KEY
      ? await syncBunpro()
      : { ok: false as const, error: "not configured" },
  };

  if (results.wanikani.ok || results.bunpro.ok) {
    revalidatePath("/");
    revalidatePath("/progress");
    revalidatePath("/library");
  }

  // "not configured" / "disabled" are expected states, not cron failures.
  const failed = Object.values(results).some(
    (r) => !r.ok && !/not configured|disabled/i.test(r.error),
  );
  return Response.json(results, { status: failed ? 500 : 200 });
}
