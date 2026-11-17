import { attemptLabel, readDoneOn, readPart, readSlips, type Slip } from "./attempt-meta.ts";
import type { PracticeSessionStatus, QuestionTag, SessionMode, StudyActivity, VocabSighting } from "./types.ts";

/**
 * The study journal (the Hub home page): every session, study-log entry, insight and queued
 * word, grouped by the day the work was done, newest day first. Pure (no DB, no path
 * aliases) so it unit-tests under plain `node --test`; lib/study-feed-db.ts loads the rows
 * and calls assembleStudyFeed. The result (days -> typed entries) is the seam a later
 * "what's bubbling up" panel computes over, so keep it plain data.
 *
 * Date rule. Timestamps are stored as instants. A bare date sent by a logging surface
 * ("2026-11-12") parses to UTC midnight, so an instant at exactly 00:00:00.000Z is read as
 * a date with no time and kept on that UTC calendar date. Any other instant has a real
 * time and is bucketed by its calendar date in the learner's zone (US Pacific). This keeps
 * a session logged for 2026-11-12 on Nov 12, and puts an insight logged at 8 pm Pacific
 * (04:00Z the next day) on the evening it was written. The one blind spot: a real time of
 * exactly 00:00:00.000Z (4-5 pm Pacific to the millisecond) is read as a bare date.
 */

export const FEED_TIME_ZONE = "America/Los_Angeles";
/** Calendar days per page. */
export const FEED_DAYS = 14;

// ---- Dates ----------------------------------------------------------------------------------

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const dayFormatters = new Map<string, Intl.DateTimeFormat>();
function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = dayFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormatters.set(timeZone, f);
  }
  return f;
}

/** True when the instant is exactly UTC midnight: a bare date, no time of day. */
export function isDateOnly(at: Date): boolean {
  return at.getUTCHours() === 0 && at.getUTCMinutes() === 0 && at.getUTCSeconds() === 0 && at.getUTCMilliseconds() === 0;
}

