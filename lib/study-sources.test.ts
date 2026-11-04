import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSourceText, parseAliases, resolveSource, slugify, type SourceLike } from "./study-sources.ts";

// The real seed, so the strings already in the ledger are checked against the aliases
// that actually ship (data/seed/study-sources.json is what `npm run db:seed-sources` loads).
const seedPath = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "seed", "study-sources.json");
const seed = (JSON.parse(readFileSync(seedPath, "utf8")) as Omit<SourceLike, "id">[]).map((s) => ({
  ...s,
  id: `id:${s.slug}`,
}));

const slugOf = (text: string) => resolveSource(seed, text)?.slug ?? null;

test("seed slugs are unique and every alias resolves to its own entry", () => {
  assert.equal(new Set(seed.map((s) => s.slug)).size, seed.length);
  for (const s of seed) {
    for (const alias of s.aliases ?? []) {
      assert.equal(slugOf(alias), s.slug, `alias "${alias}" should resolve to ${s.slug}`);
    }
    assert.equal(slugOf(s.name), s.slug, `name "${s.name}"`);
    if (s.nameJa) assert.equal(slugOf(s.nameJa), s.slug, `nameJa "${s.nameJa}"`);
  }
});

test("the strings already in the ledger resolve", () => {
  assert.equal(slugOf("新完全マスター 文法 N4 — 実力養成編 第1部 2課"), "skm-n4-bunpou");
  assert.equal(slugOf("Shin Nihongo 500 Mon N4-N5"), "shin-nihongo-500-mon-n4-n5");
});

test("slug, case and whitespace are forgiving", () => {
  assert.equal(slugOf("SKM-N4-BUNPOU"), "skm-n4-bunpou");
  assert.equal(slugOf("  skm n4 文法 "), "skm-n4-bunpou");
  assert.equal(slugOf("新完全マスター文法N4"), "skm-n4-bunpou");
  assert.equal(slugOf("wanikani"), "wanikani");
  assert.equal(slugOf("Satori"), "satori-reader");
  assert.equal(normalizeSourceText(" Ｇｅｎｋｉ　ＩＩ "), "genkiii");
});

test("detail after the source name picks the most specific entry", () => {
  assert.equal(slugOf("Genki II L14"), "genki-2");
  assert.equal(slugOf("Genki I L3"), "genki-1");
  assert.equal(slugOf("Genki II Workbook L14"), "genki-2-workbook");
  assert.equal(slugOf("500問 W2D1"), "shin-nihongo-500-mon-n4-n5");
  assert.equal(slugOf("公式問題集 第二集 N4 第1回"), "jlpt-official-n4-2018");
  assert.equal(slugOf("公式問題集 N4 聴解"), "jlpt-official-n4-2012");
});

test("a short text inside exactly one key resolves, inside several does not", () => {
  assert.equal(slugOf("500 mon n4-n5"), "shin-nihongo-500-mon-n4-n5");
  assert.equal(slugOf("Genki"), null); // four Genki entries
  assert.equal(slugOf("公式問題集"), null); // four official workbooks
  assert.equal(slugOf("新完全マスター"), null); // five SKM volumes
});

test("nothing, empty and unrelated text return null", () => {
  assert.equal(slugOf(""), null);
  assert.equal(slugOf("   "), null);
  assert.equal(slugOf("chat"), null);
  assert.equal(slugOf("N4"), null);
  assert.equal(resolveSource(seed, null), null);
  assert.equal(resolveSource(seed, undefined), null);
});

test("ambiguity is reported, not guessed, with a hand-built catalog", () => {
  const rows: SourceLike[] = [
    { id: "a", slug: "a", name: "Minna no Nihongo I", nameJa: "みんなの日本語 初級I", aliases: ["MNN I", "みんな"] },
    { id: "b", slug: "b", name: "Minna no Nihongo II", nameJa: "みんなの日本語 初級II", aliases: ["MNN II", "みんな"] },
  ];
  assert.equal(resolveSource(rows, "みんな")?.slug, undefined); // alias on both
  assert.equal(resolveSource(rows, "Minna no Nihongo")?.slug, undefined); // inside both names
  assert.equal(resolveSource(rows, "MNN II L5")?.slug, "b");
  assert.equal(resolveSource(rows, "みんなの日本語 初級I 第3課")?.slug, "a"); // 初級II key not in text
});

test("slugify and parseAliases", () => {
  assert.equal(slugify("Try! N4 Grammar (2nd ed.)"), "try-n4-grammar-2nd-ed");
  assert.equal(slugify("Café Français"), "cafe-francais");
  assert.equal(slugify("新完全マスター", "src-1"), "src-1");
  assert.equal(slugify("  "), "source");
  assert.deepEqual(parseAliases("SKM N4, skm n4 ,, Genki II\nげんき II、げんき II"), ["SKM N4", "Genki II", "げんき II"]);
});
