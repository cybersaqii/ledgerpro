import { describe, expect, it } from "vitest";
import { effectiveLines, isBlankLine, upsertProductLine, type DocLineLike } from "@/lib/doc-lines";

function line(over: Partial<DocLineLike> = {}): DocLineLike {
  return { key: 1, productId: "", description: "", rate: "", ...over };
}

describe("isBlankLine", () => {
  it("a fresh row is blank", () => {
    expect(isBlankLine(line())).toBe(true);
  });
  it("a picked product is not blank", () => {
    expect(isBlankLine(line({ productId: "p1", description: "Cable", rate: "100" }))).toBe(false);
  });
  it("a typed description alone makes it a real row", () => {
    expect(isBlankLine(line({ description: "Custom work" }))).toBe(false);
  });
  it("a typed rate alone makes it a real row", () => {
    expect(isBlankLine(line({ rate: "50" }))).toBe(false);
  });
  it("whitespace-only description is still blank", () => {
    expect(isBlankLine(line({ description: "   " }))).toBe(true);
  });
});

describe("upsertProductLine", () => {
  const picked = line({ key: 9, productId: "p1", description: "Cable", rate: "100" });

  it("fills the waiting blank row instead of appending (wave-4 regression)", () => {
    const out = upsertProductLine([line({ key: 0 })], picked);
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe(0);
    expect(out[0].productId).toBe("p1");
    expect(out[0].description).toBe("Cable");
  });
  it("fills the FIRST blank row when several are waiting", () => {
    const out = upsertProductLine([line({ key: 0 }), line({ key: 2 })], picked);
    expect(out).toHaveLength(2);
    expect(out[0].productId).toBe("p1");
    expect(out[1].productId).toBe("");
  });
  it("appends when no blank row is waiting", () => {
    const existing = line({ key: 0, productId: "p0", description: "Wire", rate: "10" });
    const out = upsertProductLine([existing], picked);
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual(picked);
  });
});

describe("effectiveLines", () => {
  it("drops untouched blank rows, keeps the rest", () => {
    const rows = [line({ key: 0 }), line({ key: 1, productId: "p1", description: "Cable", rate: "100" })];
    const out = effectiveLines(rows);
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe(1);
  });
  it("an all-blank grid has no effective lines", () => {
    expect(effectiveLines([line({ key: 0 })])).toHaveLength(0);
  });
});
