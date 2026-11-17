import { test } from "node:test";
import assert from "node:assert/strict";
import { NAV_SECTIONS, activeNavItem, isNavHrefActive, isSidebarCollapsed } from "./nav.ts";

const activeLabel = (pathname: string) => activeNavItem(pathname)?.label ?? null;

test("/ matches only the Journal", () => {
  assert.equal(isNavHrefActive("/", "/"), true);
  assert.equal(isNavHrefActive("/practice", "/"), false);
  assert.equal(isNavHrefActive("/schedule", "/"), false);
  assert.equal(activeLabel("/"), "Journal");
});

test("a destination matches itself and its nested routes", () => {
  assert.equal(activeLabel("/practice"), "Practice");
  assert.equal(activeLabel("/practice/42"), "Practice");
  assert.equal(activeLabel("/sources/genki-1/edit"), "Sources");
  assert.equal(activeLabel("/sources/new"), "Sources");
  assert.equal(activeLabel("/sprint/3"), "Sprint");
  assert.equal(activeLabel("/queue"), "Vocab queue");
  assert.equal(activeLabel("/schedule"), "Schedule");
});

test("a trailing slash still matches", () => {
  assert.equal(activeLabel("/library/"), "Library");
});

test("a sibling sharing the prefix does not match", () => {
  assert.equal(isNavHrefActive("/practiceboard", "/practice"), false);
  assert.equal(isNavHrefActive("/sourcesx/1", "/sources"), false);
  assert.equal(activeLabel("/minefield"), null);
});

test("an unknown route marks nothing", () => {
  assert.equal(activeLabel("/nope"), null);
  assert.equal(activeLabel("/mcp"), null);
});

test("exactly one item is active for every destination", () => {
  const items = NAV_SECTIONS.flatMap((s) => s.items);
  for (const item of items) {
    const matches = items.filter((other) => isNavHrefActive(item.href, other.href));
    assert.deepEqual(
      matches.map((m) => m.href),
      [item.href],
      `${item.href} should match only itself`,
    );
  }
});

test("hrefs are unique and sections stay at three or fewer", () => {
  const hrefs = NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.href));
  assert.equal(new Set(hrefs).size, hrefs.length);
  assert.ok(NAV_SECTIONS.length <= 3);
});

test("only an explicit 'collapsed' cookie collapses the sidebar", () => {
  assert.equal(isSidebarCollapsed("collapsed"), true);
  assert.equal(isSidebarCollapsed("expanded"), false);
  assert.equal(isSidebarCollapsed(undefined), false);
  assert.equal(isSidebarCollapsed(null), false);
  assert.equal(isSidebarCollapsed(""), false);
  assert.equal(isSidebarCollapsed("COLLAPSED"), false);
});
