"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  NAV_SECTIONS,
  SIDEBAR_COLLAPSED,
  SIDEBAR_COOKIE,
  SIDEBAR_EXPANDED,
  activeNavItem,
  isNavHrefActive,
  type NavItem,
} from "@/lib/nav";
import { ThemeSwitcher } from "../theme-switcher";
import { CloseIcon, FlagIcon, MenuIcon, NavIcon, SidebarToggleIcon } from "./icons";

const SIDEBAR_ID = "app-sidebar";
const ONE_YEAR_S = 60 * 60 * 24 * 365;
/** Tailwind's `md` breakpoint: the sidebar is permanent from here up, a drawer below it. */
const DESKTOP_QUERY = "(min-width: 48rem)";

const ICON_BUTTON =
  "inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-200/60 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100";

/** The root layout reads this cookie on the next request, so a reload renders the same width. */
function persistCollapsed(collapsed: boolean) {
  document.cookie = `${SIDEBAR_COOKIE}=${collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED}; Path=/; Max-Age=${ONE_YEAR_S}; SameSite=Lax`;
}

interface AppShellProps {
  /** From the sidebar cookie, read in the root layout. */
  initialCollapsed: boolean;
  /** Whole days to the exam in the learner's zone; null hides the countdown. */
  daysToExam: number | null;
  children: ReactNode;
}

/**
 * The app frame. Desktop (md+): a fixed left sidebar that collapses to an icon rail. Below md:
 * a slim top bar whose menu button opens the same sidebar as an off-canvas drawer. Page
 * content is passed through as children, so it stays server-rendered.
 */
