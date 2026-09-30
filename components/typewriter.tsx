"use client";

import { useEffect, useMemo, useState } from "react";
import { twNext, twDelay, TW_INITIAL, type TwCursor } from "@/lib/typewriter";

export interface TwPhrase {
  text: string;
  /** Set for Urdu/Arabic-script phrases so direction flips correctly. */
  rtl?: boolean;
}

interface TypewriterProps {
  phrases: TwPhrase[];
  className?: string;
  /** Extra class for the blinking caret (useful over gradient text). */
  caretClassName?: string;
  typingMs?: number;
  erasingMs?: number;
  holdMs?: number;
  gapMs?: number;
}

/**
 * Bilingual typewriter: types each phrase character-by-character, holds,
 * erases, and moves to the next — looping forever. Urdu phrases render
 * right-to-left. Shows the first phrase statically when the user prefers
 * reduced motion.
 */
export function Typewriter({
  phrases,
  className,
  caretClassName,
  typingMs = 55,
  erasingMs = 26,
  holdMs = 1900,
  gapMs = 420,
}: TypewriterProps) {
  const chars = useMemo(() => phrases.map((p) => [...p.text]), [phrases]);
  const lengths = useMemo(() => chars.map((c) => c.length), [chars]);
  const [cursor, setCursor] = useState<TwCursor>(TW_INITIAL);
  // Lazy initial state — no effect needed, avoids a cascading render.
  const [reduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    if (reduced || lengths.length === 0) return;
    let timer: ReturnType<typeof setTimeout>;
    let cur: TwCursor = { ...TW_INITIAL };
    const step = () => {
      const { next, wait } = twNext(cur, lengths);
      cur = next;
      setCursor(next);
      timer = setTimeout(step, twDelay(wait, { typingMs, erasingMs, holdMs, gapMs }));
    };
    timer = setTimeout(step, gapMs);
    return () => clearTimeout(timer);
  }, [reduced, lengths, typingMs, erasingMs, holdMs, gapMs]);

  const first = phrases[0];
  if (reduced || chars.length === 0) {
    return (
      <span className={className} dir={first?.rtl ? "rtl" : undefined}>
        {first?.text ?? ""}
      </span>
    );
  }
  const active = phrases[cursor.p] ?? first;
  const visible = chars[cursor.p]?.slice(0, cursor.c).join("") ?? "";
  return (
    <span className={className} dir={active?.rtl ? "rtl" : undefined} aria-hidden="true">
      {visible}
      <span className={`tw-caret${caretClassName ? ` ${caretClassName}` : ""}`} aria-hidden="true" />
      <span className="sr-only">{first?.text}</span>
    </span>
  );
}
