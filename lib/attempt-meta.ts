import { normalizeRootCause } from "./types.ts";

/**
 * Typed accessors for the attempt fields that live in practice_questions.meta (jsonb)
 * behind first-class tool parameters: `part`, `done_on` and `slips`. Pure (no DB, no path
 * aliases) so it unit-tests under plain `node --test`.
 *
 * Storing them in meta is a deliberate stopgap (no migration three weeks before the exam).
 * Every read and write goes through this module, so promoting a field to a column later
 * means changing these functions and a backfill, not the tool surface.
 */

/**
 * Meta keys owned by first-class fields. `part` is stored under `questionPart`, not `part`:
 * lesson sessions already use `meta.part` for the lesson section (`examples`, `れんしゅう1`),
 * and a multi-blank れんしゅう question needs both.
 */
export const ATTEMPT_META_KEYS = { part: "questionPart", doneOn: "done_on", slips: "slips" } as const;

type Meta = Record<string, unknown> | null | undefined;

// ---- part (one row per blank of a multi-blank question) -----------------------------------

const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** The blank this attempt is, or null for a single-answer question (or anything malformed). */
export function readPart(meta: Meta): number | null {
  const v = meta?.[ATTEMPT_META_KEYS.part];
  return isPositiveInt(v) ? v : null;
}

/** "7" or "7②" (circled for 1-20, "7(21)" beyond): how an attempt is labelled in the Hub. */
export function attemptLabel(number: number, part: number | null): string {
  if (part === null) return String(number);
  return part <= 20 ? `${number}${String.fromCodePoint(0x2460 + part - 1)}` : `${number}(${part})`;
}

/** "#7" or "#7 part 2": how an attempt is named in tool errors and text. */
export function attemptName(number: number, part: number | null): string {
  return part === null ? `#${number}` : `#${number} part ${part}`;
}

/** Sort key for display: printed number, then part (no part first). */
export function compareAttempts(a: { number: number; meta: Meta }, b: { number: number; meta: Meta }): number {
  return a.number - b.number || (readPart(a.meta) ?? 0) - (readPart(b.meta) ?? 0);
}

// ---- done_on (per-attempt date for a set that spans days) ---------------------------------

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A YYYY-MM-DD string that names a real calendar date, as a UTC-midnight Date; null otherwise. */
function isoDate(s: string): Date | null {
  const m = ISO_DATE.exec(s);
  if (!m) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  // Reject 2026-02-30 and friends, which Date would roll over.
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() + 1 === Number(m[2]) && d.getUTCDate() === Number(m[3]) ? d : null;
}

/**
 * Validate a done_on given to a tool. Returns the normalised YYYY-MM-DD string; null for
 * null (clear). Throws with a clear message for anything else, so a typo is never stored
 * and silently ignored.
 */
export function parseDoneOn(raw: string | null): string | null {
  if (raw === null) return null;
  const s = raw.trim();
  if (!isoDate(s)) throw new Error(`done_on must be an ISO date (YYYY-MM-DD), got "${raw}".`);
  return s;
}

export type StoredDoneOn = { kind: "none" } | { kind: "date"; iso: string; at: Date } | { kind: "invalid"; raw: unknown };

/** What an attempt's meta holds for done_on. Hand-edited rows can hold anything, hence "invalid". */
export function readDoneOn(meta: Meta): StoredDoneOn {
  const v = meta?.[ATTEMPT_META_KEYS.doneOn];
  if (v === undefined || v === null) return { kind: "none" };
  if (typeof v === "string") {
    const at = isoDate(v.trim());
    if (at) return { kind: "date", iso: v.trim(), at };
  }
  return { kind: "invalid", raw: v };
}

/**
 * When an attempt's evidence happened: its done_on (UTC midnight of that date, the same
 * instant a bare `taken_at: "YYYY-MM-DD"` parses to) when set, else the session's taken_at.
 * Throws on a stored value that is not a date, naming the attempt, so evidence is never
 * written under a date nobody chose.
 */
export function evidenceDate(meta: Meta, sessionAt: Date, name = "This attempt"): Date {
  const d = readDoneOn(meta);
  if (d.kind === "date") return d.at;
  if (d.kind === "none") return sessionAt;
  throw new Error(
    `${name} has meta.done_on ${JSON.stringify(d.raw)}, which is not an ISO date (YYYY-MM-DD). Fix it with update_attempt done_on (a date, or null to clear).`,
  );
}

// ---- slips (non-pattern errors on an otherwise graded answer) ------------------------------

/** Suggested slip kinds; like root causes, any short kebab-case label is kept. */
export const SLIP_KINDS = ["vocab-misread", "kana-misread", "particle", "subject-confusion", "pattern-misread", "tense", "other"] as const;

export interface Slip {
  /** Short kebab-case label (normalised like a root cause). */
  kind: string;
  /** One-line description: "read 時 as 時間". */
  text: string;
}

/**
 * Validate and normalise slips given to a tool: kind normalised like a root cause, text
 * trimmed, exact repeats dropped. Throws when a kind or text is empty after trimming.
 */
