"use client";

import { useEffect, useRef } from "react";

type HotkeyMap = Record<string, () => void>;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

/**
 * Attaches a single keydown listener for the lifetime of the calling component and dispatches
 * on `event.code` (e.g. "Space", "KeyK", "ArrowRight"). The handler map is read fresh from a ref
 * on every keystroke, so callers can pass a new object each render without stale closures or
 * needing to re-attach the listener. Ignored while typing in a form field.
 */
export function useHotkeys(map: HotkeyMap): void {
  const mapRef = useRef(map);
  useEffect(() => {
    mapRef.current = map;
  });

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      const handler = mapRef.current[e.code];
      if (!handler) return;
      e.preventDefault();
      handler();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
