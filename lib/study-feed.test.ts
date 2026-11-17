import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  assembleStudyFeed,
  clockTime,
  dayDiff,
  dayParts,
  feedDay,
  feedWindow,
  isDateOnly,
  isPlainRecord,
  olderBounds,
  olderDay,
  parseDay,
  parseFeedFilter,
  windowBounds,
  zoneDayStart,
  type FeedInsightRow,
  type FeedQuestionRow,
  type FeedQueueRow,
  type FeedRows,
  type FeedSessionEntry,
  type FeedSessionRow,
  type FeedSource,
  type FeedStudyLogRow,
  type FeedWordsEntry,
} from "./study-feed.ts";

const SKM: FeedSource = { slug: "skm-n4-bunpou", name: "Shin Kanzen Master N4 Grammar", nameJa: "新完全マスター文法 N4", color: "#be123c", imageUrl: null };
const MON: FeedSource = { slug: "shin-nihongo-500-mon-n4-n5", name: "Shin Nihongo 500 Mon", nameJa: null, color: null, imageUrl: null };
const SATORI: FeedSource = { slug: "satori-reader", name: "Satori Reader", nameJa: null, color: null, imageUrl: null };

const bare = (day: string) => new Date(`${day}T00:00:00.000Z`);
const utc = (iso: string) => new Date(iso);

const session = (id: string, day: string, extra: Partial<FeedSessionRow> = {}): FeedSessionRow => ({
  id,
  label: id,
  sourceName: null,
  mode: "lesson",
  status: "confirmed",
  timed: null,
  takenAt: bare(day),
  createdAt: utc(`${day}T20:00:00.000Z`),
  source: SKM,
  ...extra,
});

const q = (sessionId: string, number: number, isCorrect: boolean | null, extra: Partial<FeedQuestionRow> = {}): FeedQuestionRow => ({
  sessionId,
  number,
  isCorrect,
  rootCause: null,
  note: null,
  tags: [],
  meta: null,
  stem: null,
  ...extra,
});

const insight = (id: string, createdAt: string, extra: Partial<FeedInsightRow> = {}): FeedInsightRow => ({
  id,
  text: `insight ${id}`,
  tags: [],
  items: [],
  createdAt: utc(createdAt),
  ...extra,
});

const word = (id: string, text: string, sightings: FeedQueueRow["sightings"], reading: string | null = null): FeedQueueRow => ({ id, text, reading, sightings });
const sighting = (at: string, sessionId: string | null, label: string | null) => ({ at, context: null, sessionId, questionId: null, label });

const log = (id: string, takenAt: Date, extra: Partial<FeedStudyLogRow> = {}): FeedStudyLogRow => ({
  id,
  activity: "reading",
  minutes: 30,
  note: null,
  takenAt,
  createdAt: utc("2026-11-12T23:00:00.000Z"),
  source: SATORI,
  ...extra,
});

const rows = (r: Partial<FeedRows>): FeedRows => ({ sessions: [], questions: [], studyLogs: [], insights: [], queue: [], ...r });

const TODAY = "2026-11-17";
const W = feedWindow(null, TODAY);
const assemble = (r: Partial<FeedRows>, filter?: Parameters<typeof assembleStudyFeed>[1]["filter"]) =>
  assembleStudyFeed(rows(r), { window: W, today: TODAY, filter });

const sessionsOf = (feed: ReturnType<typeof assemble>, day: string) =>
  (feed.days.find((d) => d.day === day)?.entries ?? []).filter((e): e is FeedSessionEntry => e.kind === "session");

// ---- dates ----------------------------------------------------------------------------------

test("bare dates stay on their UTC date; real times bucket by Pacific date", () => {
  assert.equal(isDateOnly(bare("2026-11-12")), true);
  assert.equal(isDateOnly(utc("2026-11-12T00:00:00.001Z")), false);
  assert.equal(feedDay(bare("2026-11-12")), "2026-11-12");
  // 8:24 pm Pacific on Nov 16 is 04:24Z on Nov 17.
  assert.equal(feedDay(utc("2026-11-17T04:24:38.826Z")), "2026-11-16");
  assert.equal(feedDay(utc("2026-11-12T20:00:00.000Z")), "2026-11-12");
  // Summer (PDT, -7): 06:30Z on Jul 1 is 11:30 pm on Jun 30.
  assert.equal(feedDay(utc("2026-07-01T06:30:00.000Z")), "2026-06-30");
  assert.equal(feedDay(utc("2026-07-01T07:30:00.000Z")), "2026-07-01");
});