export function AppShell({ initialCollapsed, daysToExam, children }: AppShellProps) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerWasOpen = useRef(false);

  const current = activeNavItem(pathname);
  const closeDrawer = () => setDrawerOpen(false);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    persistCollapsed(next);
  }

  // While the drawer is open: focus moves into it, the page behind can't scroll, Escape closes
  // it, and growing the window to desktop width closes it (the sidebar is permanent there).
  useEffect(() => {
    if (!drawerOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    // defaultPrevented: an open popover inside the drawer (the theme picker) took this Escape.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setDrawerOpen(false);
    };
    const desktop = window.matchMedia(DESKTOP_QUERY);
    const onBreakpoint = () => {
      if (desktop.matches) setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    desktop.addEventListener("change", onBreakpoint);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      desktop.removeEventListener("change", onBreakpoint);
    };
  }, [drawerOpen]);

  // Focus goes back to the menu button once the drawer has closed (and the page is no longer inert).
  useEffect(() => {
    if (drawerOpen) {
      drawerWasOpen.current = true;
    } else if (drawerWasOpen.current) {
      drawerWasOpen.current = false;
      menuButtonRef.current?.focus();
    }
  }, [drawerOpen]);

  // Collapse applies from md up only; the mobile drawer always shows labels.
  const railOnly = (cls: string) => (collapsed ? cls : "");

  return (
    <>
      {/* Mobile top bar. Its height is --app-topbar-h (globals.css), which sticky page headers offset by. */}
      <header
        inert={drawerOpen}
        className="sticky top-0 z-20 flex h-14 items-center gap-1.5 border-b border-border bg-background/85 px-2 backdrop-blur md:hidden"
      >
        <button
          ref={menuButtonRef}
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open navigation"
          aria-expanded={drawerOpen}
          aria-controls={SIDEBAR_ID}
          className={ICON_BUTTON}
        >
          <MenuIcon />
        </button>
        <span className="truncate text-sm font-semibold tracking-tight">{current?.label ?? "JLPT Hub"}</span>
      </header>

      {/* Scrim behind the open drawer. */}
      <div
        aria-hidden="true"
        onClick={closeDrawer}
        className={`fixed inset-0 z-40 bg-neutral-950/40 transition-opacity duration-200 motion-reduce:transition-none md:hidden ${
          drawerOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      <div
        id={SIDEBAR_ID}
        role={drawerOpen ? "dialog" : undefined}
        aria-modal={drawerOpen ? true : undefined}
        aria-label={drawerOpen ? "Navigation" : undefined}
        className={`fixed inset-y-0 left-0 z-50 flex w-62 flex-col border-r border-border bg-surface transition-[translate,visibility,width] duration-200 ease-out motion-reduce:transition-none md:z-30 ${
          drawerOpen ? "visible translate-x-0 shadow-2xl" : "max-md:invisible max-md:-translate-x-full"
        } ${railOnly("md:w-14")}`}
      >
        <div className={`flex h-14 shrink-0 items-center gap-2 pr-2 pl-4 ${railOnly("md:justify-center md:px-0")}`}>
          <Link
            href="/"
            onClick={closeDrawer}
            className={`truncate rounded-md text-[15px] font-bold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${railOnly("md:hidden")}`}
          >
            JLPT Hub
          </Link>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-controls={SIDEBAR_ID}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={`${ICON_BUTTON} max-md:hidden ${collapsed ? "mx-auto" : "ml-auto"}`}
          >
            <SidebarToggleIcon collapsed={collapsed} />
          </button>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={closeDrawer}
            aria-label="Close navigation"
            className={`${ICON_BUTTON} ml-auto md:hidden`}
          >
            <CloseIcon />
          </button>
        </div>

        <nav aria-label="Main" className="flex-1 overflow-x-hidden overflow-y-auto px-2 pt-1 pb-3">
          {NAV_SECTIONS.map((section, i) => {
            const headingId = `nav-section-${i}`;
            return (
              <div key={section.label} className={i > 0 ? `mt-5 ${railOnly("md:mt-2.5 md:border-t md:border-border md:pt-2.5")}` : ""}>
                <p
                  id={headingId}
                  className={`px-3 pb-1 text-[11px] font-semibold tracking-wider text-neutral-400 uppercase dark:text-neutral-500 ${railOnly("md:sr-only")}`}
                >
                  {section.label}
                </p>
                <ul aria-labelledby={headingId} className="flex flex-col gap-0.5">
                  {section.items.map((item) => (
                    <li key={item.href}>
                      <SidebarLink
                        item={item}
                        active={isNavHrefActive(pathname, item.href)}
                        collapsed={collapsed}
                        onNavigate={closeDrawer}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>

        <div className="flex shrink-0 flex-col gap-0.5 border-t border-border p-2">
          {daysToExam !== null && daysToExam >= 0 && <ExamCountdown days={daysToExam} collapsed={collapsed} />}
          <ThemeSwitcher collapsed={collapsed} />
        </div>
      </div>

      <div
        inert={drawerOpen}
        className={`flex min-w-0 flex-1 flex-col transition-[padding] duration-200 ease-out motion-reduce:transition-none ${
          collapsed ? "md:pl-14" : "md:pl-62"
        }`}
      >
        <main id="main" tabIndex={-1} className="flex-1 focus:outline-none">
          {children}
        </main>
      </div>
    </>
  );
}

function SidebarLink({
  item,
  active,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      // Native tooltip names the icon when the rail hides the label.
      title={collapsed ? item.label : undefined}
      className={`group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent max-md:py-2.5 ${
        collapsed ? "md:justify-center md:px-0" : ""
      } ${
        active
          ? "bg-neutral-200/70 font-semibold text-neutral-900 dark:bg-neutral-800 dark:text-neutral-50"
          : "text-neutral-600 hover:bg-neutral-200/50 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800/60 dark:hover:text-neutral-100"
      }`}
    >
      <span
        className={
          active
            ? "text-indigo-600 dark:text-indigo-400"
            : "text-neutral-400 group-hover:text-neutral-600 dark:text-neutral-500 dark:group-hover:text-neutral-300"
        }
      >
        <NavIcon name={item.icon} />
      </span>
      <span className={`truncate ${collapsed ? "md:sr-only" : ""}`}>{item.label}</span>
    </Link>
  );
}

function ExamCountdown({ days, collapsed }: { days: number; collapsed: boolean }) {
  const unit = days === 1 ? "day" : "days";
  return (
    <p
      title={collapsed ? (days === 0 ? "JLPT N4 is today" : `${days} ${unit} to JLPT N4`) : undefined}
      className={`flex items-center gap-3 px-3 py-1.5 text-xs text-neutral-500 dark:text-neutral-400 ${
        collapsed ? "md:justify-center md:px-0" : ""
      }`}
    >
      <span className={`text-neutral-400 dark:text-neutral-500 ${collapsed ? "md:hidden" : ""}`}>
        <FlagIcon />
      </span>
      {/* The rail has room for the number only; the sentence stays for screen readers. */}
      <span aria-hidden="true" className={`hidden text-sm font-bold text-foreground tabular-nums ${collapsed ? "md:inline" : ""}`}>
        {days}
      </span>
      <span className={collapsed ? "md:sr-only" : ""}>
        {days === 0 ? (
          "JLPT N4 is today"
        ) : (
          <>
            <span className="font-semibold text-foreground tabular-nums">{days}</span> {unit} to N4
          </>
        )}
      </span>
    </p>
  );
}
