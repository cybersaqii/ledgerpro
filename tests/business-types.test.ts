import { describe, it, expect } from "vitest";
import {
  BUSINESS_TYPES,
  BUSINESS_PROFILES,
  getBusinessProfile,
  businessTypeLabel,
  type BusinessType,
} from "@/lib/business-types";

describe("business type adaptation profiles", () => {
  it("has a profile for every registered business type", () => {
    for (const b of BUSINESS_TYPES) {
      const p = BUSINESS_PROFILES[b.value as BusinessType];
      expect(p, b.value).toBeDefined();
      expect(p.type).toBe(b.value);
    }
  });

  it("every profile has non-empty vocabulary", () => {
    for (const p of Object.values(BUSINESS_PROFILES)) {
      for (const k of ["partyOne", "partyMany", "productOne", "productMany", "salesNav", "newSale", "saveSale", "receivables", "stock"] as const) {
        expect(p[k].trim().length, `${p.type}.${k}`).toBeGreaterThan(0);
      }
    }
  });

  it("clinic speaks patients and treatments", () => {
    const p = getBusinessProfile("CLINIC");
    expect(p.partyOne).toBe("Patient");
    expect(p.partyMany).toBe("Patients");
    expect(p.productOne).toBe("Treatment");
    expect(p.newSale).toBe("New treatment bill");
    expect(p.receivables).toBe("Patient dues");
  });

  it("pharmacy speaks medicines", () => {
    const p = getBusinessProfile("PHARMACY");
    expect(p.productOne).toBe("Medicine");
    expect(p.productMany).toBe("Medicines");
    expect(p.stock).toBe("Medicine stock");
  });

  it("restaurant speaks guests and menu items", () => {
    const p = getBusinessProfile("RESTAURANT");
    expect(p.partyOne).toBe("Guest");
    expect(p.productOne).toBe("Menu item");
  });

  it("services speak clients and invoices", () => {
    const p = getBusinessProfile("SERVICES");
    expect(p.partyOne).toBe("Client");
    expect(p.productOne).toBe("Service");
    expect(p.newSale).toBe("New invoice");
    expect(p.saveSale).toBe("Save invoice");
  });

  it("retail uses counter billing", () => {
    const p = getBusinessProfile("RETAIL");
    expect(p.salesNav).toBe("Billing");
    expect(p.newSale).toBe("New counter bill");
  });

  it("falls back to the generic profile for unknown values", () => {
    expect(getBusinessProfile(null).type).toBe("OTHER");
    expect(getBusinessProfile(undefined).type).toBe("OTHER");
    expect(getBusinessProfile("NONSENSE").type).toBe("OTHER");
  });

  it("businessTypeLabel still resolves every type", () => {
    for (const b of BUSINESS_TYPES) {
      expect(businessTypeLabel(b.value)).toBe(b.label);
    }
  });
});
