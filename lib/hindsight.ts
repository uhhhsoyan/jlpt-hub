import { HindsightClient } from "@vectorize-io/hindsight-client";

/**
 * Read-only bridge from the Hub to the Hindsight memory bank (docs/plans/07-hindsight.md,
 * Phase B). The bank runs in Docker on a home machine behind a Cloudflare tunnel; this
 * module only ever calls recall and reflect, never retain. Nothing here is required for
 * the Hub to work: with HINDSIGHT_URL unset every call reports `unconfigured`, and when the
 * tunnel or container is down it reports `offline`, so a caller (the MCP tools) can carry
 * on with the ledger alone.
 *
 * Env (Vercel):
 *   HINDSIGHT_URL            API origin, e.g. https://hindsight-api.example.com (no path)
 *   HINDSIGHT_BANK           bank id, default jlpt-study
 *   HINDSIGHT_API_KEY        bearer token the container was started with (scripts/hindsight.sh)
 *   CF_ACCESS_CLIENT_ID      Cloudflare Access service token (both or neither)
 *   CF_ACCESS_CLIENT_SECRET
 *   HINDSIGHT_UI_URL         UI origin for the "memory graph" link, e.g. https://hindsight.example.com
 */

export type Env = Record<string, string | undefined>;

export interface HindsightConfig {
  baseUrl: string;
  bank: string;
  apiKey?: string;
  accessClientId?: string;
  accessClientSecret?: string;
  uiUrl?: string;
}

const trimSlash = (s: string) => s.trim().replace(/\/+$/, "");

/** null when HINDSIGHT_URL is unset: the add-on is simply not wired up in this deployment. */
export function readHindsightConfig(env: Env = process.env): HindsightConfig | null {
  const baseUrl = env.HINDSIGHT_URL ? trimSlash(env.HINDSIGHT_URL) : "";
  if (!baseUrl) return null;
  return {
    baseUrl,
    bank: env.HINDSIGHT_BANK?.trim() || "jlpt-study",
    apiKey: env.HINDSIGHT_API_KEY?.trim() || undefined,
    accessClientId: env.CF_ACCESS_CLIENT_ID?.trim() || undefined,
    accessClientSecret: env.CF_ACCESS_CLIENT_SECRET?.trim() || undefined,
    uiUrl: env.HINDSIGHT_UI_URL ? trimSlash(env.HINDSIGHT_UI_URL) || undefined : undefined,
  };
}

/** Where the bank's constellation / entity graphs live, or null when no UI URL is configured. */
export function memoryUiUrl(env: Env = process.env): string | null {
  const cfg = readHindsightConfig(env);
  if (!cfg?.uiUrl) return null;
  return `${cfg.uiUrl}/banks/${encodeURIComponent(cfg.bank)}`;
}

/** Cloudflare Access service-token headers; empty unless both halves are present. */
export function accessHeaders(cfg: Pick<HindsightConfig, "accessClientId" | "accessClientSecret">): Record<string, string> {
  if (!cfg.accessClientId || !cfg.accessClientSecret) return {};
  return { "CF-Access-Client-Id": cfg.accessClientId, "CF-Access-Client-Secret": cfg.accessClientSecret };
}

export type MemoryBudget = "low" | "mid" | "high";

export interface MemoryHit {
  text: string;
  /** Hindsight memory type: world (extracted fact), observation (consolidated pattern), experience. */
  type: string | null;
  /** ISO date the memory is about (the session or insight date), when known. */
  when: string | null;
  /** `insight:<id>` or `session:<id>` from the mirror, so the ledger row can be looked up. */
  documentId: string | null;
  entities: string[];
}

export type MemoryFailure =
  | { status: "unconfigured"; hint: string }
  | { status: "offline"; reason: string }
  | { status: "rejected"; reason: string };

export type MemoryResult<T> = ({ status: "ok" } & T) | MemoryFailure;

export const UNCONFIGURED: MemoryFailure = {
  status: "unconfigured",
  hint: "Hindsight is not wired up in this deployment (HINDSIGHT_URL unset); use get_insights and the ledger reports instead.",
};

interface RawRecallHit {
  text: string;
  type?: string | null;
  occurred_start?: string | null;
  mentioned_at?: string | null;
  document_id?: string | null;
  entities?: string[] | null;
}

