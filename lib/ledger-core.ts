import type { ItemKind, ObservationKind, PracticeSurface, QuestionTag, SessionMode } from "./types.ts";

/**
 * Pure helpers for the study ledger's write and correction paths (no DB, no path aliases)
 * so they unit-test under plain `node --test`; lib/ledger.ts wires them to the database.
 */

/**
 * What kind of evidence an attempt produces. Closed-book practice answers are graded
 * evidence (and only when actually graded); open-book lesson work is exposure, written
 * even when ungraded, so "studied this" moves an item from unseen to learning without
 * touching accuracy anywhere.
 */
export function evidenceKind(mode: SessionMode, correct: boolean | null): ObservationKind | null {
  if (mode === "lesson") return "exposure";
  return correct === null ? null : "answer";
}

// ---- Evidence rows ----------------------------------------------------------------------

/** One resolved question→item link (a question_items row with role 'tested') and its result. */
export interface EvidenceLink {
  questionId: string;
  itemId: string;
  isCorrect: boolean | null;
}

export interface EvidenceContext {
  sessionId: string;
  surface: PracticeSurface;
  mode: SessionMode;
  occurredAt: Date;
}

export interface EvidenceRow {
  itemId: string;
  source: "practice";
  kind: ObservationKind;
  correct: boolean | null;
  occurredAt: Date;
  meta: Record<string, unknown>;
}

/**
 * The observation rows a set of question links produces under a session's mode, as
 * written when evidence is rebuilt (update_session, update_attempt). Ungraded practice
 * answers produce nothing; lesson links always produce an exposure.
 */
export function buildEvidenceRows(links: EvidenceLink[], ctx: EvidenceContext): EvidenceRow[] {
  const rows: EvidenceRow[] = [];
  for (const l of links) {
    const kind = evidenceKind(ctx.mode, l.isCorrect);
    if (!kind) continue;
    rows.push({
      itemId: l.itemId,
      source: "practice",
      kind,
      correct: l.isCorrect,
      occurredAt: ctx.occurredAt,
      meta: { sessionId: ctx.sessionId, questionId: l.questionId, surface: ctx.surface, mode: ctx.mode, rebuilt: true },
    });
  }
  return rows;
}

/** Distinct resolved item ids of a tag list, in order (question_items has one row per question/item pair). */
export function linkedItemIds(tags: QuestionTag[]): string[] {
  const out: string[] = [];
  for (const t of tags) if (t.itemId && !out.includes(t.itemId)) out.push(t.itemId);
  return out;
}

// ---- Unresolved tags --------------------------------------------------------------------

export interface UnresolvedOccurrence {
  /** Printed number of the attempt the tag was on. */
  number: number;
  kind: ItemKind;
  text: string;
}

export interface UnresolvedGroup {
  kind: ItemKind;
  text: string;
  /** Attempt numbers carrying this tag, in first-seen order, without repeats. */
  numbers: number[];
}

/**
 * One entry per distinct {kind, text} (text trimmed), so a lesson that tags ten attempts
 * with the same missing pattern reports it once with its numbers rather than ten times.
 * Order is first occurrence.
 */
