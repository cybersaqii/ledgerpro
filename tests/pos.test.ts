import { describe, expect, it } from "vitest";
import {
  addToCart,
  cartTotals,
  lineTotalPaisa,
  paisaToRupees,
  toDocItems,
  validateCart,
  type PosLine,
  type PosProduct,
} from "@/lib/pos";

const prod: PosProduct = { id: "p1", name: "Tea 500g", sku: "TEA500", unit: "PCS", salePrice: "25000" };

function line(over: Partial<PosLine> = {}): PosLine {
  return { key: 1, productId: "p1", name: "Tea", sku: "T", unit: "PCS", qty: "2", rate: "250.00", discount: "0", ...over };
}

describe("paisaToRupees", () => {
  it("converts paisa to rupee string", () => {
    expect(paisaToRupees("25000")).toBe("250.00");
    expect(paisaToRupees(199)).toBe("1.99");
    expect(paisaToRupees(0)).toBe("0.00");
  });
});

describe("addToCart", () => {
  it("adds a new line with the product sale price", () => {
    const { lines, touchedKey } = addToCart([], prod, 1);
    expect(lines).toHaveLength(1);
    expect(lines[0].rate).toBe("250.00");
    expect(lines[0].qty).toBe("1");
    expect(touchedKey).toBe(1);
  });

  it("bumps qty instead of duplicating the line", () => {
    const first = addToCart([], prod, 1);
    const second = addToCart(first.lines, prod, 2);
    expect(second.lines).toHaveLength(1);
    expect(second.lines[0].qty).toBe("2");
    expect(second.touchedKey).toBe(1);
  });

  it("adds a separate line for a different product", () => {
    const first = addToCart([], prod, 1);
    const other: PosProduct = { ...prod, id: "p2", name: "Sugar" };
    const second = addToCart(first.lines, other, 2);
    expect(second.lines).toHaveLength(2);
  });
});

describe("lineTotalPaisa", () => {
  it("multiplies qty by rate", () => {
    expect(lineTotalPaisa(line())).toBe(50000);
  });
  it("handles fractional qty", () => {
    expect(lineTotalPaisa(line({ qty: "0.5" }))).toBe(12500);
  });
  it("subtracts line discount and floors at zero", () => {
    expect(lineTotalPaisa(line({ discount: "50.00" }))).toBe(45000);
    expect(lineTotalPaisa(line({ discount: "99999" }))).toBe(0);
  });
});

describe("cartTotals", () => {
  it("sums lines and applies bill discount", () => {
    const t = cartTotals([line(), line({ key: 2, qty: "1", rate: "100.00" })], "50.00");
    expect(t.subtotal).toBe(60000);
    expect(t.discount).toBe(5000);
    expect(t.grand).toBe(55000);
    expect(t.itemCount).toBe(2);
  });
  it("caps discount at subtotal", () => {
    const t = cartTotals([line({ qty: "1", rate: "100.00" })], "9999");
    expect(t.discount).toBe(10000);
    expect(t.grand).toBe(0);
  });
});

describe("toDocItems", () => {
  it("maps cart lines to the sales API shape", () => {
    const items = toDocItems([line()]);
    expect(items[0]).toMatchObject({
      productId: "p1",
      description: "Tea",
      qty: "2",
      rate: "250.00",
      discount: "0",
    });
  });
});

describe("validateCart", () => {
  it("rejects empty carts and bad qtys", () => {
    expect(validateCart([])).toBe("Add at least one item.");
    expect(validateCart([line({ qty: "0" })])).toBe("Quantities must be positive.");
    expect(validateCart([line()])).toBeNull();
  });
});
