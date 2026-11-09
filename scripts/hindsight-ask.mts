// Query the local Hindsight bank (read-only). See docs/plans/07-hindsight.md.
//
// Usage: npm run hindsight:ask -- recall <query>            # ranked memories
//        npm run hindsight:ask -- reflect <question>        # LLM answer grounded in the bank
//        npm run hindsight:ask -- reflect --facts <question>  # also list the memories it used
// Env (optional): HINDSIGHT_URL (default http://localhost:8888), HINDSIGHT_BANK (jlpt-study),
// HINDSIGHT_API_KEY (bearer token when the container runs with auth; see scripts/hindsight.sh).
import { HindsightClient } from "@vectorize-io/hindsight-client";

const BASE_URL = process.env.HINDSIGHT_URL ?? "http://localhost:8888";
const BANK = process.env.HINDSIGHT_BANK ?? "jlpt-study";

const argv = process.argv.slice(2);
const mode = argv.shift();
const withFacts = argv.includes("--facts");
// Reflect runs an agent loop on the LLM and the server caps it at 300 s; "low" fits
// comfortably, "mid" timed out on claude-opus-5-5 against this bank. Recall is local and fast.
const budgetIdx = argv.indexOf("--budget");
const budget = (budgetIdx >= 0 ? argv[budgetIdx + 1] : undefined) as "low" | "mid" | "high" | undefined;
const query = argv
  .filter((a, i) => a !== "--facts" && a !== "--budget" && (budgetIdx < 0 || i !== budgetIdx + 1))
  .join(" ")
  .trim();

if ((mode !== "recall" && mode !== "reflect") || !query) {
  console.error(
    "usage: npm run hindsight:ask -- recall <query> | reflect [--facts] [--budget low|mid|high] <question>",
  );
  process.exit(2);
}

const client = new HindsightClient({ baseUrl: BASE_URL, apiKey: process.env.HINDSIGHT_API_KEY });

if (mode === "recall") {
  const res = await client.recall(BANK, query, { budget: budget ?? "mid", maxTokens: 2048 });
  if (!res.results.length) console.log("(no results)");
  res.results.forEach((r, i) => {
    const when = r.occurred_start ? String(r.occurred_start).slice(0, 10) : "";
    const head = [`${i + 1}.`, `[${r.type ?? "?"}]`, when, r.document_id ? `(${r.document_id})` : ""]
      .filter(Boolean)
      .join(" ");
    console.log(`${head}\n   ${r.text}`);
  });
} else {
  const res = await client.reflect(BANK, query, { budget: budget ?? "low", includeFacts: withFacts });
  console.log(res.text);
  if (withFacts && res.based_on) {
    console.log("\n--- based on ---");
    console.log(JSON.stringify(res.based_on, null, 1));
  }
}