export function groupUnresolved(occurrences: UnresolvedOccurrence[]): UnresolvedGroup[] {
  const groups = new Map<string, UnresolvedGroup>();
  for (const o of occurrences) {
    const text = o.text.trim();
    const key = `${o.kind}\u0000${text}`;
    const g = groups.get(key) ?? { kind: o.kind, text, numbers: [] };
    if (!g.numbers.includes(o.number)) g.numbers.push(o.number);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** The unresolved tags of a set of attempts, as occurrences ready for groupUnresolved. */
export function unresolvedOccurrences(attempts: { number: number; tags: QuestionTag[] }[]): UnresolvedOccurrence[] {
  return attempts.flatMap((a) => a.tags.filter((t) => !t.itemId).map((t) => ({ number: a.number, kind: t.kind, text: t.text })));
}

// ---- Meta merge -------------------------------------------------------------------------

/**
 * Shallow merge of an attempt's meta: keys in the patch overwrite, a key set to null is
 * removed, keys not mentioned are kept. Returns null when nothing is left, matching how
 * log_attempts stores an empty meta.
 */
export function mergeMeta(
  current: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ---- Picking an attempt by printed number -----------------------------------------------

export interface AttemptRef {
  number: number;
  note: string | null;
  stem: string | null;
  tags: { text: string }[];
}

const snippet = (s: string, max = 50) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** "position 3 (#2, "picked つもり, needed はず")": how an attempt is named in an error. */
export function describeAttempt(row: AttemptRef, position: number): string {
  const text = row.note?.trim() || row.stem?.trim() || row.tags.map((t) => t.text).join(", ") || "no note or stem";
  return `position ${position} (#${row.number}, "${snippet(text)}")`;
}

/**
 * Find the attempt a correction is about. `ordered` is the session's attempts in logged
 * order; `position` is 1-based in that order. Several attempts can share a printed number
 * (multi-blank questions logged as repeats), so a number alone that matches more than one
 * is an error listing the candidates, and `position` picks among them. A position that
 * points at an attempt with a different number is also an error, so a stale position can
 * never silently edit the wrong row.
 */
export function pickAttempt<T extends AttemptRef>(ordered: T[], number: number, position?: number): { row: T; position: number } {
  if (ordered.length === 0) throw new Error("This session has no attempts.");
  const candidates = ordered.map((row, i) => ({ row, position: i + 1 })).filter((c) => c.row.number === number);
  const list = (cs: { row: T; position: number }[]) => cs.map((c) => describeAttempt(c.row, c.position)).join("; ");

  if (position !== undefined) {
    if (!Number.isInteger(position) || position < 1 || position > ordered.length) {
      throw new Error(`Position ${position} is out of range: the session has ${ordered.length} attempts (positions 1-${ordered.length}).`);
    }
    const row = ordered[position - 1];
    if (row.number !== number) {
      throw new Error(
        `Position ${position} is attempt #${row.number}, not #${number}.` +
          (candidates.length > 0 ? ` Attempts numbered ${number}: ${list(candidates)}.` : ` No attempt is numbered ${number}.`),
      );
    }
    return { row, position };
  }

  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    const numbers = [...new Set(ordered.map((r) => r.number))].sort((a, b) => a - b);
    throw new Error(`No attempt numbered ${number} in this session. Numbers present: ${numbers.join(", ")}.`);
  }
  throw new Error(
    `${candidates.length} attempts in this session are numbered ${number}: ${list(candidates)}. Pass position (1-based order in the session) to pick one.`,
  );
}

// ---- Applying a correction to one attempt -----------------------------------------------

/** The correctable columns of a practice_questions row. */
export interface AttemptState {
  isCorrect: boolean | null;
  rootCause: string | null;
  note: string | null;
  stem: string;
  explanation: string | null;
  meta: Record<string, unknown> | null;
  tags: QuestionTag[];
}

/** Fields to change; undefined = leave alone. Tags arrive already resolved. */
export interface AttemptPatch {
  correct?: boolean | null;
  /** Already normalised (normalizeRootCause); null clears. */
  rootCause?: string | null;
  note?: string | null;
  stem?: string | null;
  explanation?: string | null;
  /** Shallow merge; a key set to null is removed (see mergeMeta). */
  meta?: Record<string, unknown>;
  tags?: QuestionTag[];
}

export interface AttemptPatchPlan {
  next: AttemptState;
  /** Tool field names that actually changed: tags, correct, root_cause, note, stem, explanation, meta. */
  changed: string[];
  /** True when tags or correct changed, so the attempt's evidence rows must be rebuilt. */
  evidenceStale: boolean;
}

const cleanText = (s: string | null | undefined): string | null => {
  const t = s?.trim();
  return t ? t : null;
};

const sameTags = (a: QuestionTag[], b: QuestionTag[]) =>
  a.length === b.length && a.every((t, i) => t.kind === b[i].kind && t.text === b[i].text && t.itemId === b[i].itemId);

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Apply a patch to an attempt, reporting only the fields whose value really changes. */
export function planAttemptPatch(current: AttemptState, patch: AttemptPatch): AttemptPatchPlan {
  const next: AttemptState = { ...current };
  const changed: string[] = [];

  if (patch.tags !== undefined && !sameTags(patch.tags, current.tags)) {
    next.tags = patch.tags;
    changed.push("tags");
  }
  if (patch.correct !== undefined && patch.correct !== current.isCorrect) {
    next.isCorrect = patch.correct;
    changed.push("correct");
  }
  if (patch.rootCause !== undefined && patch.rootCause !== current.rootCause) {
    next.rootCause = patch.rootCause;
    changed.push("root_cause");
  }
  if (patch.note !== undefined) {
    const note = cleanText(patch.note);
    if (note !== current.note) {
      next.note = note;
      changed.push("note");
    }
  }
  if (patch.stem !== undefined) {
    const stem = cleanText(patch.stem) ?? "";
    if (stem !== current.stem) {
      next.stem = stem;
      changed.push("stem");
    }
  }
  if (patch.explanation !== undefined) {
    const explanation = cleanText(patch.explanation);
    if (explanation !== current.explanation) {
      next.explanation = explanation;
      changed.push("explanation");
    }
  }
  if (patch.meta !== undefined) {
    const meta = mergeMeta(current.meta, patch.meta);
    if (!sameJson(meta, current.meta)) {
      next.meta = meta;
      changed.push("meta");
    }
  }

  return { next, changed, evidenceStale: changed.includes("tags") || changed.includes("correct") };
}
