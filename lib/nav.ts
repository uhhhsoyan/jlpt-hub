/**
 * The app's navigation: every destination, grouped for the sidebar, plus the route-matching
 * rule that decides which one is current. Pure (no React, no path aliases) so it unit-tests
 * under plain `node --test`; app/_shell renders it.
 */

export type NavIconName =
  | "journal"
  | "practice"
  | "queue"
  | "progress"
  | "sprint"
  | "library"
  | "workshop"
  | "mine"
  | "schedule"
  | "sources";

export interface NavItem {
  href: string;
  label: string;
  icon: NavIconName;
}

export interface NavSection {
  /** Small muted heading above the group. */
  label: string;
  items: readonly NavItem[];
}

/**
 * Ordered by how often a learner a few weeks before the exam reaches for them: the daily loop
 * first, then the study tools, then plan and reference pages.
 */
export const NAV_SECTIONS: readonly NavSection[] = [
  {
    label: "Daily",
    items: [
      { href: "/", label: "Journal", icon: "journal" },
      { href: "/practice", label: "Practice", icon: "practice" },
      { href: "/queue", label: "Vocab queue", icon: "queue" },
      { href: "/progress", label: "Progress", icon: "progress" },
    ],
  },
  {
    label: "Study tools",
    items: [
      { href: "/sprint", label: "Sprint", icon: "sprint" },
      { href: "/library", label: "Library", icon: "library" },
      { href: "/workshop", label: "Workshop", icon: "workshop" },
      { href: "/mine", label: "Mine", icon: "mine" },
    ],
  },
  {
    label: "Reference",
    items: [
      { href: "/schedule", label: "Schedule", icon: "schedule" },
      { href: "/sources", label: "Sources", icon: "sources" },
    ],
  },
];

/**
 * Whether `href` is the current section for `pathname`. "/" matches only itself; any other
 * href matches itself and the routes nested under it ("/practice/42" is Practice), but not a
 * sibling that merely shares the prefix ("/practiceboard" is not Practice).
 */
export function isNavHrefActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The nav item for the current route, or null when the route is not under any destination. */
export function activeNavItem(pathname: string, sections: readonly NavSection[] = NAV_SECTIONS): NavItem | null {
  for (const section of sections) {
    for (const item of section.items) {
      if (isNavHrefActive(pathname, item.href)) return item;
    }
  }
  return null;
}

/**
 * Cookie holding the desktop sidebar's collapsed state. Read by the root layout so the first
 * HTML already has the right width (no flash); written by the client when the toggle is used.
 */
export const SIDEBAR_COOKIE = "jlpt-hub-sidebar";
export const SIDEBAR_COLLAPSED = "collapsed";
export const SIDEBAR_EXPANDED = "expanded";

/** Anything other than an explicit "collapsed" (absent, stale, tampered) means expanded. */
export function isSidebarCollapsed(cookieValue: string | undefined | null): boolean {
  return cookieValue === SIDEBAR_COLLAPSED;
}
