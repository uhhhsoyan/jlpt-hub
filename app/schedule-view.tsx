"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const STORE_KEY = "n4-schedule-v2";
const START = new Date(2026, 6, 13); // Mon Jul 13, 2026 (local)
const EXAM = new Date(2026, 11, 6); // Sun Dec 6, 2026
const TOTAL = 21;
const GENKI_WEEKS = 16; // Genki ch 8 .. ch 23
const MS_DAY = 86_400_000;

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Phase = "new" | "review" | "exam";

interface Week {
  idx: number;
  no: number;
  start: Date;
  end: Date;
  level: number;
  newLevel: boolean;
  phase: Phase;
  title: string;
  detail: string;
  listen: string | null;
  wkNote: string | null;
  milestones: string[];
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function midnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function fmt(d: Date): string {
  return `${MON[d.getMonth()]} ${d.getDate()}`;
}

function buildWeeks(): Week[] {
  const reviews: Record<number, { title: string; detail: string }> = {
    16: {
      title: "Full Genki review + diagnostic",
      detail:
        "Re-drill grammar across Genki I + II, then take the official 2012 practice workbook untimed as a diagnostic — mark every weak spot.",
    },
    17: {
      title: "Mock exam #1 (timed) + fixes",
      detail:
        "Full official 2012 workbook under real timing (25 + 55 + 35 min). Score against 90 / 38 / 19, then review every wrong answer. Listening is the priority.",
    },
    18: {
      title: "Mock exam #2 + listening blitz",
      detail:
        "Full official 2018 workbook under timing. Compare to mock #1. Daily listening on 問題3 発話表現 & 問題4 即時応答 (audio-only formats).",
    },
    19: {
      title: "Final review + strategy",
      detail:
        "Keep it light. Timing/strategy, kanji readings, listen every day. Confirm test-day logistics (photo ID, voucher, SF State location).",
    },
  };

  const weeks: Week[] = [];
  for (let i = 0; i < TOTAL; i++) {
    const start = addDays(START, i * 7);
    const w: Week = {
      idx: i,
      no: i + 1,
      start,
      end: addDays(start, 6),
      level: 11 + Math.floor(i / 2),
      newLevel: i % 2 === 0,
      phase: i < GENKI_WEEKS ? "new" : i < 20 ? "review" : "exam",
      title: "",
      detail: "",
      listen: null,
      wkNote: null,
      milestones: [],
    };

    if (i < GENKI_WEEKS) {
      const ch = 8 + i;
      w.title = `Genki Lesson ${ch}`;
      w.detail = `Grammar + vocabulary for Lesson ${ch}, and Workbook Lesson ${ch}.`;
      w.listen = `🎧 Listening: Genki L${ch} dialogues with audio, plus one easy episode (Comprehensible Japanese / Nihongo con Teppei).`;
    } else if (i < 20) {
      w.title = reviews[i].title;
      w.detail = reviews[i].detail;
    } else {
      w.title = "🎌 EXAM WEEK — Sunday Dec 6";
      w.detail =
        "Taper Mon–Fri (light review, a few sample questions). Rest Saturday. Sunday: exam. Bring photo ID + test voucher.";
    }

    if (w.newLevel && w.level === 13) w.wkNote = "≈ all N5 kanji covered";
    if (w.newLevel && w.level === 20) w.wkNote = "≈ most N4 kanji covered";
    weeks.push(w);
  }

  weeks[4].milestones.push("🎉 Genki I complete (ch 1–12)");
  weeks[15].milestones.push("🎉 Genki I + II complete — grammar base done");
  weeks[2].milestones.push("📋 AATJ posts 2026 test sites (~end of July) — watch aatj.org/jlpt-us");
  weeks[4].milestones.push("🎫 Registration opens (~mid-Aug) — register the day it opens; SF fills fast");
  weeks[9].milestones.push("⛔ Registration closes Sep 16 — do not miss it");
  return weeks;
}

const PHASE_LABEL: Record<Phase, string> = {
  new: "New material",
  review: "Review & mock",
  exam: "Exam week",
};
const PHASE_META: Record<Phase, { label: string; note: string }> = {
  new: { label: "New material", note: "Weeks 1–16" },
  review: { label: "Review & mock exams", note: "Weeks 17–20" },
  exam: { label: "Exam", note: "Week 21" },
};

export function ScheduleView() {
  const weeks = useMemo(() => buildWeeks(), []);
  const [now, setNow] = useState<Date | null>(null);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [view, setView] = useState<"week" | "all">("week");
  // null = follow the current week; a number = the user navigated to a specific week.
  const [focusOverride, setFocusOverride] = useState<number | null>(null);

  // Date + persisted state are client-only; read them after mount to avoid a
  // server/client hydration mismatch.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(new Date());
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) setChecks(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }, []);

  const curIdx = now ? Math.floor((+midnight(now) - +midnight(START)) / (MS_DAY * 7)) : -1;
  const inRange = curIdx >= 0 && curIdx <= TOTAL - 1;
  const focusIdx = focusOverride ?? (inRange ? curIdx : 0);

  function toggle(key: string) {
    setChecks((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }
  function reset() {
    if (!confirm("Clear all checked items?")) return;
    setChecks({});
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {
      /* ignore */
    }
  }

  const isWeekDone = (w: Week) =>
    !!checks[`g${w.idx}`] && (!w.newLevel || !!checks[`w${w.level}`]);

  const genkiDone = weeks.slice(0, GENKI_WEEKS).filter((w) => checks[`g${w.idx}`]).length;
  let wkCurrent = 10;
  for (let L = 11; L <= 20; L++) if (checks[`w${L}`] && L > wkCurrent) wkCurrent = L;
  const wkLevelsHit = Array.from({ length: 10 }, (_, i) => 11 + i).filter((L) => checks[`w${L}`]).length;
  const daysLeft = now ? Math.max(0, Math.ceil((+midnight(EXAM) - +midnight(now)) / MS_DAY)) : null;

  return (
    <div className="flex flex-col gap-5">
      {/* Header + stats */}
      <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-bold tracking-tight">JLPT N4 — Study Schedule</h1>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              Genki lessons · WaniKani levels <span className="text-neutral-400">· 十二月六日まで</span>
            </p>
          </div>
          <div className="rounded-xl bg-indigo-50 px-4 py-2 text-right dark:bg-indigo-950/50">
            <div className="text-2xl font-bold leading-none text-indigo-600 dark:text-indigo-300">
              {daysLeft ?? "—"}
            </div>
            <div className="text-[11px] uppercase tracking-wide text-neutral-500">days to Dec 6</div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Tile label="This week">
            {!now ? "—" : inRange ? `Week ${curIdx + 1} of ${TOTAL}` : curIdx < 0 ? `Starts ${fmt(START)}` : "Exam passed"}
          </Tile>
          <Tile label="Genki lessons">
            <span className="font-semibold">{genkiDone}</span>
            <span className="text-neutral-400"> / 16 done</span>
            <Bar value={genkiDone / GENKI_WEEKS} />
          </Tile>
          <Tile label="WaniKani">
            Lv <span className="font-semibold">{wkCurrent < 11 ? 11 : wkCurrent}</span>
            <span className="text-neutral-400"> / 20 target</span>
            <Bar value={wkLevelsHit / 10} />
          </Tile>
        </div>
      </div>

      {/* Sub-view toggle */}
      <div className="flex items-center justify-between">
        <div className="inline-flex gap-1 rounded-xl border border-neutral-200 bg-neutral-100 p-1 dark:border-neutral-800 dark:bg-neutral-900">
          {(["week", "all"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                view === v
                  ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-white"
                  : "text-neutral-500"
              }`}
            >
              {v === "week" ? "This week" : "All weeks"}
            </button>
          ))}
        </div>
        <button onClick={reset} className="text-xs text-neutral-400 transition hover:text-neutral-600">
          Reset progress
        </button>
      </div>

      {view === "week" ? (
        <FocusCard
          weeks={weeks}
          focusIdx={focusIdx}
          setFocus={setFocusOverride}
          curIdx={curIdx}
          inRange={inRange}
          checks={checks}
          toggle={toggle}
        />
      ) : (
        <AllWeeks weeks={weeks} curIdx={curIdx} checks={checks} toggle={toggle} isWeekDone={isWeekDone} />
      )}
    </div>
  );
}

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-neutral-50 px-3 py-2.5 dark:bg-neutral-800/50">
      <div className="text-[11px] uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 text-[15px]">{children}</div>
    </div>
  );
}
function Bar({ value }: { value: number }) {
  return (
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
      <div
        className="h-full rounded-full bg-emerald-500 transition-all"
        style={{ width: `${Math.round(value * 100)}%` }}
      />
    </div>
  );
}

function TaskRow({
  checked,
  onToggle,
  title,
  detail,
  accent = "indigo",
}: {
  checked: boolean;
  onToggle: () => void;
  title: string;
  detail?: string;
  accent?: "indigo" | "emerald";
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-800/40">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className={`mt-0.5 size-4 shrink-0 ${accent === "emerald" ? "accent-emerald-600" : "accent-indigo-600"}`}
      />
      <span>
        <span className={`font-semibold ${checked ? "text-neutral-400 line-through" : ""}`}>{title}</span>
        {detail && <span className="mt-0.5 block text-sm text-neutral-500 dark:text-neutral-400">{detail}</span>}
      </span>
    </label>
  );
}

function FocusCard({
  weeks,
  focusIdx,
  setFocus,
  curIdx,
  inRange,
  checks,
  toggle,
}: {
  weeks: Week[];
  focusIdx: number;
  setFocus: (n: number | null) => void;
  curIdx: number;
  inRange: boolean;
  checks: Record<string, boolean>;
  toggle: (k: string) => void;
}) {
  const w = weeks[focusIdx];
  const isNow = focusIdx === curIdx;
  const next = focusIdx < TOTAL - 1 ? weeks[focusIdx + 1] : null;

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-center justify-between">
        <span
          className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${
            w.phase === "exam"
              ? "bg-indigo-600 text-white"
              : w.phase === "review"
                ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                : "bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300"
          }`}
        >
          {PHASE_LABEL[w.phase]}
        </span>
        <div className="flex gap-2">
          <NavBtn disabled={focusIdx === 0} onClick={() => setFocus(focusIdx - 1)}>
            ‹
          </NavBtn>
          <NavBtn disabled={focusIdx === TOTAL - 1} onClick={() => setFocus(focusIdx + 1)}>
            ›
          </NavBtn>
        </div>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-2xl font-bold tracking-tight">Week {w.no}</span>
        <span className="text-sm text-neutral-500">
          {fmt(w.start)} – {fmt(w.end)} · of {TOTAL}
        </span>
        {isNow && (
          <span className="rounded-full bg-emerald-500 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">
            this week
          </span>
        )}
      </div>

      {!isNow && inRange && (
        <button
          onClick={() => setFocus(null)}
          className="-mt-1 self-start text-sm font-semibold text-indigo-600 dark:text-indigo-400"
        >
          ← back to this week (Week {curIdx + 1})
        </button>
      )}

      <div className="flex flex-col gap-3">
        <TaskRow
          checked={!!checks[`g${w.idx}`]}
          onToggle={() => toggle(`g${w.idx}`)}
          title={w.title}
          detail={w.detail}
        />
        {w.newLevel ? (
          <TaskRow
            accent="emerald"
            checked={!!checks[`w${w.level}`]}
            onToggle={() => toggle(`w${w.level}`)}
            title={`Reach WaniKani Lv ${w.level}`}
            detail={w.wkNote ?? undefined}
          />
        ) : (
          <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-800/40">
            <span className="font-semibold text-neutral-600 dark:text-neutral-300">
              WaniKani Lv {w.level} — keep reviews clear
            </span>
            <span className="mt-0.5 block">Consolidation week; next level-up lands next week.</span>
          </div>
        )}
      </div>

      {w.milestones.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-xl bg-amber-50 p-3 text-sm font-semibold text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          {w.milestones.map((m, i) => (
            <span key={i}>{m}</span>
          ))}
        </div>
      )}

      {w.listen && (
        <p className="rounded-xl bg-indigo-50 p-3 text-sm text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300">
          {w.listen}
        </p>
      )}

      {next && (
        <div className="rounded-xl border border-dashed border-neutral-300 p-3 text-sm text-neutral-500 dark:border-neutral-700">
          Up next → <b className="text-neutral-700 dark:text-neutral-200">Week {next.no}</b> ·{" "}
          {fmt(next.start)}–{fmt(next.end)} · {next.title}
        </div>
      )}
    </div>
  );
}

function NavBtn({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex size-8 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-lg leading-none transition hover:border-indigo-500 hover:text-indigo-600 disabled:opacity-30 disabled:hover:border-neutral-200 disabled:hover:text-inherit dark:border-neutral-700 dark:bg-neutral-800"
    >
      {children}
    </button>
  );
}

function AllWeeks({
  weeks,
  curIdx,
  checks,
  toggle,
  isWeekDone,
}: {
  weeks: Week[];
  curIdx: number;
  checks: Record<string, boolean>;
  toggle: (k: string) => void;
  isWeekDone: (w: Week) => boolean;
}) {
  const nowRef = useRef<HTMLDivElement | null>(null);

  return (
    <div className="flex flex-col gap-2">
      {curIdx >= 0 && curIdx <= TOTAL - 1 && (
        <button
          onClick={() => nowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })}
          className="self-end text-xs font-semibold text-indigo-600 dark:text-indigo-400"
        >
          Jump to this week ↓
        </button>
      )}
      {weeks.map((w, i) => {
        const header = i === 0 || weeks[i - 1].phase !== w.phase ? PHASE_META[w.phase] : null;
        const isNow = w.idx === curIdx;
        const done = isWeekDone(w);
        return (
          <div key={w.idx} className="flex flex-col gap-2">
            {header && (
              <div className="mt-3 flex items-baseline gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-400">
                  {header.label}
                </h3>
                <span className="text-xs text-neutral-400">{header.note}</span>
                <span className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
              </div>
            )}
            <div
              ref={isNow ? nowRef : undefined}
              className={`grid grid-cols-[3rem_1fr] gap-3 rounded-xl border bg-white p-3.5 dark:bg-neutral-900 ${
                isNow
                  ? "border-indigo-500 ring-1 ring-indigo-500"
                  : "border-neutral-200 dark:border-neutral-800"
              } ${done ? "opacity-60" : ""}`}
            >
              <div className="text-center">
                <div className="text-lg font-bold leading-none">{w.no}</div>
                <div className="text-[10px] uppercase tracking-wide text-neutral-400">week</div>
                <div className="mt-1 text-[10px] text-neutral-500">
                  {fmt(w.start)}–{fmt(w.end)}
                </div>
                {isNow && (
                  <div className="mt-1.5 rounded-full bg-indigo-600 px-1.5 py-0.5 text-[9px] font-bold uppercase text-white">
                    now
                  </div>
                )}
              </div>
              <div className="min-w-0">
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    checked={!!checks[`g${w.idx}`]}
                    onChange={() => toggle(`g${w.idx}`)}
                    className="mt-0.5 size-4 shrink-0 accent-indigo-600"
                  />
                  <span>
                    <span className={`font-semibold ${checks[`g${w.idx}`] ? "text-neutral-400 line-through" : ""}`}>
                      {w.title}
                    </span>
                    <span className="mt-0.5 block text-sm text-neutral-500 dark:text-neutral-400">{w.detail}</span>
                  </span>
                </label>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {w.newLevel ? (
                    <label
                      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2 py-1 text-xs ${
                        checks[`w${w.level}`]
                          ? "border-emerald-500 bg-emerald-50 font-semibold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                          : "border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-neutral-700 dark:bg-neutral-800"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={!!checks[`w${w.level}`]}
                        onChange={() => toggle(`w${w.level}`)}
                        className="size-3.5 accent-emerald-600"
                      />
                      Reach WaniKani Lv {w.level}
                    </label>
                  ) : (
                    <span className="rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs text-neutral-500 dark:border-neutral-700 dark:bg-neutral-800">
                      WaniKani Lv {w.level} — consolidate
                    </span>
                  )}
                  {w.wkNote && (
                    <span className="rounded-lg bg-indigo-50 px-2 py-1 text-xs text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300">
                      {w.wkNote}
                    </span>
                  )}
                  {w.milestones.map((m, i) => (
                    <span
                      key={i}
                      className="rounded-lg bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                    >
                      {m}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
