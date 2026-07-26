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

export function ThemeSwitcher() {
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
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
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

  const currentEmoji = mounted
    ? (THEMES.find((t) => t.id === preference)?.emoji ?? SYSTEM_EMOJI)
    : SYSTEM_EMOJI;

  return (
    <div ref={containerRef} className="relative ml-auto">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1 text-xs font-semibold text-muted transition hover:text-foreground"
      >
        Theme <span aria-hidden>{currentEmoji}</span>
        <span aria-hidden className="text-[0.6rem]">
          ▾
        </span>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Theme"
          className="absolute right-0 top-full z-20 mt-2 flex w-60 flex-col gap-1 rounded-xl border border-border bg-surface p-1.5 shadow-lg"
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
