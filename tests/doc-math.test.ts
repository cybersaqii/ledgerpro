/**
 * The item-entry form shows live totals before posting. These must equal what
 * the server computes in computeTotals (lib/totals.ts) — otherwise the user
 * sees one number and the ledger posts another. This suite cross-checks the
 * client math (lib/doc-math.ts) against the real server implementation.
 */
import { describe, it, expect } from "vitest";
import { computeTotals } from "@/lib/totals";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { lineMath, docMath, taxBpsOf, taxOf, paisaOf, milliOf } from "@/lib/doc-math";

type Case = { qty: string; rate: string; discount: string; taxPct: string; docDisc: string };

const CASES: Case[] = [
  { qty: "2", rate: "1000", discount: "50", taxPct: "17", docDisc: "100" },
  { qty: "1.5", rate: "10.01", discount: "", taxPct: "", docDisc: "" },
  { qty: "3", rate: "99.99", discount: "0.01", taxPct: "17.5", docDisc: "0" },
  { qty: "7", rate: "0.03", discount: "", taxPct: "100", docDisc: "" },
  { qty: "1.234", rate: "456.78", discount: "10.5", taxPct: "5.25", docDisc: "25.75" },
  { qty: "100", rate: "0.01", discount: "", taxPct: "16", docDisc: "" },
];

function serverTotals(c: Case) {
  return computeTotals(
    [{
      productId: null,
      description: "t",
      qtyMilli: parseQty(c.qty),
      ratePaisa: parseMoney(c.rate || "0"),
      discountPaisa: parseMoney(c.discount || "0"),
      taxBps: taxBpsOf(c.taxPct) ?? 0,
    }],
    parseMoney(c.docDisc || "0")
  );
}

describe("client doc math matches server computeTotals", () => {
  for (const c of CASES) {
    it(`qty=${c.qty} rate=${c.rate} disc=${c.discount || "0"} tax=${c.taxPct || "0"}% docDisc=${c.docDisc || "0"}`, () => {
      const srv = serverTotals(c);
      const lm = lineMath(c.qty, c.rate, c.discount, c.taxPct);
      const dm = docMath([lm], c.docDisc);
      expect(lm.gross).toBe(srv.items[0].grossPaisa);
      expect(lm.disc).toBe(srv.items[0].discountPaisa);
      expect(lm.taxable).toBe(srv.items[0].taxablePaisa);
      expect(lm.tax).toBe(srv.items[0].taxAmountPaisa);
      expect(lm.total).toBe(srv.items[0].lineTotalPaisa);
      expect(dm.subtotal).toBe(srv.subtotal);
      expect(dm.itemDisc).toBe(srv.itemDiscount);
      expect(dm.taxTotal).toBe(srv.taxTotal);
      expect(dm.grand).toBe(srv.grandTotal);
    });
  }

  it("multi-line documents sum exactly like the server", () => {
    const lines = CASES.slice(0, 3).map((c) => lineMath(c.qty, c.rate, c.discount, c.taxPct));
    const dm = docMath(lines, "50");
    const srv = computeTotals(
      CASES.slice(0, 3).map((c) => ({
        productId: null,
        description: "t",
        qtyMilli: parseQty(c.qty),
        ratePaisa: parseMoney(c.rate || "0"),
        discountPaisa: parseMoney(c.discount || "0"),
        taxBps: taxBpsOf(c.taxPct) ?? 0,
      })),
      parseMoney("50")
    );
    expect(dm.subtotal).toBe(srv.subtotal);
    expect(dm.itemDisc).toBe(srv.itemDiscount);
    expect(dm.taxTotal).toBe(srv.taxTotal);
    expect(dm.grand).toBe(srv.grandTotal);
  });
});

describe("taxBpsOf", () => {
  it("parses percents to basis points exactly", () => {
    expect(taxBpsOf("")).toBe(0);
    expect(taxBpsOf("17")).toBe(1700);
    expect(taxBpsOf("17.5")).toBe(1750);
    expect(taxBpsOf("17.55")).toBe(1755);
    expect(taxBpsOf("100")).toBe(10000);
  });
  it("rejects out-of-range or malformed input (submit blocks these)", () => {
    expect(taxBpsOf("100.01")).toBeNull();
    expect(taxBpsOf("-1")).toBeNull();
    expect(taxBpsOf("abc")).toBeNull();
    expect(taxBpsOf("17.555")).toBeNull(); // more than 2dp cannot map to integer bps
  });
});

describe("taxOf", () => {
  it("rounds half-up like the server percentOf", () => {
    expect(taxOf(10000n, 1750)).toBe(1750n); // 17.5% of Rs 100
    expect(taxOf(1n, 5000)).toBe(1n); // half a paisa rounds up
    expect(taxOf(1n, 4999)).toBe(0n);
    expect(taxOf(0n, 1700)).toBe(0n);
  });
});

describe("display clamps (client-only; the server rejects these outright)", () => {
  it("clamps line discount to gross instead of going negative", () => {
    const c = lineMath("1", "100", "500", "");
    expect(c.disc).toBe(10000n);
    expect(c.taxable).toBe(0n);
    expect(c.total).toBe(0n);
  });
  it("clamps negative inputs to zero", () => {
    expect(paisaOf("-5")).toBe(-500n); // raw parse keeps sign…
    const c = lineMath("-2", "-10", "-5", "");
    expect(c.gross).toBe(0n); // …but line math clamps for display
    expect(c.total).toBe(0n);
  });
  it("never shows a negative grand total", () => {
    const dm = docMath([lineMath("1", "100", "", "")], "99999");
    expect(dm.grand).toBe(0n);
  });
  it("treats malformed input as zero for display", () => {
    expect(paisaOf("abc")).toBe(0n);
    expect(milliOf("")).toBe(0n);
    const c = lineMath("abc", "", "", "");
    expect(c.total).toBe(0n);
  });
});
