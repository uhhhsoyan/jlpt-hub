import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SYSTEM_PREFERENCE,
  THEMES,
  resolveTheme,
} from "./themes.ts";

test("theme ids are unique", () => {
  const ids = THEMES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("system preference sentinel is not a theme id", () => {
  assert.equal(THEMES.find((t) => t.id === SYSTEM_PREFERENCE), undefined);
});

test("stock light and dark themes exist for system fallback", () => {
  assert.equal(resolveTheme("light", true).id, "light");
  assert.equal(resolveTheme("dark", false).id, "dark");
});

test("resolveTheme returns the matching theme regardless of OS setting", () => {
  assert.equal(resolveTheme("sakura", true).id, "sakura");
  assert.equal(resolveTheme("onsen", false).id, "onsen");
});

test("resolveTheme falls back to the OS appearance", () => {
  assert.equal(resolveTheme(null, false).id, "light");
  assert.equal(resolveTheme(null, true).id, "dark");
  assert.equal(resolveTheme(SYSTEM_PREFERENCE, true).id, "dark");
  assert.equal(resolveTheme("no-such-theme", false).id, "light");
});

test("every theme has a palette block in app/themes.css", () => {
  const css = readFileSync(new URL("../app/themes.css", import.meta.url), "utf8");
  for (const t of THEMES) {
    assert.ok(
      css.includes(`:root[data-theme="${t.id}"]`),
      `missing palette block for theme "${t.id}"`,
    );
    assert.ok(
      css.includes(`\n[data-theme="${t.id}"]`),
      `palette block for "${t.id}" must also match nested preview elements`,
    );
  }
});
