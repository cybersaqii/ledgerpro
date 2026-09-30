import { describe, it, expect } from "vitest";
import { twNext, twDelay, TW_INITIAL, type TwCursor } from "@/lib/typewriter";

function simulate(lengths: number[], ticks: number): { text: string; wait: string }[] {
  let cur: TwCursor = { ...TW_INITIAL };
  const out: { text: string; wait: string }[] = [];
  for (let i = 0; i < ticks; i++) {
    const r = twNext(cur, lengths);
    cur = r.next;
    out.push({ text: `p${cur.p}:c${cur.c}${cur.del ? "D" : ""}`, wait: r.wait });
  }
  return out;
}

describe("typewriter state machine", () => {
  it("types a phrase, holds, erases, then moves to the next phrase", () => {
    const seq = simulate([3, 2], 20).map((s) => s.text);
    // Type "abc": c goes 1,2,3 then hold (del=true), then erase 2,1,0, then next phrase.
    expect(seq.slice(0, 4)).toEqual(["p0:c1", "p0:c2", "p0:c3", "p0:c3D"]);
    expect(seq.slice(4, 8)).toEqual(["p0:c2D", "p0:c1D", "p0:c0D", "p1:c0"]);
  });

  it("loops back to the first phrase after the last one", () => {
    const seq = simulate([1, 1], 12).map((s) => s.text);
    // p0: type, hold, erase, gap→p1 ... p1: type, hold, erase, gap→p0
    expect(seq).toEqual([
      "p0:c1", "p0:c1D", "p0:c0D", "p1:c0",
      "p1:c1", "p1:c1D", "p1:c0D", "p0:c0",
      "p0:c1", "p0:c1D", "p0:c0D", "p1:c0",
    ]);
  });

  it("handles an empty phrase list without crashing", () => {
    const r = twNext({ ...TW_INITIAL }, []);
    expect(r.wait).toBe("holdEmpty");
  });

  it("handles zero-length phrases", () => {
    const seq = simulate([0, 2], 6).map((s) => s.text);
    // Empty phrase: immediately hold-typed, then erase is a no-op tick to next.
    expect(seq[0]).toBe("p0:c0D");
    expect(seq[1]).toBe("p1:c0");
  });

  it("maps wait kinds to the configured delays", () => {
    const opts = { typingMs: 55, erasingMs: 26, holdMs: 1900, gapMs: 420 };
    expect(twDelay("type", opts)).toBe(55);
    expect(twDelay("erase", opts)).toBe(26);
    expect(twDelay("holdTyped", opts)).toBe(1900);
    expect(twDelay("holdEmpty", opts)).toBe(420);
  });
});
