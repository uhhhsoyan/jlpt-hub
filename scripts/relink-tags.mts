// Re-resolve every stored tag that matched no library item and attach the evidence.
// Same code path as the MCP relink_tags tool; run after `npm run db:seed` adds items/aliases.
//
// Usage: npm run db:relink   (node --env-file=.env.local --import tsx scripts/relink-tags.mts)
import { relinkUnresolved } from "../lib/ledger";

const result = await relinkUnresolved();
console.log(JSON.stringify(result, null, 2));
