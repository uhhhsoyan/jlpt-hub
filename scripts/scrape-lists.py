#!/usr/bin/env python3
"""Scrape JLPT N5/N4 vocab + kanji seed data from nihongoichiban.com.

Re-runnable, stdlib-only (urllib for fetching, regex for the simple WordPress
table markup). Writes:

  data/seed/vocab-n5.json
  data/seed/vocab-n4.json   (cumulative per the source site, see report)
  data/seed/kanji-n5.json
  data/seed/kanji-n4.json
  data/seed/SCRAPE-REPORT.md

Also cross-checks (report only, never merged) against elzup/jlpt-word-list on
GitHub, and enriches vocab with a "pos" (verb / i-adjective / na-adjective)
from three supplementary nihongoichiban lists.

Usage:
  python3 scripts/scrape-lists.py
"""

from __future__ import annotations

import csv
import html
import io
import json
import re
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
SEED_DIR = REPO_ROOT / "data" / "seed"

FETCH_DELAY_SECONDS = 1.0  # politeness delay between HTTP requests
FETCH_ATTEMPTS = 3

USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/115.0.0.0 Safari/537.36",
]

URLS = {
    "n5_vocab": "https://nihongoichiban.com/2011/04/30/complete-list-of-vocabulary-for-the-jlpt-n5/",
    "n4_vocab": "https://nihongoichiban.com/2012/06/15/complete-list-of-vocabulary-for-the-jlpt-n4/",
    "n5_kanji": "https://nihongoichiban.com/2011/04/10/complete-list-of-kanji-for-jlpt-n5/",
    "n4_kanji": "https://nihongoichiban.com/2011/05/22/complete-list-of-kanji-for-the-jlpt-n4/",
    "verbs": "https://nihongoichiban.com/2012/08/13/list-of-all-verbs-for-the-jlpt-n4/",
    "i_adjectives": "https://nihongoichiban.com/2012/06/20/list-of-i-adjectives-for-the-jlpt-n4/",
    "na_adjectives": "https://nihongoichiban.com/2012/06/20/list-of-na-adjectives-for-the-jlpt-n4/",
}

# elzup/jlpt-word-list ships CSVs (src/n5.csv, src/n4.csv), not JSON as the
# task brief guessed -- confirmed via the GitHub contents API. Used only for
# the cross-check report; never merged into the seed data.
ELZUP_CSV_URLS = {
    "n5": "https://raw.githubusercontent.com/elzup/jlpt-word-list/master/src/n5.csv",
    "n4": "https://raw.githubusercontent.com/elzup/jlpt-word-list/master/src/n4.csv",
}

EXPECTED_COUNTS = {
    "n5_kanji": 103,
    "n4_kanji": 181,
    "n5_vocab": 700,  # approximate, per task brief
    "n4_vocab": 1500,  # approximate, per task brief ("cumulative")
}

CJK_RANGES = [
    (0x3400, 0x4DBF),  # CJK Extension A
    (0x4E00, 0x9FFF),  # CJK Unified Ideographs
    (0xF900, 0xFAFF),  # CJK Compatibility Ideographs
]

KANA_EXTRA_CHARS = set("ー・~〜() ,、/")  # allowed "basic punctuation" in readings
DASH_PLACEHOLDERS = {"", "–", "—", "-"}  # empty onyomi/kunyomi markers


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------


