"use client";

import { useEffect, useState } from "react";
import {
  SYSTEM_PREFERENCE,
  THEME_STORAGE_KEY,
  THEMES,
  resolveTheme,
} from "@/lib/themes";

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

export function ThemeSwitcher() {
  // Lazy initializer keeps React state in agreement with the inline theme
  // script in the root layout — both read the same localStorage key.
  const [preference, setPreference] = useState(() =>
    typeof window === "undefined" ? SYSTEM_PREFERENCE : readPreference(),
  );

  useEffect(() => {
    if (preference !== SYSTEM_PREFERENCE) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const followSystem = () => applyPreference(SYSTEM_PREFERENCE);
    media.addEventListener("change", followSystem);
    return () => media.removeEventListener("change", followSystem);
  }, [preference]);

  function select(next: string) {
    setPreference(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage unavailable (private mode): theme still applies for this view.
    }
    applyPreference(next);
  }

  return (
    <select
      aria-label="Theme"
      value={preference}
      onChange={(e) => select(e.target.value)}
      className="ml-auto rounded-lg border border-neutral-200 bg-white px-2 py-1 text-xs font-semibold text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
    >
      <option value={SYSTEM_PREFERENCE}>Auto</option>
      {THEMES.map((t) => (
        <option key={t.id} value={t.id}>
          {t.labelJa} {t.label}
        </option>
      ))}
    </select>
  );
}