export function normalizeSlips(raw: { kind: string; text: string }[], where = "slips"): Slip[] {
  const out: Slip[] = [];
  for (const [i, s] of raw.entries()) {
    const kind = normalizeRootCause(s.kind);
    const text = s.text.replace(/\s+/g, " ").trim();
    if (!kind) throw new Error(`${where}[${i}].kind is empty; use a short label such as ${SLIP_KINDS.join(", ")}.`);
    if (!text) throw new Error(`${where}[${i}].text is empty; describe the slip in one line.`);
    if (!out.some((o) => o.kind === kind && o.text === text)) out.push({ kind, text });
  }
  return out;
}

/** The slips stored on an attempt; malformed entries (hand edits) are skipped. */
export function readSlips(meta: Meta): Slip[] {
  const v = meta?.[ATTEMPT_META_KEYS.slips];
  if (!Array.isArray(v)) return [];
  const out: Slip[] = [];
  for (const s of v) {
    if (s && typeof s === "object" && typeof (s as Slip).kind === "string" && typeof (s as Slip).text === "string") {
      out.push({ kind: (s as Slip).kind, text: (s as Slip).text });
    }
  }
  return out;
}

/** Grouping key for slip text: NFKC, whitespace collapsed, lower-cased, trailing punctuation dropped. */
export function normalizeSlipText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[.。!！?？]+$/u, "");
}

export interface SlipTallyInput {
  number?: number;
  meta: Meta;
}

export interface SlipKindCount {
  kind: string;
  n: number;
  /** Printed numbers of the attempts carrying a slip of this kind, first-seen order, no repeats. */
  numbers: number[];
}

export interface SlipTextCount {
  /** The first spelling seen. */
  text: string;
  n: number;
  /** Kinds this text was filed under, first-seen order. */
  kinds: string[];
}

export interface SlipTally {
  total: number;
  byKind: SlipKindCount[];
  byText: SlipTextCount[];
}

/**
 * Tally the slips over a list of attempts, by kind and by normalised text, most frequent
 * first (ties keep first-seen order). Kinds are re-normalised so hand-entered spellings
 * group with tool-entered ones. For the lesson review; slips never touch accuracy.
 */
export function tallySlips(attempts: SlipTallyInput[]): SlipTally {
  const byKind = new Map<string, SlipKindCount>();
  const byText = new Map<string, SlipTextCount>();
  let total = 0;
  for (const a of attempts) {
    for (const s of readSlips(a.meta)) {
      const kind = normalizeRootCause(s.kind) ?? "other";
      const textKey = normalizeSlipText(s.text);
      if (!textKey) continue;
      total += 1;
      const k = byKind.get(kind) ?? { kind, n: 0, numbers: [] };
      k.n += 1;
      if (a.number !== undefined && !k.numbers.includes(a.number)) k.numbers.push(a.number);
      byKind.set(kind, k);
      const t = byText.get(textKey) ?? { text: s.text.trim(), n: 0, kinds: [] };
      t.n += 1;
      if (!t.kinds.includes(kind)) t.kinds.push(kind);
      byText.set(textKey, t);
    }
  }
  const desc = <T extends { n: number }>(xs: T[]) => xs.sort((a, b) => b.n - a.n);
  return { total, byKind: desc([...byKind.values()]), byText: desc([...byText.values()]) };
}

// ---- Writing the fields into meta ---------------------------------------------------------

/** First-class attempt fields as they go into meta. undefined = not given; null = clear. */
export interface AttemptMetaFields {
  part?: number | null;
  /** Already validated (parseDoneOn). */
  doneOn?: string | null;
  /** Already normalised (normalizeSlips); an empty list clears. */
  slips?: Slip[];
}

/** The meta patch (for mergeMeta) that writes the given fields; keys not given are absent. */
export function attemptMetaPatch(f: AttemptMetaFields): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (f.part !== undefined) patch[ATTEMPT_META_KEYS.part] = f.part;
  if (f.doneOn !== undefined) patch[ATTEMPT_META_KEYS.doneOn] = f.doneOn;
  if (f.slips !== undefined) patch[ATTEMPT_META_KEYS.slips] = f.slips.length > 0 ? f.slips : null;
  return patch;
}

/**
 * Free-form `meta` may not carry the keys owned by first-class fields: a done_on slipped in
 * through meta would skip validation and the evidence rebuild. Throws naming the field to use.
 */
export function assertNoReservedMetaKeys(meta: Record<string, unknown> | null | undefined, where = "meta"): void {
  if (!meta) return;
  const fields: Record<string, string> = {
    [ATTEMPT_META_KEYS.part]: "part",
    [ATTEMPT_META_KEYS.doneOn]: "done_on",
    [ATTEMPT_META_KEYS.slips]: "slips",
  };
  for (const key of Object.keys(meta)) {
    if (key in fields) throw new Error(`${where}.${key} is set by the ${fields[key]} field; pass ${fields[key]} instead of putting it in meta.`);
  }
}