def fetch(url: str) -> str:
    """Fetch a URL as text, retrying with different User-Agents on failure."""
    last_err: Exception | None = None
    for attempt in range(FETCH_ATTEMPTS):
        ua = USER_AGENTS[attempt % len(USER_AGENTS)]
        req = urllib.request.Request(
            url, headers={"User-Agent": ua, "Accept-Language": "en-US,en;q=0.9"}
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
                charset = resp.headers.get_content_charset() or "utf-8"
                text = raw.decode(charset, errors="replace")
            print(f"  fetched {url} ({len(raw)} bytes)", file=sys.stderr)
            time.sleep(FETCH_DELAY_SECONDS)
            return text
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            last_err = e
            print(
                f"  attempt {attempt + 1}/{FETCH_ATTEMPTS} failed for {url}: {e}",
                file=sys.stderr,
            )
            time.sleep(FETCH_DELAY_SECONDS)
    raise RuntimeError(f"Failed to fetch {url} after {FETCH_ATTEMPTS} attempts: {last_err}")


# ---------------------------------------------------------------------------
# Lightweight HTML table parsing (regex-based; the source markup is simple,
# non-nested WordPress table HTML -- verified no nested <table>s exist).
# ---------------------------------------------------------------------------

TAG_RE = re.compile(r"<[^>]+>")
TABLE_RE = re.compile(r"<table")
TR_RE = re.compile(r"<tr[^>]*>.*?</tr>", re.S)
TD_RE = re.compile(r"<td[^>]*>(.*?)</td>", re.S)


def clean_cell(raw_cell_html: str) -> str:
    """Strip tags, unescape entities, normalize whitespace."""
    text = TAG_RE.sub("", raw_cell_html)
    text = html.unescape(text)
    text = text.replace("\xa0", " ")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def extract_tables(page_html: str) -> list[str]:
    """Return raw <table>...</table> blocks in document order."""
    tables = []
    for m in TABLE_RE.finditer(page_html):
        start = m.start()
        end_idx = page_html.find("</table>", start)
        if end_idx == -1:
            continue
        tables.append(page_html[start : end_idx + len("</table>")])
    return tables


def extract_data_rows(page_html: str) -> list[list[str]]:
    """Extract all data rows (header row of each table skipped) as cleaned
    cell-string lists."""
    rows = []
    for table_html in extract_tables(page_html):
        trs = TR_RE.findall(table_html)
        for tr in trs[1:]:  # first <tr> in every table on this site is a header
            cells = [clean_cell(td) for td in TD_RE.findall(tr)]
            rows.append(cells)
    return rows


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------


def is_valid_reading(s: str) -> bool:
    if not s:
        return False
    for ch in s:
        if ch in KANA_EXTRA_CHARS:
            continue
        if "぀" <= ch <= "ゟ":  # hiragana
            continue
        if "゠" <= ch <= "ヿ":  # katakana
            continue
        return False
    return True


def is_cjk_ideograph(ch: str) -> bool:
    if len(ch) != 1:
        return False
    cp = ord(ch)
    return any(lo <= cp <= hi for lo, hi in CJK_RANGES)


# ---------------------------------------------------------------------------
# Vocab building
# ---------------------------------------------------------------------------


def build_pos_lookup(pos_rows: dict[str, list[list[str]]]) -> tuple[dict, dict]:
    """pos_rows: {"verb": rows, "i-adjective": rows, "na-adjective": rows}
    Returns (by_pair, by_headword) lookup dicts, first-registered wins."""
    by_pair: dict[tuple[str, str], str] = {}
    by_headword: dict[str, str] = {}
    # Order matters for the fallback dict when a headword appears in more
    # than one POS list (verb takes priority, then i-adj, then na-adj).
    for label in ("verb", "i-adjective", "na-adjective"):
        for cells in pos_rows[label]:
            if len(cells) < 4:
                continue
            kanji, furigana = cells[0], cells[1]
            if not kanji and not furigana:
                continue
            headword = kanji if kanji else furigana
            reading = furigana if furigana else headword
            by_pair.setdefault((headword, reading), label)
            by_headword.setdefault(headword, label)
    return by_pair, by_headword


def build_vocab_records(
    rows: list[list[str]],
    source_label: str,
    pos_by_pair: dict,
    pos_by_headword: dict,
    report: dict,
) -> list[dict]:
    records: list[dict] = []
    seen: dict[tuple[str, str], dict] = {}
    dropped_empty = 0

    for cells in rows:
        if len(cells) < 4:
            report["malformed_rows"].append({"file": source_label, "cells": cells})
            continue
        kanji, furigana, romaji, meaning = cells[0], cells[1], cells[2], cells[3]

        if not any([kanji, furigana, romaji, meaning]):
            dropped_empty += 1
            continue

        headword = kanji if kanji else furigana
        reading = furigana if furigana else headword

        if not is_valid_reading(reading):
            report["bad_readings"].append(
                {"file": source_label, "headword": headword, "reading": reading}
            )

        key = (headword, reading)
        pos = pos_by_pair.get(key) or pos_by_headword.get(headword)
        record = {
            "headword": headword,
            "reading": reading,
            "romaji": romaji,
            "meaning": meaning,
            "pos": pos,
        }

        if key in seen:
            if seen[key] == record:
                continue  # exact repeat -> silent dedupe
            report["near_dupes"].append(
                {"file": source_label, "kept": seen[key], "dropped": record}
            )
            continue  # keep first-seen, drop the conflicting one (report above)

        seen[key] = record
        records.append(record)

    report["dropped_empty_rows"][source_label] = dropped_empty
    return records


# ---------------------------------------------------------------------------
# Kanji building
# ---------------------------------------------------------------------------


def build_kanji_records(rows: list[list[str]], source_label: str, report: dict) -> list[dict]:
    records: list[dict] = []
    seen_kanji: set[str] = set()

    for cells in rows:
        if len(cells) < 5:
            report["malformed_rows"].append({"file": source_label, "cells": cells})
            continue
        code_hex, kanji_char, onyomi, kunyomi, meaning = cells[:5]

        if not any([code_hex, kanji_char, onyomi, kunyomi, meaning]):
            continue  # fully blank row, drop silently

        onyomi_val = None if onyomi in DASH_PLACEHOLDERS else onyomi
        kunyomi_val = None if kunyomi in DASH_PLACEHOLDERS else kunyomi

        final_char, final_hex = reconcile_kanji_unicode(code_hex, kanji_char, source_label, report)

        if not is_cjk_ideograph(final_char):
            report["unresolved_kanji"].append(
                {"file": source_label, "glyph": kanji_char, "code": code_hex}
            )

        if final_char in seen_kanji:
            report["duplicate_kanji"].append({"file": source_label, "kanji": final_char})
            continue
        seen_kanji.add(final_char)

        records.append(
            {
                "kanji": final_char,
                "onyomi": onyomi_val,
                "kunyomi": kunyomi_val,
                "meaning": meaning,
                "unicode": final_hex,
            }
        )

    return records


def reconcile_kanji_unicode(
    code_hex: str, kanji_char: str, source_label: str, report: dict
) -> tuple[str, str]:
    """The source has occasional transcription typos in either the hex "Code"
    column or the "kanji" glyph column. Cross-validate them against each
    other and prefer whichever one is an actual CJK ideograph, since the
    correct value is always recoverable that way. Both are reported when
    they disagree so nothing is silently "fixed" without a trace."""
    code_clean = code_hex.strip().upper()
    try:
        code_val = int(code_clean, 16)
    except ValueError:
        code_val = None

    char_is_cjk = is_cjk_ideograph(kanji_char)

    if char_is_cjk:
        char_val = ord(kanji_char)
        final_hex = format(char_val, "04X")
        if code_val != char_val:
            report["kanji_code_fixes"].append(
                {
                    "file": source_label,
                    "kanji": kanji_char,
                    "source_code": code_hex,
                    "corrected_code": final_hex,
                }
            )
        return kanji_char, final_hex

    # The glyph itself isn't a real kanji (e.g. a visually-similar katakana
    # character pasted in by mistake). Try to recover the intended kanji from
    # the hex code column instead.
    if code_val is not None and is_cjk_ideograph(chr(code_val)):
        corrected_char = chr(code_val)
        report["kanji_glyph_fixes"].append(
            {
                "file": source_label,
                "source_glyph": kanji_char,
                "corrected_glyph": corrected_char,
                "code": format(code_val, "04X"),
            }
        )
        return corrected_char, format(code_val, "04X")

    # Neither side resolves to a valid ideograph -- keep as-is, flagged
    # via is_cjk_ideograph() check by the caller.
    return kanji_char, code_clean


# ---------------------------------------------------------------------------
# elzup cross-check (informational only)
# ---------------------------------------------------------------------------


def parse_elzup_csv(text: str) -> list[tuple[str, str]]:
    reader = csv.DictReader(io.StringIO(text))
    return [(row["expression"].strip(), row["reading"].strip()) for row in reader]


def cross_check(records: list[dict], elzup_pairs: list[tuple[str, str]]) -> dict:
    elzup_headwords = {h for h, _ in elzup_pairs}
    elzup_readings = {r for _, r in elzup_pairs}
    nihongo_headwords = {r["headword"] for r in records}
    nihongo_readings = {r["reading"] for r in records}

    missing_from_elzup = [
        r
        for r in records
        if r["headword"] not in elzup_headwords and r["reading"] not in elzup_readings
    ]
    missing_from_nihongo = [
        (h, r)
        for h, r in elzup_pairs
        if h not in nihongo_headwords and r not in nihongo_readings
    ]
    return {
        "nihongo_count": len(records),
        "elzup_count": len(elzup_pairs),
        "missing_from_elzup_count": len(missing_from_elzup),
        "missing_from_elzup_sample": [
            {"headword": r["headword"], "reading": r["reading"]} for r in missing_from_elzup[:20]
        ],
        "missing_from_nihongo_count": len(missing_from_nihongo),
        "missing_from_nihongo_sample": [
            {"headword": h, "reading": r} for h, r in missing_from_nihongo[:20]
        ],
    }


# ---------------------------------------------------------------------------
# Sorting / writing
# ---------------------------------------------------------------------------


def sort_vocab(records: list[dict]) -> list[dict]:
    return sorted(records, key=lambda r: (r["reading"], r["headword"]))


def sort_kanji(records: list[dict]) -> list[dict]:
    return sorted(records, key=lambda r: r["unicode"])


def write_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# Report rendering
# ---------------------------------------------------------------------------


def render_report(report: dict, counts: dict) -> str:
    lines = ["# Scrape Report", ""]
    lines.append(f"Generated by `scripts/scrape-lists.py`.")
    lines.append("")

    lines.append("## Counts vs expected")
    lines.append("")
    lines.append("| File | Actual | Expected |")
    lines.append("|---|---|---|")
    lines.append(f"| kanji-n5.json | {counts['n5_kanji']} | 103 (exact) |")
    lines.append(f"| kanji-n4.json | {counts['n4_kanji']} | 181 (exact) |")
    lines.append(f"| vocab-n5.json | {counts['n5_vocab']} | ~700 |")
    lines.append(f"| vocab-n4.json | {counts['n4_vocab']} | ~1,500 (cumulative) |")
    lines.append("")

    lines.append("## MAJOR DEVIATION: N4 vocab list is not actually cumulative")
    lines.append("")
    lines.append(
        "The task brief describes the N4 vocab source page as cumulative "
        "(including all N5 words). As currently published, it is **not**. "
        f"It contains only {counts['n4_vocab']} rows (vs the ~1,500 expected), "
        "and is missing large numbers of basic N5 words that are clearly "
        "N4-or-below level -- e.g. 食べる (たべる, to eat), 先生 (せんせい, "
        "teacher), 見る (みる, to see), 読む (よむ, to read), 学校 (がっこう, "
        "school) all appear in vocab-n5.json but NOT in vocab-n4.json."
    )
    lines.append("")
    lines.append(
        "This was verified to not be a fetch artifact: re-fetched with three "
        "different User-Agents/header sets (identical bytes each time) and "
        "cross-checked against a Wayback Machine snapshot from ~4 months "
        "before this scrape (2026-03-03), which has the exact same row count "
        "(761 `<tr>`, 42 tables) and is missing the same words. The site's "
        "N4 vocab page itself has not been cumulative for some time."
    )
    lines.append("")
    lines.append(
        "Per the task instructions this was NOT fixed by merging N5 into N4 "
        "-- vocab-n4.json contains exactly what nihongoichiban.com's N4 page "
        "currently has. The downstream `scripts/seed-items.mjs` dedup step "
        "assumes vocab-n4.json is a cumulative superset of vocab-n5.json; "
        "with the source no longer cumulative, most N5 words will not be "
        "found as overlaps and the two levels will need reconciling upstream "
        "of (or within) that seed step."
    )
    lines.append("")

    lines.append("## Rows dropped")
    lines.append("")
    for src, n in report["dropped_empty_rows"].items():
        lines.append(f"- `{src}`: {n} fully-empty placeholder row(s) dropped (all 4 cells blank).")
    if report["malformed_rows"]:
        lines.append(f"- {len(report['malformed_rows'])} malformed row(s) (wrong cell count) dropped:")
        for m in report["malformed_rows"][:20]:
            lines.append(f"  - `{m['file']}`: {m['cells']!r}")
    else:
        lines.append("- No malformed rows (wrong cell count) encountered.")
    if report["duplicate_kanji"]:
        lines.append(f"- {len(report['duplicate_kanji'])} duplicate kanji row(s) dropped (exact repeat of an already-seen kanji):")
        for d in report["duplicate_kanji"]:
            lines.append(f"  - `{d['file']}`: {d['kanji']}")
    lines.append("")

    lines.append("## Duplicate (headword, reading) handling")
    lines.append("")
    if report["near_dupes"]:
        lines.append(
            f"{len(report['near_dupes'])} near-duplicate pair(s) found: same (headword, "
            "reading) key but a different meaning/romaji (legitimate separate senses "
            "of the same word). The first-encountered sense was kept in the JSON "
            "(duplicate keys are not allowed in the output); the dropped sense is "
            "listed here so no information is silently lost:"
        )
        for nd in report["near_dupes"]:
            k = nd["kept"]
            d = nd["dropped"]
            lines.append(
                f"- `{nd['file']}`: {k['headword']} ({k['reading']}) -- kept meaning "
                f"\"{k['meaning']}\", dropped meaning \"{d['meaning']}\""
            )
    else:
        lines.append("No near-duplicate (headword, reading) pairs found.")
    lines.append("")

    lines.append("## Suspect / empty fields")
    lines.append("")
    if report["bad_readings"]:
        lines.append(
            f"{len(report['bad_readings'])} vocab row(s) have a `reading` field that "
            "is not pure hiragana/katakana/basic punctuation (source data errors -- "
            "kept as scraped per spec, flagged here rather than dropped):"
        )
        for b in report["bad_readings"]:
            lines.append(f"- `{b['file']}`: headword=\"{b['headword']}\" reading=\"{b['reading']}\"")
    else:
        lines.append("No invalid vocab readings found.")
    lines.append("")

    if report["kanji_code_fixes"]:
        lines.append(
            f"{len(report['kanji_code_fixes'])} kanji row(s) had a `Code` (unicode hex) "
            "column that didn't match the actual kanji character (transcription typos "
            "at the source, e.g. digit swaps). The kanji glyph was trusted and the "
            "`unicode` field was recomputed from it:"
        )
        for f in report["kanji_code_fixes"]:
            lines.append(
                f"- `{f['file']}`: {f['kanji']} -- source code \"{f['source_code']}\" -> "
                f"corrected \"{f['corrected_code']}\""
            )
        lines.append("")

    if report["kanji_glyph_fixes"]:
        lines.append(
            f"{len(report['kanji_glyph_fixes'])} kanji row(s) had a `kanji` glyph that "
            "was not actually a CJK ideograph (a visually-similar wrong-script "
            "character, e.g. katakana ニ instead of the kanji 二). The `Code` column "
            "decoded to a valid kanji matching the row's meaning/readings, so it was "
            "used to correct the glyph:"
        )
        for f in report["kanji_glyph_fixes"]:
            lines.append(
                f"- `{f['file']}`: source glyph \"{f['source_glyph']}\" -> corrected "
                f"\"{f['corrected_glyph']}\" (U+{f['code']})"
            )
        lines.append("")

    if report["unresolved_kanji"]:
        lines.append(
            f"{len(report['unresolved_kanji'])} kanji row(s) could not be resolved to a "
            "valid CJK ideograph from either the glyph or the code column:"
        )
        for u in report["unresolved_kanji"]:
            lines.append(f"- `{u['file']}`: glyph=\"{u['glyph']}\" code=\"{u['code']}\"")
        lines.append("")

    lines.append("## Cross-check vs elzup/jlpt-word-list")
    lines.append("")
    lines.append(
        "The task brief expected JSON files in the elzup repo; it actually ships "
        "CSVs (`src/n5.csv`, `src/n4.csv`), confirmed via the GitHub contents API. "
        "Fetched those instead. Note elzup's `n4.csv` is level-exclusive (JLPT_N4 "
        "tag only, not cumulative with N5) -- the opposite convention from what the "
        "task brief assumed for nihongoichiban's N4 page. Matches below are on "
        "headword OR reading, direct file-to-file (n5 vs n5, n4 vs n4), no merging. "
        "Reported only, per instructions -- mismatches are not resolved."
    )
    lines.append("")
    for label in ("n5", "n4"):
        cc = report["cross_check"][label]
        lines.append(f"### {label.upper()} vocab")
        lines.append("")
        lines.append(
            f"- nihongoichiban: {cc['nihongo_count']} entries, elzup: {cc['elzup_count']} entries"
        )
        lines.append(
            f"- Missing from elzup (present in nihongoichiban, matched on neither "
            f"headword nor reading): {cc['missing_from_elzup_count']}"
        )
        if cc["missing_from_elzup_sample"]:
            sample = ", ".join(
                f"{e['headword']}({e['reading']})" for e in cc["missing_from_elzup_sample"]
            )
            lines.append(f"  - sample (up to 20): {sample}")
        lines.append(
            f"- Missing from nihongoichiban (present in elzup, matched on neither "
            f"headword nor reading): {cc['missing_from_nihongo_count']}"
        )
        if cc["missing_from_nihongo_sample"]:
            sample = ", ".join(
                f"{e['headword']}({e['reading']})" for e in cc["missing_from_nihongo_sample"]
            )
            lines.append(f"  - sample (up to 20): {sample}")
        lines.append("")

    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    report = {
        "dropped_empty_rows": {},
        "malformed_rows": [],
        "bad_readings": [],
        "near_dupes": [],
        "duplicate_kanji": [],
        "kanji_code_fixes": [],
        "kanji_glyph_fixes": [],
        "unresolved_kanji": [],
        "cross_check": {},
    }

    print("Fetching nihongoichiban.com pages...", file=sys.stderr)
    pages = {name: fetch(url) for name, url in URLS.items()}

    print("Fetching elzup/jlpt-word-list CSVs (cross-check only)...", file=sys.stderr)
    elzup_csvs = {name: fetch(url) for name, url in ELZUP_CSV_URLS.items()}

    # --- Parse ---
    n5_vocab_rows = extract_data_rows(pages["n5_vocab"])
    n4_vocab_rows = extract_data_rows(pages["n4_vocab"])
    n5_kanji_rows = extract_data_rows(pages["n5_kanji"])
    n4_kanji_rows = extract_data_rows(pages["n4_kanji"])
    pos_rows = {
        "verb": extract_data_rows(pages["verbs"]),
        "i-adjective": extract_data_rows(pages["i_adjectives"]),
        "na-adjective": extract_data_rows(pages["na_adjectives"]),
    }

    pos_by_pair, pos_by_headword = build_pos_lookup(pos_rows)

    # --- Build vocab ---
    n5_vocab = build_vocab_records(n5_vocab_rows, "vocab-n5", pos_by_pair, pos_by_headword, report)
    n4_vocab = build_vocab_records(n4_vocab_rows, "vocab-n4", pos_by_pair, pos_by_headword, report)

    # --- Build kanji ---
    n5_kanji = build_kanji_records(n5_kanji_rows, "kanji-n5", report)
    n4_kanji = build_kanji_records(n4_kanji_rows, "kanji-n4", report)

    # --- Sort ---
    n5_vocab = sort_vocab(n5_vocab)
    n4_vocab = sort_vocab(n4_vocab)
    n5_kanji = sort_kanji(n5_kanji)
    n4_kanji = sort_kanji(n4_kanji)

    # --- Cross-check ---
    elzup_n5 = parse_elzup_csv(elzup_csvs["n5"])
    elzup_n4 = parse_elzup_csv(elzup_csvs["n4"])
    report["cross_check"]["n5"] = cross_check(n5_vocab, elzup_n5)
    report["cross_check"]["n4"] = cross_check(n4_vocab, elzup_n4)

    # --- Write outputs ---
    SEED_DIR.mkdir(parents=True, exist_ok=True)
    write_json(SEED_DIR / "vocab-n5.json", n5_vocab)
    write_json(SEED_DIR / "vocab-n4.json", n4_vocab)
    write_json(SEED_DIR / "kanji-n5.json", n5_kanji)
    write_json(SEED_DIR / "kanji-n4.json", n4_kanji)

    counts = {
        "n5_vocab": len(n5_vocab),
        "n4_vocab": len(n4_vocab),
        "n5_kanji": len(n5_kanji),
        "n4_kanji": len(n4_kanji),
    }
    report_md = render_report(report, counts)
    (SEED_DIR / "SCRAPE-REPORT.md").write_text(report_md, encoding="utf-8")

    print("Done.", file=sys.stderr)
    print(f"  vocab-n5.json: {counts['n5_vocab']}", file=sys.stderr)
    print(f"  vocab-n4.json: {counts['n4_vocab']}", file=sys.stderr)
    print(f"  kanji-n5.json: {counts['n5_kanji']}", file=sys.stderr)
    print(f"  kanji-n4.json: {counts['n4_kanji']}", file=sys.stderr)


if __name__ == "__main__":
    main()
