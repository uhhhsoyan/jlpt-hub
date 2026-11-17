"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  SYSTEM_PREFERENCE,
  THEME_STORAGE_KEY,
  THEMES,
  resolveTheme,
  type ThemeDefinition,
} from "@/lib/themes";

const SYSTEM_EMOJI = "🌗";

const emptySubscribe = () => () => {};

function readPreference(): string {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) ?? SYSTEM_PREFERENCE;
  } catch {
    return SYSTEM_PREFERENCE;
  }
}

function applyPreference(preference: string) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = resolveTheme(preference, prefersDark);
  const root = document.documentElement;
  root.setAttribute("data-theme", theme.id);
  root.setAttribute("data-appearance", theme.appearance);
}

/**
 * Option row rendered in the theme's own palette: the data-theme/data-appearance
 * attributes re-scope every color variable (see app/themes.css), so the row is a
 * live preview — its background, text, and swatch dots all show the theme.
 */
function ThemeOption({
  theme,
  selected,
  onSelect,
}: {
  theme: ThemeDefinition;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={() => onSelect(theme.id)}
      data-theme={theme.id}
      data-appearance={theme.appearance}
      className={`flex w-full items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-2 text-left text-sm text-foreground transition hover:border-accent ${
        selected ? "ring-1 ring-accent" : ""
      }`}
    >
      <span aria-hidden>{theme.emoji}</span>
      <span className="font-semibold">{theme.label}</span>
      <span className="text-xs text-muted">{theme.labelJa}</span>
      <span className="ml-auto flex gap-1" aria-hidden>
        <span className="size-3 rounded-full border border-border bg-accent" />
        <span className="size-3 rounded-full border border-border bg-surface" />
        <span className="size-3 rounded-full border border-border bg-muted" />
      </span>
    </button>
  );
}

/**
 * Theme picker for the sidebar footer: a full-width row that opens the list upward, or, when
 * the desktop sidebar is collapsed to its icon rail, the emoji alone with the list opening to
 * the right of the rail.
 */
export function ThemeSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  // Lazy initializer keeps React state in agreement with the inline theme
  // script in the root layout — both read the same localStorage key.
  const [preference, setPreference] = useState(() =>
    typeof window === "undefined" ? SYSTEM_PREFERENCE : readPreference(),
  );
  // The trigger emoji renders only after mount: the server doesn't know the
  // stored preference, and unlike the page colors (fixed pre-paint by the
  // inline script) button text can't be corrected before hydration.
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (preference !== SYSTEM_PREFERENCE) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const followSystem = () => applyPreference(SYSTEM_PREFERENCE);
    media.addEventListener("change", followSystem);
    return () => media.removeEventListener("change", followSystem);
  }, [preference]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    // preventDefault marks this Escape as handled, so the mobile drawer around the picker
    // stays open (it ignores a defaultPrevented Escape).
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function select(next: string) {
    setPreference(next);
    setOpen(false);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage unavailable (private mode): theme still applies for this view.
    }
    applyPreference(next);
  }

  const currentTheme = mounted ? THEMES.find((t) => t.id === preference) : undefined;
  const currentEmoji = currentTheme?.emoji ?? SYSTEM_EMOJI;
  const currentLabel = mounted ? (currentTheme?.label ?? "Auto") : "";

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={currentLabel ? `Theme: ${currentLabel}` : "Theme"}
        title={collapsed ? "Theme" : undefined}
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-neutral-600 transition-colors hover:bg-neutral-200/50 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent dark:text-neutral-400 dark:hover:bg-neutral-800/60 dark:hover:text-neutral-100 ${
          collapsed ? "md:justify-center md:px-0" : ""
        } ${open ? "bg-neutral-200/50 dark:bg-neutral-800/60" : ""}`}
      >
        <span aria-hidden className="flex size-[18px] shrink-0 items-center justify-center text-[15px] leading-none">
          {currentEmoji}
        </span>
        <span className={collapsed ? "md:sr-only" : ""}>Theme</span>
        <span aria-hidden className={`ml-auto truncate text-xs text-neutral-400 dark:text-neutral-500 ${collapsed ? "md:hidden" : ""}`}>
          {currentLabel}
        </span>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Theme"
          className={`absolute z-20 flex flex-col gap-1 rounded-xl border border-border bg-surface p-1.5 shadow-lg ${
            collapsed ? "inset-x-0 bottom-full mb-1.5 md:inset-x-auto md:bottom-0 md:left-full md:mb-0 md:ml-3 md:w-60" : "inset-x-0 bottom-full mb-1.5"
          }`}
        >
          <button
            type="button"
            role="option"
            aria-selected={preference === SYSTEM_PREFERENCE}
            onClick={() => select(SYSTEM_PREFERENCE)}
            className={`flex w-full items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-2 text-left text-sm text-foreground transition hover:border-accent ${
              preference === SYSTEM_PREFERENCE ? "ring-1 ring-accent" : ""
            }`}
          >
            <span aria-hidden>{SYSTEM_EMOJI}</span>
            <span className="font-semibold">Auto</span>
            <span className="ml-auto text-xs text-muted">follows OS</span>
          </button>
          {THEMES.map((t) => (
            <ThemeOption
              key={t.id}
              theme={t}
              selected={preference === t.id}
              onSelect={select}
            />
          ))}
        </div>
      )}
    </div>
  );
}
