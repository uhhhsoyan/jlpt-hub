export type ThemeAppearance = "light" | "dark";

export interface ThemeDefinition {
  /** Matches a `[data-theme="…"]` block in app/themes.css. */
  id: string;
  label: string;
  /** Japanese name, shown alongside the label in the picker. */
  labelJa: string;
  /** Shown in the picker trigger and option rows. */
  emoji: string;
  appearance: ThemeAppearance;
}

/**
 * The user's stored preference: a theme id, or "system" to follow the OS
 * light/dark setting (resolving to the "light"/"dark" themes).
 */
export const SYSTEM_PREFERENCE = "system";

export const THEME_STORAGE_KEY = "jlpt-hub-theme";

export const THEMES: readonly ThemeDefinition[] = [
  { id: "light", label: "Light", labelJa: "白", emoji: "☀️", appearance: "light" },
  { id: "dark", label: "Dark", labelJa: "墨", emoji: "🌙", appearance: "dark" },
  { id: "sakura", label: "Sakura", labelJa: "桜", emoji: "🌸", appearance: "light" },
  { id: "matcha", label: "Matcha", labelJa: "抹茶", emoji: "🍵", appearance: "light" },
  { id: "onsen", label: "Onsen", labelJa: "温泉", emoji: "♨️", appearance: "dark" },
  { id: "ai", label: "Indigo", labelJa: "藍", emoji: "🌌", appearance: "dark" },
];

export function resolveTheme(
  preference: string | null,
  prefersDark: boolean,
): ThemeDefinition {
  const theme = THEMES.find((t) => t.id === preference);
  if (theme) return theme;
  const fallback = prefersDark ? "dark" : "light";
  return THEMES.find((t) => t.id === fallback)!;
}
