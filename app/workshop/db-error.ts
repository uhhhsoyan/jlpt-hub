// Plain helpers (not a "use server" module, so non-async exports are allowed).
// Drizzle wraps DB failures as "Failed query: ..." with the real cause nested in `.cause`.

export function errChain(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur; i++) {
    if (cur instanceof Error) {
      parts.push(cur.message);
      cur = cur.cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join(" | ");
}

export function firstLine(s: string): string {
  return s.split("\n")[0].slice(0, 300);
}
