/**
 * Pure state-machine for the bilingual typewriter effect.
 *
 * The component keeps a cursor `{ p, c, del }`:
 *  - `p`   — index of the active phrase
 *  - `c`   — how many characters (code points) are currently visible
 *  - `del` — false while typing, true while erasing
 *
 * Each call to `twNext` advances one tick and reports which pause should
 * follow, so the component can pick the right setTimeout delay.
 */

export interface TwCursor {
  p: number;
  c: number;
  del: boolean;
}

export type TwWait = "type" | "erase" | "holdTyped" | "holdEmpty";

export const TW_INITIAL: TwCursor = { p: 0, c: 0, del: false };

export function twNext(cur: TwCursor, lengths: number[]): { next: TwCursor; wait: TwWait } {
  const n = lengths.length;
  if (n === 0) return { next: { ...cur }, wait: "holdEmpty" };
  const len = Math.max(0, lengths[cur.p] ?? 0);

  if (!cur.del) {
    if (cur.c < len) {
      return { next: { p: cur.p, c: cur.c + 1, del: false }, wait: "type" };
    }
    // Phrase fully typed — hold it, then start erasing.
    return { next: { p: cur.p, c: len, del: true }, wait: "holdTyped" };
  }
  if (cur.c > 0) {
    return { next: { p: cur.p, c: cur.c - 1, del: true }, wait: "erase" };
  }
  // Phrase fully erased — brief gap, then move to the next phrase.
  return { next: { p: (cur.p + 1) % n, c: 0, del: false }, wait: "holdEmpty" };
}

/** Delay in ms for each wait kind, from component props. */
export function twDelay(
  wait: TwWait,
  opts: { typingMs: number; erasingMs: number; holdMs: number; gapMs: number },
): number {
  switch (wait) {
    case "type":
      return opts.typingMs;
    case "erase":
      return opts.erasingMs;
    case "holdTyped":
      return opts.holdMs;
    case "holdEmpty":
      return opts.gapMs;
  }
}
