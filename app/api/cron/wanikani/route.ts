import { revalidatePath } from "next/cache";
import { syncWanikani } from "@/lib/wanikani";

/**
 * Scheduled WaniKani sync, invoked by Vercel Cron (see vercel.json). Vercel sends
 * `Authorization: Bearer <CRON_SECRET>` when the env var is set; with no secret
 * configured the endpoint refuses everything rather than running unauthenticated.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await syncWanikani();
  if (result.ok) {
    revalidatePath("/");
    revalidatePath("/progress");
    revalidatePath("/library");
  }
  return Response.json(result, { status: result.ok ? 200 : 500 });
}
