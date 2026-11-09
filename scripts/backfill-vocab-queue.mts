// One-off: seed the vocab queue with the words the claude.ai sessions filed as "→ Anki"
// inside insights tagged anki-queue (2026-11-05 … 2026-11-09), before the queue existed.
// Idempotent (queueVocab upserts by normalised text). Run after `npm run db:push`:
//   npm run db:backfill-queue
import { loadItemIndex } from "../lib/resolve-items";
import { queueVocab, type VocabGapInput } from "../lib/vocab-queue";

interface Group {
  at: string;
  label: string;
  words: VocabGapInput[];
}

const GROUPS: Group[] = [
  {
    at: "2026-11-05",
    label: "SKM N4 文法 まとめ問題 1–5",
    words: [
      { text: "ほら", meaning: "look / listen / see? (interjection)", context: "read as 'over there'" },
      { text: "鳴く", reading: "なく", meaning: "to cry / chirp / sing (animals)", context: "ピピピと鳴いています" },
      { text: "鳴き声", reading: "なきごえ", meaning: "an animal's cry" },
      { text: "咲く", reading: "さく", meaning: "to bloom", context: "たくさんさいていました; guessed from さくら" },
    ],
  },
  {
    at: "2026-11-05",
    label: "500問 W2D3 p.103",
    words: [
      { text: "間に合う", reading: "まにあう", meaning: "to be in time for / make it", context: "間 read as 門 (もん); ま is 間's reading in 間に合う, 居間" },
      { text: "残す", reading: "のこす", meaning: "to leave something (transitive, 〜を残す)" },
      { text: "残る", reading: "のこる", meaning: "to remain (intransitive, 〜が残る)" },
      { text: "吹く", reading: "ふく", meaning: "to blow / to wipe", context: "distractor" },
      { text: "掃く", reading: "はく", meaning: "to sweep", context: "distractor" },
      { text: "吐く", reading: "はく", meaning: "to vomit", context: "distractor" },
    ],
  },
  {
    at: "2026-11-05",
    label: "500問 Q179 (giving verbs)",
    words: [{ text: "やる", meaning: "= あげる for recipients below you (animals, plants, children)", context: "えさをやる, 水をやる, 買ってやる" }],
  },
  {
    at: "2026-11-05",
    label: "SKM N4 読解 短文3",
    words: [
      { text: "印刷する", reading: "いんさつする", meaning: "to print" },
      { text: "関係ない", reading: "かんけいない", meaning: "unrelated (関係 = relation)" },
      { text: "予約なしで", reading: "よやくなしで", meaning: "without a reservation (なし = without)" },
      { text: "空く", reading: "あく", meaning: "to be free / vacant", context: "パソコンが空いている" },
      { text: "利用する", reading: "りようする", meaning: "to use (formal)" },
      { text: "祝日", reading: "しゅくじつ", meaning: "public holiday" },
      { text: "携帯電話", reading: "けいたいでんわ", meaning: "mobile phone" },
    ],
  },
  {
    at: "2026-11-09",
    label: "SKM N4 文法 L6 examples + れんしゅう1",
    words: [
      { text: "狭い", reading: "せまい", meaning: "narrow / cramped (opposite of 広い)", context: "guessed as 'go see a place'" },
      { text: "箱", reading: "はこ", meaning: "box", context: "confused with 運ぶ (はこぶ)" },
      { text: "丈夫", reading: "じょうぶ", meaning: "sturdy / durable (な-adj; cf. 大丈夫)", context: "second time it stalled" },
      { text: "続き", reading: "つづき", meaning: "continuation / the rest (from 続く)", context: "仕事のつづき" },
      { text: "入社試験", reading: "にゅうしゃしけん", meaning: "company entrance exam" },
      { text: "一人で", reading: "ひとりで", meaning: "by oneself" },
      { text: "しまった", meaning: "dang / oops (frozen past of しまう)" },
      { text: "困った", reading: "こまった", meaning: "uh-oh, now what (from 困る)" },
      { text: "乗る", reading: "のる", meaning: "to board / get on (〜に乗る)", context: "particle pair with 降りる" },
      { text: "降りる", reading: "おりる", meaning: "to get off (〜を降りる)", context: "particle pair with 乗る" },
    ],
  },
];

const index = await loadItemIndex();
let queued = 0;
let bumped = 0;
for (const g of GROUPS) {
  const res = await queueVocab(g.words, { at: new Date(`${g.at}T12:00:00Z`), surface: "import", label: g.label }, index);
  queued += res.queued;
  bumped += res.bumped;
  console.log(`${g.label}: +${res.queued} new, ${res.bumped} bumped`);
}
console.log(`done: ${queued} queued, ${bumped} bumped`);