/** The YYYY-MM-DD an instant belongs to under the date rule above. */
export function feedDay(at: Date, timeZone: string = FEED_TIME_ZONE): string {
  if (isDateOnly(at)) return at.toISOString().slice(0, 10);
  const parts = dayFormatter(timeZone).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** A YYYY-MM-DD that names a real date, or null. */
export function parseDay(raw: string | null | undefined): string | null {
  const s = raw?.trim() ?? "";
  const m = ISO_DAY.exec(s);
  if (!m) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() + 1 === Number(m[2]) && d.getUTCDate() === Number(m[3]) ? s : null;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00.000Z`) - Date.parse(`${a}T00:00:00.000Z`)) / 86_400_000);
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Thursday", "Nov 12" for a YYYY-MM-DD. */
export function dayParts(day: string): { weekday: string; date: string } {
  const d = new Date(`${day}T12:00:00.000Z`);
  return { weekday: WEEKDAYS[d.getUTCDay()], date: `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}` };
}

/** "Nov 12" */
export function shortDate(day: string): string {
  return dayParts(day).date;
}

const clockFormatters = new Map<string, Intl.DateTimeFormat>();
/** "8:24 pm" in the learner's zone, or null for a bare date. */
export function clockTime(at: Date, timeZone: string = FEED_TIME_ZONE): string | null {
  if (isDateOnly(at)) return null;
  let f = clockFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true });
    clockFormatters.set(timeZone, f);
  }
  return f.format(at).replace(/\s?AM$/, " am").replace(/\s?PM$/, " pm");
}

export interface FeedWindow {
  /** Oldest day shown, inclusive. */
  from: string;
  /** Newest day shown, inclusive. */
  to: string;
}

/** The window ending on `to` (clamped to today; today when absent or invalid). */
export function feedWindow(to: string | null | undefined, today: string, days: number = FEED_DAYS): FeedWindow {
  const parsed = parseDay(to);
  const end = parsed && parsed < today ? parsed : today;
  return { from: addDays(end, -(Math.max(days, 1) - 1)), to: end };
}

/**
 * Instants that cover every row the window can hold, for the SQL range [start, end): a bare
 * date sits at its UTC midnight, a Pacific day ends at most 8 hours after the next UTC
 * midnight. Rows that fall outside the window under the date rule are dropped in assembly.
 */
export function windowBounds(w: FeedWindow): { start: Date; end: Date } {
  return { start: new Date(`${w.from}T00:00:00.000Z`), end: new Date(`${addDays(w.to, 2)}T00:00:00.000Z`) };
}

// ---- Input rows (what lib/study-feed-db.ts selects) -----------------------------------------

export interface FeedSource {
  slug: string;
  name: string;
  nameJa: string | null;
  color: string | null;
  imageUrl: string | null;
}

export interface FeedSessionRow {
  id: string;
  label: string;
  /** Lesson / page detail ("実力養成編 第1部 12課 れんしゅう2"). */
  sourceName: string | null;
  mode: SessionMode;
  status: PracticeSessionStatus;
  timed: boolean | null;
  takenAt: Date;
  createdAt: Date;
  source: FeedSource | null;
}

export interface FeedQuestionRow {
  sessionId: string;
  number: number;
  isCorrect: boolean | null;
  rootCause: string | null;
  note: string | null;
  tags: QuestionTag[];
  meta: Record<string, unknown> | null;
  /** The question text, selected for misses only (null otherwise). */
  stem: string | null;
}

export interface FeedStudyLogRow {
  id: string;
  activity: StudyActivity;
  minutes: number | null;
  note: string | null;
  takenAt: Date;
  createdAt: Date;
  source: FeedSource | null;
}

export interface FeedInsightRow {
  id: string;
  text: string;
  tags: string[];
  /** Item references as logged; itemId null where nothing in the library matched. */
  items: QuestionTag[];
  createdAt: Date;
}

export interface FeedQueueRow {
  id: string;
  text: string;
  reading: string | null;
  sightings: VocabSighting[];
}

export interface FeedRows {
  sessions: FeedSessionRow[];
  questions: FeedQuestionRow[];
  studyLogs: FeedStudyLogRow[];
  insights: FeedInsightRow[];
  queue: FeedQueueRow[];
}

// ---- Filters ---------------------------------------------------------------------------------

export type FeedModeFilter = "all" | SessionMode;

export interface FeedFilter {
  /** Catalog slug; null = every source. */
  source: string | null;
  mode: FeedModeFilter;
  /** Keep only the days that hold at least one miss. */
  missesOnly: boolean;
}

export const NO_FILTER: FeedFilter = { source: null, mode: "all", missesOnly: false };

export function parseFeedFilter(params: { source?: string | string[]; mode?: string | string[]; misses?: string | string[] }): FeedFilter {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || null;
  const source = one(params.source);
  const mode = one(params.mode);
  return {
    source: source && /^[a-z0-9-]+$/.test(source) ? source : null,
    mode: mode === "practice" || mode === "lesson" ? mode : "all",
    missesOnly: one(params.misses) === "1",
  };
}

export function isFiltered(f: FeedFilter): boolean {
  return f.source !== null || f.mode !== "all" || f.missesOnly;
}

// ---- Output ------------------------------------------------------------------------------------

export interface FeedTag {
  text: string;
  /** Resolved to a library item. */
  linked: boolean;
}

export interface FeedMiss {
  /** "7" or "7①". */
  label: string;
  rootCause: string | null;
  note: string | null;
  tags: FeedTag[];
  stem: string | null;
  slips: Slip[];
}

export interface FeedNoted {
  label: string;
  /** "slip": right answer with a note or slips; "skipped": not attempted, with a note. */
  kind: "slip" | "skipped";
  note: string | null;
  slips: Slip[];
}

export interface FeedWord {
  id: string;
  text: string;
  reading: string | null;
  /** The form as printed, when it differs from text. */
  asMet: string | null;
}

export interface FeedScore {
  correct: number;
  /** Attempts with a right/wrong result. */
  graded: number;
  /** Attempts with no result (correct null). */
  notAttempted: number;
  questions: number;
}

export interface FeedSessionEntry {
  kind: "session";
  id: string;
  label: string;
  sourceName: string | null;
  source: FeedSource | null;
  mode: SessionMode;
  status: PracticeSessionStatus;
  timed: boolean | null;
  time: string | null;
  score: FeedScore;
  misses: FeedMiss[];
  noted: FeedNoted[];
  words: FeedWord[];
  /** Other days attempts in this session were done on (done_on), oldest first. */
  alsoDoneOn: string[];
  /** Nothing missed and nothing noted: render as one line. */
  compact: boolean;
}

export interface FeedStudyEntry {
  kind: "study";
  id: string;
  source: FeedSource | null;
  activity: StudyActivity;
  minutes: number | null;
  note: string | null;
  time: string | null;
}

export interface FeedInsightEntry {
  kind: "insight";
  id: string;
  text: string;
  tags: string[];
  items: FeedTag[];
  time: string | null;
}

export interface FeedWordsEntry {
  kind: "words";
  /** The sighting label ("SKM N4 L14 explanation"); null when none was given. */
  label: string | null;
  words: FeedWord[];
}

export type FeedEntry = FeedSessionEntry | FeedStudyEntry | FeedInsightEntry | FeedWordsEntry;

export interface FeedDaySummary {
  sessions: number;
  /** Graded attempts across every session of the day. */
  graded: number;
  misses: number;
  /** Closed-book (practice) score; null when no closed-book attempt was graded. */
  closedBook: { correct: number; graded: number } | null;
  /** Distinct words queued that day. */
  words: number;
  /** Logged study minutes. */
  minutes: number;
  insights: number;
}

export interface FeedDay {
  day: string;
  entries: FeedEntry[];
  summary: FeedDaySummary;
}

export interface StudyFeed {
  window: FeedWindow;
  today: string;
  filter: FeedFilter;
  /** Newest first. Days with nothing (after filters) are absent. */
  days: FeedDay[];
  /** Sources with activity in the window (before filters), for the source picker. */
  sources: FeedSource[];
  /** Whether the window held anything before filters. */
  windowHasRows: boolean;
  /** The newest day with activity before the window (where the "older" link ends), or null. */
  older: string | null;
}

// ---- Assembly ---------------------------------------------------------------------------------

function sortKey(at: Date, createdAt: Date): number {
  return (isDateOnly(at) ? createdAt : at).getTime();
}

function toTags(tags: QuestionTag[]): FeedTag[] {
  const out: FeedTag[] = [];
  for (const t of tags) {
    const text = t.text.trim();
    if (text && !out.some((o) => o.text === text)) out.push({ text, linked: !!t.itemId });
  }
  return out;
}

const clean = (s: string | null | undefined): string | null => s?.trim() || null;

/**
 * A note on a right answer that only records it ("Correct.", "やすみなので — correct.",
 * "よさそう — correct (いい exception)."): no slip to show. Anything after a semicolon or
 * colon, or any note that does not say correct/right, is kept.
 */
export function isPlainRecord(note: string): boolean {
  const s = note.replace(/[(（][^)）]*[)）]/gu, "").replace(/\s+/g, " ").trim();
  return /^(?:[^;；:：]*?\s[—–-]\s*)?(?:correct|right)(?:\s+answer)?\s*[.。!]?$/iu.test(s);
}
const labelKey = (s: string | null | undefined) => (s ?? "").normalize("NFKC").trim().toLowerCase();

interface SessionDraft {
  row: FeedSessionRow;
  day: string;
  entry: FeedSessionEntry;
  hasMiss: boolean;
}

/**
 * Rows -> days of typed entries. Within a day: sessions and study-log entries in the order
 * they happened (their real time, else the order they were logged), then insights in the
 * order they were written, then words queued outside any session, one line per label.
 */
export function assembleStudyFeed(
  rows: FeedRows,
  opts: { window: FeedWindow; today: string; filter?: FeedFilter; older?: string | null; timeZone?: string },
): StudyFeed {
  const { window: w, today } = opts;
  const filter = opts.filter ?? NO_FILTER;
  const tz = opts.timeZone ?? FEED_TIME_ZONE;
  const inWindow = (day: string) => day >= w.from && day <= w.to;

  // Sessions in the window, with their attempts.
  const questionsBySession = new Map<string, FeedQuestionRow[]>();
  for (const q of rows.questions) {
    const list = questionsBySession.get(q.sessionId);
    if (list) list.push(q);
    else questionsBySession.set(q.sessionId, [q]);
  }

  const sessions = new Map<string, SessionDraft>();
  for (const s of rows.sessions) {
    const day = feedDay(s.takenAt, tz);
    if (!inWindow(day)) continue;
    const qs = [...(questionsBySession.get(s.id) ?? [])].sort(
      (a, b) => a.number - b.number || (readPart(a.meta) ?? 0) - (readPart(b.meta) ?? 0),
    );
    const score: FeedScore = { correct: 0, graded: 0, notAttempted: 0, questions: qs.length };
    const misses: FeedMiss[] = [];
    const noted: FeedNoted[] = [];
    const alsoDoneOn = new Set<string>();
    for (const q of qs) {
      const label = attemptLabel(q.number, readPart(q.meta));
      const note = clean(q.note);
      const slips = readSlips(q.meta);
      const doneOn = readDoneOn(q.meta);
      if (doneOn.kind === "date" && doneOn.iso !== day) alsoDoneOn.add(doneOn.iso);
      if (q.isCorrect === null) {
        score.notAttempted += 1;
        if (note || slips.length > 0) noted.push({ label, kind: "skipped", note, slips });
        continue;
      }
      score.graded += 1;
      if (q.isCorrect) {
        score.correct += 1;
        const shownNote = note && !isPlainRecord(note) ? note : null;
        if (shownNote || slips.length > 0) noted.push({ label, kind: "slip", note: shownNote, slips });
      } else {
        misses.push({ label, rootCause: clean(q.rootCause), note, tags: toTags(q.tags), stem: clean(q.stem), slips });
      }
    }
    sessions.set(s.id, {
      row: s,
      day,
      hasMiss: misses.length > 0,
      entry: {
        kind: "session",
        id: s.id,
        label: s.label,
        sourceName: clean(s.sourceName),
        source: s.source,
        mode: s.mode,
        status: s.status,
        timed: s.timed,
        time: clockTime(s.takenAt, tz),
        score,
        misses,
        noted,
        words: [],
        alsoDoneOn: [...alsoDoneOn].sort(),
        compact: misses.length === 0 && noted.length === 0,
      },
    });
  }

  // Queue sightings: onto their session when it is in the window (by id, else by a label
  // that names a session of the same day), otherwise loose on the sighting's day.
  const sessionsByDayLabel = new Map<string, SessionDraft>();
  for (const d of sessions.values()) {
    const key = `${d.day}\u0000${labelKey(d.row.label)}`;
    if (!sessionsByDayLabel.has(key)) sessionsByDayLabel.set(key, d);
  }
  const loose = new Map<string, { day: string; label: string | null; first: number; words: FeedWord[] }>();
  for (const row of rows.queue) {
    for (const s of row.sightings) {
      const at = new Date(s.at);
      if (Number.isNaN(at.getTime())) continue;
      const day = feedDay(at, tz);
      const word: FeedWord = { id: row.id, text: row.text, reading: clean(row.reading), asMet: clean(s.asMet) };
      const target =
        (s.sessionId ? sessions.get(s.sessionId) : undefined) ??
        (s.sessionId ? undefined : sessionsByDayLabel.get(`${day}\u0000${labelKey(s.label)}`));
      if (target) {
        if (!target.entry.words.some((x) => x.id === word.id)) target.entry.words.push(word);
        continue;
      }
      if (!inWindow(day)) continue;
      const label = clean(s.label);
      const key = `${day}\u0000${labelKey(label)}`;
      const group = loose.get(key) ?? { day, label, first: at.getTime(), words: [] };
      group.first = Math.min(group.first, at.getTime());
      if (!group.words.some((x) => x.id === word.id)) group.words.push(word);
      loose.set(key, group);
    }
  }

  // Sources seen in the window, before filters.
  const sourceMap = new Map<string, FeedSource>();
  const noteSource = (src: FeedSource | null) => {
    if (src && !sourceMap.has(src.slug)) sourceMap.set(src.slug, src);
  };
  for (const d of sessions.values()) noteSource(d.row.source);
  const logs = rows.studyLogs.map((l) => ({ row: l, day: feedDay(l.takenAt, tz) })).filter((l) => inWindow(l.day));
  for (const l of logs) noteSource(l.row.source);
  const insightRows = rows.insights.map((i) => ({ row: i, day: feedDay(i.createdAt, tz) })).filter((i) => inWindow(i.day));
  const windowHasRows = sessions.size > 0 || logs.length > 0 || insightRows.length > 0 || loose.size > 0;

  // Filters: a source or mode narrows the feed to sessions (and, for a source, its study log);
  // insights and loose words name no source or mode, so they drop out.
  const narrowed = filter.source !== null || filter.mode !== "all";
  const keepSession = (d: SessionDraft) =>
    (filter.source === null || d.row.source?.slug === filter.source) && (filter.mode === "all" || d.row.mode === filter.mode);
  const keepLog = (l: FeedStudyLogRow) => filter.mode === "all" && (filter.source === null || l.source?.slug === filter.source);

  interface Bucket {
    activity: { key: number; entry: FeedSessionEntry | FeedStudyEntry }[];
    insights: { key: number; entry: FeedInsightEntry }[];
    words: { key: number; label: string; entry: FeedWordsEntry }[];
    hasMiss: boolean;
  }
  const buckets = new Map<string, Bucket>();
  const bucket = (day: string): Bucket => {
    let b = buckets.get(day);
    if (!b) {
      b = { activity: [], insights: [], words: [], hasMiss: false };
      buckets.set(day, b);
    }
    return b;
  };

  for (const d of sessions.values()) {
    if (!keepSession(d)) continue;
    const b = bucket(d.day);
    b.activity.push({ key: sortKey(d.row.takenAt, d.row.createdAt), entry: d.entry });
    if (d.hasMiss) b.hasMiss = true;
  }
  for (const { row: l, day } of logs) {
    if (!keepLog(l)) continue;
    bucket(day).activity.push({
      key: sortKey(l.takenAt, l.createdAt),
      entry: {
        kind: "study",
        id: l.id,
        source: l.source,
        activity: l.activity,
        minutes: l.minutes,
        note: clean(l.note),
        time: clockTime(l.takenAt, tz),
      },
    });
  }
  if (!narrowed) {
    for (const { row: i, day } of insightRows) {
      bucket(day).insights.push({
        key: i.createdAt.getTime(),
        entry: { kind: "insight", id: i.id, text: i.text.trim(), tags: i.tags, items: toTags(i.items), time: clockTime(i.createdAt, tz) },
      });
    }
    for (const g of loose.values()) {
      bucket(g.day).words.push({ key: g.first, label: g.label ?? "", entry: { kind: "words", label: g.label, words: g.words } });
    }
  }

  const days: FeedDay[] = [];
  for (const [day, b] of buckets) {
    if (filter.missesOnly && !b.hasMiss) continue;
    b.activity.sort((x, y) => x.key - y.key);
    b.insights.sort((x, y) => x.key - y.key);
    b.words.sort((x, y) => x.key - y.key || x.label.localeCompare(y.label));
    const entries: FeedEntry[] = [...b.activity.map((a) => a.entry), ...b.insights.map((i) => i.entry), ...b.words.map((x) => x.entry)];
    if (entries.length === 0) continue;
    days.push({ day, entries, summary: summarize(entries) });
  }
  days.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));

  const sources = [...sourceMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { window: w, today, filter, days, sources, windowHasRows, older: opts.older ?? null };
}

export function summarize(entries: FeedEntry[]): FeedDaySummary {
  const s: FeedDaySummary = { sessions: 0, graded: 0, misses: 0, closedBook: null, words: 0, minutes: 0, insights: 0 };
  const words = new Set<string>();
  for (const e of entries) {
    if (e.kind === "session") {
      s.sessions += 1;
      s.graded += e.score.graded;
      s.misses += e.misses.length;
      if (e.mode === "practice" && e.score.graded > 0) {
        const cb = s.closedBook ?? { correct: 0, graded: 0 };
        cb.correct += e.score.correct;
        cb.graded += e.score.graded;
        s.closedBook = cb;
      }
      for (const word of e.words) words.add(word.id);
    } else if (e.kind === "study") {
      s.minutes += e.minutes ?? 0;
    } else if (e.kind === "insight") {
      s.insights += 1;
    } else {
      for (const word of e.words) words.add(word.id);
    }
  }
  s.words = words.size;
  return s;
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();
/** The zone's UTC offset at an instant, in ms (Pacific: -7 h or -8 h). */
function zoneOffsetMs(at: Date, timeZone: string): number {
  let f = offsetFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    offsetFormatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant a calendar day starts in the zone (2026-11-12 -> 2026-11-12T08:00:00Z in Pacific). */
export function zoneDayStart(day: string, timeZone: string = FEED_TIME_ZONE): Date {
  const midnightUtc = Date.parse(`${day}T00:00:00.000Z`);
  let at = midnightUtc - zoneOffsetMs(new Date(midnightUtc), timeZone);
  // A DST change between UTC midnight and local midnight moves the offset; settle on the one at the answer.
  at = midnightUtc - zoneOffsetMs(new Date(at), timeZone);
  return new Date(at);
}

/**
 * Upper bounds for the "is there anything older?" query: a bare date is older than the window
 * when it sits before the window's first UTC midnight; a real time when it sits before the
 * window's first day starts in the learner's zone. Every instant under these bounds lands on
 * a day before the window, so the newest of each kind decides the older link.
 */
export function olderBounds(w: FeedWindow, timeZone: string = FEED_TIME_ZONE): { bareBefore: Date; timedBefore: Date } {
  return { bareBefore: new Date(`${w.from}T00:00:00.000Z`), timedBefore: zoneDayStart(w.from, timeZone) };
}

/**
 * The day the "older" link should end on: the newest day with activity before the window,
 * from candidate instants (the newest bare date and the newest real time under olderBounds),
 * or null when there is none.
 */
export function olderDay(candidates: (Date | null)[], w: FeedWindow, timeZone: string = FEED_TIME_ZONE): string | null {
  let best: string | null = null;
  for (const at of candidates) {
    if (!at || Number.isNaN(at.getTime())) continue;
    const day = feedDay(at, timeZone);
    if (day < w.from && (best === null || day > best)) best = day;
  }
  return best;
}