export function shapeRecall(results: RawRecallHit[], limit: number): MemoryHit[] {
  return results.slice(0, Math.max(0, limit)).map((r) => {
    const when = r.occurred_start ?? r.mentioned_at ?? null;
    return {
      text: r.text.trim(),
      type: r.type ?? null,
      when: when ? String(when).slice(0, 10) : null,
      documentId: r.document_id ?? null,
      entities: r.entities ?? [],
    };
  });
}

/**
 * Turn a thrown error into a result the caller can report instead of failing the tool call.
 * `rejected` means our configuration is wrong (key or Access token); `offline` means the
 * tunnel or container is unreachable or slow and the ledger tools should be used alone.
 */
export function classifyFailure(e: unknown): MemoryFailure {
  const err = e as { name?: string; message?: string; statusCode?: number } | null;
  const status = typeof err?.statusCode === "number" ? err.statusCode : undefined;
  const msg = err?.message ?? String(e);
  if (status === 401 || status === 403) {
    return {
      status: "rejected",
      reason: `Hindsight or Cloudflare Access rejected the request (HTTP ${status}); check HINDSIGHT_API_KEY and CF_ACCESS_CLIENT_ID/SECRET in the deployment env.`,
    };
  }
  if (status !== undefined) {
    return { status: "offline", reason: `Memory server answered HTTP ${status}; the tunnel or container is probably down.` };
  }
  if (err?.name === "AbortError" || err?.name === "TimeoutError" || /timed out/i.test(msg)) {
    return { status: "offline", reason: msg.includes("timed out") ? msg : "Memory server timed out." };
  }
  if (err?.name === "SyntaxError" || /unexpected token|not valid json/i.test(msg)) {
    return {
      status: "rejected",
      reason: "Memory server returned a non-JSON page, most likely the Cloudflare Access login; the service token is missing or wrong.",
    };
  }
  return { status: "offline", reason: `Memory server unreachable: ${msg}` };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      const err = new Error(`${label} timed out after ${Math.round(ms / 1000)} s`);
      err.name = "TimeoutError";
      reject(err);
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function makeClient(cfg: HindsightConfig): HindsightClient {
  return new HindsightClient({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    headers: accessHeaders(cfg),
    maxAttempts: 1,
    userAgent: "jlpt-hub",
  });
}

export interface RecallOptions {
  budget?: MemoryBudget;
  limit?: number;
  timeoutMs?: number;
}

export async function memoryRecall(
  query: string,
  opts: RecallOptions = {},
  env: Env = process.env,
): Promise<MemoryResult<{ query: string; bank: string; hits: MemoryHit[]; count: number }>> {
  const cfg = readHindsightConfig(env);
  if (!cfg) return UNCONFIGURED;
  const limit = opts.limit ?? 10;
  try {
    const res = await withTimeout(
      makeClient(cfg).recall(cfg.bank, query, { budget: opts.budget ?? "mid", maxTokens: 2048 }),
      opts.timeoutMs ?? 20_000,
      "recall",
    );
    const hits = shapeRecall(res.results as RawRecallHit[], limit);
    return { status: "ok", query, bank: cfg.bank, hits, count: hits.length };
  } catch (e) {
    return classifyFailure(e);
  }
}

export interface ReflectOptions {
  budget?: Extract<MemoryBudget, "low" | "mid">;
  timeoutMs?: number;
}

export async function memoryReflect(
  question: string,
  opts: ReflectOptions = {},
  env: Env = process.env,
): Promise<MemoryResult<{ question: string; bank: string; text: string; basedOn: number }>> {
  const cfg = readHindsightConfig(env);
  if (!cfg) return UNCONFIGURED;
  try {
    const res = await withTimeout(
      makeClient(cfg).reflect(cfg.bank, question, { budget: opts.budget ?? "low", includeFacts: true }),
      opts.timeoutMs ?? 50_000,
      "reflect",
    );
    return {
      status: "ok",
      question,
      bank: cfg.bank,
      text: res.text,
      basedOn: res.based_on?.memories?.length ?? 0,
    };
  } catch (e) {
    return classifyFailure(e);
  }
}
