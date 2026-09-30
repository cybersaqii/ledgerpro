"use client";

import { useEffect, useRef } from "react";

/**
 * Outside-click + Escape dismissal for hand-rolled dropdowns.
 * Attach the returned ref to the dropdown's wrapper div; `onDismiss`
 * fires when the user clicks anywhere outside it or presses Escape.
 */
export function useDismiss<T extends HTMLElement>(onDismiss: () => void) {
  const ref = useRef<T | null>(null);
  const cb = useRef(onDismiss);
  useEffect(() => {
    cb.current = onDismiss;
  });
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) cb.current();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") cb.current();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  return ref;
}