test("clock time is shown only for real times", () => {
  assert.equal(clockTime(bare("2026-11-12")), null);
  assert.equal(clockTime(utc("2026-11-17T04:24:38.826Z")), "8:24 pm");
  assert.equal(clockTime(utc("2026-11-12T16:43:00.000Z")), "8:43 am");
});

test("day helpers", () => {
  assert.equal(parseDay("2026-11-12"), "2026-11-12");
  assert.equal(parseDay(" 2026-11-12 "), "2026-11-12");
  assert.equal(parseDay("2026-02-30"), null);
  assert.equal(parseDay("nov 12"), null);
  assert.equal(parseDay(undefined), null);
  assert.equal(addDays("2026-11-30", 1), "2026-12-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(dayDiff("2026-11-17", "2026-12-06"), 19);
  assert.deepEqual(dayParts("2026-11-12"), { weekday: "Thursday", date: "Nov 12" });
});

test("the window ends today unless an earlier valid day is asked for", () => {
  assert.deepEqual(feedWindow(null, TODAY), { from: "2026-11-04", to: "2026-11-17" });
  assert.deepEqual(feedWindow("2026-11-03", TODAY), { from: "2026-10-21", to: "2026-11-03" });
  assert.deepEqual(feedWindow("2027-01-01", TODAY), { from: "2026-11-04", to: "2026-11-17" });
  assert.deepEqual(feedWindow("garbage", TODAY), { from: "2026-11-04", to: "2026-11-17" });
  assert.deepEqual(feedWindow(null, TODAY, 1), { from: TODAY, to: TODAY });
  const { start, end } = windowBounds({ from: "2026-11-04", to: "2026-11-17" });
  assert.equal(start.toISOString(), "2026-11-04T00:00:00.000Z");
  // Late evening Pacific on the last day (08:00Z the day after) is inside.
  assert.ok(utc("2026-11-18T07:59:00.000Z") < end);
});

test("zone day start follows daylight saving", () => {
  assert.equal(zoneDayStart("2026-11-12").toISOString(), "2026-11-12T08:00:00.000Z");
  assert.equal(zoneDayStart("2026-07-01").toISOString(), "2026-07-01T07:00:00.000Z");
  // DST ends 2026-11-01 at 2 am: the day still starts on PDT.
  assert.equal(zoneDayStart("2026-11-01").toISOString(), "2026-11-01T07:00:00.000Z");
  // DST starts 2026-03-08 at 2 am: the day starts on PST.
  assert.equal(zoneDayStart("2026-03-08").toISOString(), "2026-03-08T08:00:00.000Z");
});

test("older day: the newest bare date or real time before the window", () => {
  const w = { from: "2026-11-04", to: "2026-11-17" };
  const { bareBefore, timedBefore } = olderBounds(w);
  assert.equal(bareBefore.toISOString(), "2026-11-04T00:00:00.000Z");
  assert.equal(timedBefore.toISOString(), "2026-11-04T08:00:00.000Z");
  assert.equal(olderDay([bare("2026-11-03"), utc("2026-11-04T04:10:00.000Z")], w), "2026-11-03");
  assert.equal(olderDay([bare("2026-10-30"), null], w), "2026-10-30");
  assert.equal(olderDay([null, null], w), null);
  assert.equal(olderDay([], w), null);
});

test("plain records on right answers are not slips", () => {
  for (const note of ["Correct.", "correct", "やすみなので — correct.", "よさそう — correct (いい exception).", "Right."]) {
    assert.equal(isPlainRecord(note), true, note);
  }
  for (const note of [
    "Correct; じゅんび rendered as 'planning' (preparation).",
    "a わかりました — correct; ので cannot be followed by ありがとう.",
    "Correct after hesitating over three に (time, destination, purpose); むかえる read right.",
    "Right but unsure: did not see the relative clause",
    "使いたい人に: buyer marked with に",
  ]) {
    assert.equal(isPlainRecord(note), false, note);
  }
});

test("filters parse from search params, rejecting junk", () => {
  assert.deepEqual(parseFeedFilter({}), { source: null, mode: "all", missesOnly: false });
  assert.deepEqual(parseFeedFilter({ source: "skm-n4-bunpou", mode: "practice", misses: "1" }), {
    source: "skm-n4-bunpou",
    mode: "practice",
    missesOnly: true,
  });
  assert.deepEqual(parseFeedFilter({ source: "<script>", mode: "closed", misses: "yes" }), { source: null, mode: "all", missesOnly: false });
  assert.deepEqual(parseFeedFilter({ source: ["skm-n4-bunpou", "x"], mode: ["lesson"] }).mode, "lesson");
});

// ---- assembly ---------------------------------------------------------------------------------

test("empty input gives an empty feed", () => {
  const feed = assemble({});
  assert.deepEqual(feed.days, []);
  assert.equal(feed.windowHasRows, false);
  assert.deepEqual(feed.sources, []);
  assert.equal(feed.older, null);
});

test("a session's findings: misses with labels, slips, not attempted, score", () => {
  const feed = assemble({
    sessions: [session("l12", "2026-11-12", { label: "SKM N4 L12 れんしゅう2", sourceName: " 実力養成編 第1部 12課 れんしゅう2 " })],
    questions: [
      q("l12", 8, false, { rootCause: "pattern-choice", note: "picked はずだよ, needed かもしれないよ", stem: "けがを する（　）。", tags: [{ kind: "grammar", text: "〜かもしれない", itemId: "i1" }, { kind: "grammar", text: "〜はずだ", itemId: null }] }),
      q("l12", 7, false, { meta: { questionPart: 2 } }),
      q("l12", 7, true, { meta: { questionPart: 1 }, note: "Correct." }),
      q("l12", 2, true, { note: "right; read 来ると as 'if he comes'" }),
      q("l12", 3, true, { meta: { slips: [{ kind: "vocab-misread", text: "read 時 as 時間" }] } }),
      q("l12", 4, null, { note: "ran out of time" }),
      q("l12", 5, null),
    ],
  });
  const [s] = sessionsOf(feed, "2026-11-12");
  assert.equal(s.sourceName, "実力養成編 第1部 12課 れんしゅう2");
  assert.deepEqual(s.score, { correct: 3, graded: 5, notAttempted: 2, questions: 7 });
  assert.deepEqual(s.misses.map((m) => m.label), ["7②", "8"]);
  assert.deepEqual(s.misses[1], {
    label: "8",
    rootCause: "pattern-choice",
    note: "picked はずだよ, needed かもしれないよ",
    tags: [{ text: "〜かもしれない", linked: true }, { text: "〜はずだ", linked: false }],
    stem: "けがを する（　）。",
    slips: [],
  });
  // 7① is right with a plain record: not shown. 2 and 3 are slips; 4 is a skipped attempt with a note.
  assert.deepEqual(
    s.noted.map((n) => [n.label, n.kind, n.note, n.slips.length]),
    [
      ["2", "slip", "right; read 来ると as 'if he comes'", 0],
      ["3", "slip", null, 1],
      ["4", "skipped", "ran out of time", 0],
    ],
  );
  assert.equal(s.compact, false);
  assert.equal(s.time, null);
});

test("a clean session, and one with no graded attempts, collapse", () => {
  const feed = assemble({
    sessions: [session("clean", "2026-11-14"), session("empty", "2026-11-14", { createdAt: utc("2026-11-14T21:00:00.000Z") })],
    questions: [q("clean", 1, true), q("clean", 2, true, { note: "b 楽しそうに — correct." })],
  });
  const [clean, empty] = sessionsOf(feed, "2026-11-14");
  assert.equal(clean.compact, true);
  assert.deepEqual(clean.score, { correct: 2, graded: 2, notAttempted: 0, questions: 2 });
  assert.equal(empty.compact, true);
  assert.deepEqual(empty.score, { correct: 0, graded: 0, notAttempted: 0, questions: 0 });
});

test("a session spanning days via done_on stays on its own date with a hint", () => {
  const feed = assemble({
    sessions: [session("l12ex", "2026-11-12")],
    questions: [q("l12ex", 1, false, { meta: { done_on: "2026-11-11" } }), q("l12ex", 2, true, { meta: { done_on: "2026-11-12" } }), q("l12ex", 3, true, { meta: { done_on: "bogus" } })],
  });
  assert.deepEqual(feed.days.map((d) => d.day), ["2026-11-12"]);
  assert.deepEqual(sessionsOf(feed, "2026-11-12")[0].alsoDoneOn, ["2026-11-11"]);
});

test("queued words attach to their session by id, or by a same-day label; others stay loose", () => {
  const feed = assemble({
    sessions: [session("s1", "2026-11-13", { label: "SKM N4 L13 れんしゅう2" })],
    queue: [
      word("w1", "急ぐ", [sighting("2026-11-13T00:00:00.000Z", "s1", "SKM N4 L13 れんしゅう2")], "いそぐ"),
      word("w2", "遅れる", [sighting("2026-11-13T00:00:00.000Z", null, "skm n4 l13 れんしゅう2")]),
      word("w3", "もし", [sighting("2026-11-13T00:00:00.000Z", null, "SKM N4 L14 explanation")]),
      word("w4", "片付ける", [sighting("2026-11-13T00:00:00.000Z", null, "SKM N4 L14 explanation")]),
      // Tied to a session outside the window: shown loose on the sighting's day.
      word("w5", "鍋", [sighting("2026-11-13T00:00:00.000Z", "old-session", "SKM N4 L3")]),
      // A sighting before the window is dropped; a repeat sighting of w1 on the same session does not duplicate.
      word("w6", "古い", [sighting("2026-10-01T00:00:00.000Z", null, "old")]),
      word("w1b", "急ぐ", [sighting("2026-11-13T00:00:00.000Z", "s1", null), sighting("2026-11-14T00:00:00.000Z", "s1", null)]),
    ],
  });
  const day = feed.days.find((d) => d.day === "2026-11-13");
  assert.ok(day);
  const s = day.entries[0] as FeedSessionEntry;
  assert.deepEqual(s.words.map((w) => w.text), ["急ぐ", "遅れる", "急ぐ"]);
  assert.equal(s.words[0].reading, "いそぐ");
  const loose = day.entries.filter((e): e is FeedWordsEntry => e.kind === "words");
  assert.deepEqual(loose.map((g) => [g.label, g.words.map((w) => w.text)]), [
    ["SKM N4 L14 explanation", ["もし", "片付ける"]],
    ["SKM N4 L3", ["鍋"]],
  ]);
  assert.equal(day.summary.words, 6);
  assert.equal(feed.days.length, 1);
});

test("an insight on a day with no session gets its own day, on the Pacific date", () => {
  const feed = assemble({
    sessions: [session("s1", "2026-11-15", { mode: "practice" })],
    insights: [insight("i1", "2026-11-17T04:24:38.826Z", { tags: ["lookalike"], items: [{ kind: "grammar", text: "〜ないで", itemId: "x" }, { kind: "grammar", text: "〜ないと", itemId: null }] })],
  });
  assert.deepEqual(feed.days.map((d) => d.day), ["2026-11-16", "2026-11-15"]);
  const [entry] = feed.days[0].entries;
  assert.equal(entry.kind, "insight");
  if (entry.kind === "insight") {
    assert.equal(entry.time, "8:24 pm");
    assert.deepEqual(entry.items, [{ text: "〜ないで", linked: true }, { text: "〜ないと", linked: false }]);
  }
  assert.equal(feed.days[0].summary.insights, 1);
});

test("within a day: activity in logged order (real times win), then insights, then loose words", () => {
  const feed = assemble({
    sessions: [
      session("r2", "2026-11-12", { createdAt: utc("2026-11-12T23:32:00.000Z") }),
      session("ex", "2026-11-12", { createdAt: utc("2026-11-12T16:58:00.000Z") }),
      session("r1", "2026-11-12", { createdAt: utc("2026-11-12T23:10:00.000Z") }),
    ],
    studyLogs: [log("read", utc("2026-11-12T22:00:00.000Z"))],
    insights: [insight("late", "2026-11-12T23:40:00.000Z"), insight("early", "2026-11-12T16:43:00.000Z")],
    queue: [word("w", "匂い", [sighting("2026-11-12T00:00:00.000Z", null, "chat")])],
  });
  const ids = feed.days[0].entries.map((e) => (e.kind === "words" ? `words:${e.label}` : e.id));
  assert.deepEqual(ids, ["ex", "read", "r1", "r2", "early", "late", "words:chat"]);
});

test("days are newest first and rows outside the window drop out", () => {
  const feed = assemble({
    sessions: [session("a", "2026-11-04"), session("b", "2026-11-17"), session("c", "2026-11-03"), session("d", "2026-11-18")],
    // 03:00Z on Nov 4 is the evening of Nov 3 in Pacific: outside.
    insights: [insight("i", "2026-11-04T03:00:00.000Z")],
  });
  assert.deepEqual(feed.days.map((d) => d.day), ["2026-11-17", "2026-11-04"]);
});

test("day summary: closed-book score only, graded across all, minutes, distinct words", () => {
  const feed = assemble({
    sessions: [session("p", "2026-11-05", { mode: "practice", source: MON }), session("l", "2026-11-05")],
    questions: [q("p", 1, true), q("p", 2, false), q("p", 3, null), q("l", 1, false), q("l", 2, true)],
    studyLogs: [log("a", bare("2026-11-05"), { minutes: 20 }), log("b", bare("2026-11-05"), { minutes: null })],
    queue: [word("w", "やる", [sighting("2026-11-05T00:00:00.000Z", "p", null), sighting("2026-11-05T00:00:00.000Z", "l", null)])],
  });
  assert.deepEqual(feed.days[0].summary, {
    sessions: 2,
    graded: 4,
    misses: 2,
    closedBook: { correct: 1, graded: 2 },
    words: 1,
    minutes: 20,
    insights: 0,
  });
  const lessonOnly = assemble({ sessions: [session("l", "2026-11-05")], questions: [q("l", 1, true)] });
  assert.equal(lessonOnly.days[0].summary.closedBook, null);
});

test("a day with only a study log", () => {
  const feed = assemble({ studyLogs: [log("a", utc("2026-11-10T03:30:00.000Z"), { note: "NHK Easy" })] });
  assert.deepEqual(feed.days.map((d) => d.day), ["2026-11-09"]);
  assert.deepEqual(feed.days[0].entries[0], {
    kind: "study",
    id: "a",
    source: SATORI,
    activity: "reading",
    minutes: 30,
    note: "NHK Easy",
    time: "7:30 pm",
  });
  assert.equal(feed.days[0].summary.minutes, 30);
});

test("filters: mode and source narrow to sessions; misses-only keeps days with a miss", () => {
  const input: Partial<FeedRows> = {
    sessions: [
      session("p", "2026-11-05", { mode: "practice", source: MON }),
      session("l", "2026-11-12"),
      session("clean", "2026-11-14"),
    ],
    questions: [q("p", 1, false), q("l", 1, false), q("clean", 1, true)],
    studyLogs: [log("log", bare("2026-11-14"))],
    insights: [insight("i", "2026-11-12T20:00:00.000Z")],
    queue: [word("w", "もし", [sighting("2026-11-13T00:00:00.000Z", null, "chat")])],
  };
  const all = assemble(input);
  assert.deepEqual(all.days.map((d) => d.day), ["2026-11-14", "2026-11-13", "2026-11-12", "2026-11-05"]);
  assert.deepEqual(all.sources.map((s) => s.slug), ["satori-reader", "skm-n4-bunpou", "shin-nihongo-500-mon-n4-n5"]);

  const closed = assemble(input, { source: null, mode: "practice", missesOnly: false });
  assert.deepEqual(closed.days.map((d) => [d.day, d.entries.map((e) => e.kind)]), [["2026-11-05", ["session"]]]);
  assert.equal(closed.sources.length, 3, "the picker still lists every source in the window");

  const satori = assemble(input, { source: "satori-reader", mode: "all", missesOnly: false });
  assert.deepEqual(satori.days.map((d) => [d.day, d.entries.map((e) => (e.kind === "words" ? "" : e.id))]), [["2026-11-14", ["log"]]]);

  const misses = assemble(input, { source: null, mode: "all", missesOnly: true });
  assert.deepEqual(misses.days.map((d) => [d.day, d.entries.map((e) => e.kind)]), [
    ["2026-11-12", ["session", "insight"]],
    ["2026-11-05", ["session"]],
  ]);
  assert.equal(misses.windowHasRows, true);
});
